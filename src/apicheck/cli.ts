// 本番の API を手元から確かめる道具（開発者向け。docs/deploy.md「確認」）。
//   node src/apicheck/cli.ts login            Playwright でブラウザを開き、Discord でログインしてトークンを保存する
//   node src/apicheck/cli.ts smoke            Admin の一連の操作と 401 を確かめる（テスト用のランキングを作り、最後に削除＝非公開にする）
//   node src/apicheck/cli.ts call GET /api/me [JSON の本文]
// Discord のログインの入力は手で行う（自動化しない）。保存先は local/apicheck/（gitignore 済み）。
// 保存するのはリフレッシュトークン（Cognito の既定で30日）。切れたら login をやり直す。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const SITE = 'https://jantama-ranking.methylsatan.com';
const AUTH_ORIGIN = 'https://jantama-ranking-auth.methylsatan.com';
// web/public/admin.html と同じアプリクライアント（公開の値）
const CLIENT_ID = '5f11ktadqh8u5sfeej8r3j5k2v';
const DIR = 'local/apicheck';
const TOKENS = `${DIR}/tokens.json`;

async function login() {
  const { chromium } = await import('playwright');
  await mkdir(DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(`${DIR}/profile`, { headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${SITE}/admin.html`);
  await page.click('#login');
  console.log('ブラウザで Discord にログインしてください（5分待ちます）');
  const deadline = Date.now() + 5 * 60_000;
  let tokens: { refresh_token?: string } | null = null;
  while (Date.now() < deadline) {
    try {
      const raw = await page.evaluate(() =>
        location.origin + location.pathname === 'https://jantama-ranking.methylsatan.com/admin.html'
          ? sessionStorage.getItem('tokens')
          : null,
      );
      if (raw) {
        tokens = JSON.parse(raw);
        break;
      }
    } catch {
      // 画面の移動中
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await ctx.close();
  if (!tokens?.refresh_token) throw new Error('ログインが終わりませんでした');
  await writeFile(TOKENS, JSON.stringify({ refresh_token: tokens.refresh_token, savedAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  console.log(`保存しました: ${TOKENS}`);
}

async function accessToken(): Promise<string> {
  let saved: { refresh_token: string };
  try {
    saved = JSON.parse(await readFile(TOKENS, 'utf8'));
  } catch {
    throw new Error('トークンがありません。先に login を実行してください');
  }
  const res = await fetch(`${AUTH_ORIGIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: saved.refresh_token }),
  });
  if (!res.ok) throw new Error(`トークンを取り直せません（${res.status}）。login をやり直してください: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** API を呼ぶ。POST・PUT などは本文の SHA-256 を x-amz-content-sha256 に付ける（OAC の署名のため。docs/deploy.md） */
async function api(token: string | undefined, method: string, path: string, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (token) headers['x-auth-token'] = token;
  if (method !== 'GET' && method !== 'HEAD') headers['x-amz-content-sha256'] = createHash('sha256').update(text).digest('hex');
  if (text) headers['content-type'] = 'application/json';
  const res = await fetch(`${SITE}${path}`, { method, headers, ...(text ? { body: text } : {}) });
  const resText = await res.text();
  let json: any;
  try {
    json = JSON.parse(resText);
  } catch {
    json = resText;
  }
  return { status: res.status, body: json };
}

async function smoke() {
  const token = await accessToken();
  const check = async (label: string, run: () => Promise<void>) => {
    await run();
    console.log(`ok  ${label}`);
  };

  await check('health', async () => assert.equal((await api(undefined, 'GET', '/api/health')).status, 200));
  await check('トークン無しは 401', async () => assert.equal((await api(undefined, 'GET', '/api/me')).status, 401));
  await check('壊れたトークンは 401', async () => assert.equal((await api('a.b.c', 'GET', '/api/me')).status, 401));
  await check('/api/me は Admin', async () => {
    const me = await api(token, 'GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.admin, true);
  });

  const name = `動作確認 ${new Date().toISOString()}`;
  const created = await api(token, 'POST', '/api/rankings', { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id: string = created.body.id;
  console.log(`ok  作成（${id}）`);
  try {
    await check('名前の変更', async () => {
      const r = await api(token, 'PATCH', `/api/rankings/${id}`, { name: `${name} 改名` });
      assert.equal(r.body.name, `${name} 改名`);
    });
    await check('雀魂アカウントの指定と外す', async () => {
      assert.equal((await api(token, 'PUT', `/api/rankings/${id}/accounts/12345678`)).status, 201);
      const r = await api(token, 'DELETE', `/api/rankings/${id}/accounts/12345678`);
      assert.deepEqual(r.body.accounts, []);
    });
    await check('不正な名前は 400', async () =>
      assert.equal((await api(token, 'PATCH', `/api/rankings/${id}`, { name: '' })).status, 400));
  } finally {
    await check('削除（非公開）', async () =>
      assert.equal((await api(token, 'DELETE', `/api/rankings/${id}`)).body.state, 'deleted'));
  }
  await check('一覧に削除の状態で出る', async () => {
    const r = await api(token, 'GET', '/api/rankings');
    assert.equal(r.body.rankings.find((x: { id: string }) => x.id === id)?.state, 'deleted');
  });
  await check('操作ログ', async () => {
    const ops = (await api(token, 'GET', `/api/rankings/${id}/logs`)).body.logs.map((l: { op: string; via: string }) => `${l.op}:${l.via}`);
    assert.deepEqual(ops, ['deleteRanking:admin', 'removeAccount:admin', 'addAccount:admin', 'rename:admin', 'createRanking:admin']);
  });
  console.log('すべて通りました');
}

async function call(method: string | undefined, path: string | undefined, body: string | undefined) {
  if (!method || !path) throw new Error('使い方: call <METHOD> <path> [JSON の本文]');
  const res = await api(await accessToken(), method.toUpperCase(), path, body === undefined ? undefined : JSON.parse(body));
  console.log(res.status);
  console.log(JSON.stringify(res.body, null, 2));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'login') await login();
  else if (command === 'smoke') await smoke();
  else if (command === 'call') await call(args[0], args[1], args[2]);
  else throw new Error('使い方: node src/apicheck/cli.ts login | smoke | call <METHOD> <path> [JSON]');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
