// 本番の API を手元から確かめる道具（開発者向け。docs/deploy.md「確認」）。
//   node src/apicheck/cli.ts login            Playwright でブラウザを開き、Discord でログインしてトークンを保存する
//   node src/apicheck/cli.ts smoke            Admin の一連の操作と 401 を確かめる（テスト用のランキングを作り、最後に削除＝非公開にする）
//   node src/apicheck/cli.ts flow <表示用ID> [取り込む件数]
//                                             候補の更新 → 取り込み → ランキングの JSON → 対象外・戻す → 作り直し → 公開 ID の取り直し（タスク 025）。
//                                             雀魂へのログインは候補の更新と取り込みで2回。テスト用のランキングは最後に削除（非公開）にする
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

/** ジョブが終わるまで待つ（3秒おき、最大6分） */
async function waitJob(token: string, jobId: string) {
  const deadline = Date.now() + 6 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const { body } = await api(token, 'GET', `/api/jobs/${jobId}`);
    const job = body.job;
    if (job.progress && job.progress !== last) console.log(`    ${job.progress}`);
    last = job.progress ?? last;
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`ジョブ ${jobId} が終わりません`);
}

/** 公開の URL からランキングの JSON を取る（CloudFront 経由。無ければ status だけ） */
async function publicJson(publicId: string) {
  const res = await fetch(`${SITE}/rankings/${publicId}.json`);
  return { status: res.status, json: res.ok ? ((await res.json()) as { name: string; games: { uuid: string }[] }) : undefined };
}

type PublicJson = Awaited<ReturnType<typeof publicJson>>;

/** CloudFront は no-cache でも最短1秒は覚える（Managed-CachingOptimized の最小 TTL）。条件を満たすまで10秒まで読み直す */
async function eventually(publicId: string, ok: (r: PublicJson) => boolean): Promise<PublicJson> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await publicJson(publicId);
    if (ok(r) || Date.now() > deadline) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

const sameGames = (a: PublicJson, b: PublicJson) => JSON.stringify(a.json?.games) === JSON.stringify(b.json?.games);

async function flow(eid: string | undefined, countArg: string | undefined) {
  if (!eid || !/^\d+$/.test(eid)) throw new Error('使い方: flow <表示用ID> [取り込む件数]');
  const count = Number(countArg ?? '1');
  const token = await accessToken();
  const created = await api(token, 'POST', '/api/rankings', { name: `動作確認 025 ${new Date().toISOString()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id: string = created.body.id;
  const base = `/api/rankings/${id}`;
  console.log(`ok  作成（${id}）`);
  try {
    assert.equal((await api(token, 'PUT', `${base}/accounts/${eid}`)).status, 201);

    console.log('..  候補の更新');
    const refresh = await api(token, 'POST', `${base}/refresh`);
    assert.equal(refresh.status, 202, JSON.stringify(refresh.body));
    const refreshed = await waitJob(token, refresh.body.job.id);
    assert.equal(refreshed.status, 'done', refreshed.error);
    for (const a of refreshed.result.accounts) {
      console.log(`ok  候補の更新: 四麻${a.returned?.['4p']}件・三麻${a.returned?.['3p']}件 ${a.warnings?.join(' / ') ?? ''}${a.error ?? ''}`);
    }
    if (refreshed.result.notices) console.log(`    通知: ${refreshed.result.notices.join(' / ')}`);

    const games = (await api(token, 'GET', `${base}/games`)).body.games as { uuid: string }[];
    assert.ok(games.length >= count, `候補が${games.length}件しかない`);
    const picked = games.slice(0, count).map((g) => g.uuid);

    console.log(`..  取り込み（${picked.length}件）`);
    const imp = await api(token, 'POST', `${base}/import`, { uuids: picked });
    assert.equal(imp.status, 202, JSON.stringify(imp.body));
    const imported = await waitJob(token, imp.body.job.id);
    assert.equal(imported.status, 'done', imported.error);
    assert.deepEqual([...imported.result.imported].sort(), [...picked].sort(), JSON.stringify(imported.result));
    console.log('ok  取り込み');

    const ranking = (await api(token, 'GET', base)).body;
    const first = await eventually(ranking.publicId, (r) => r.status === 200);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json!.games.map((g) => g.uuid).sort(), [...picked].sort());
    console.log(`ok  ランキングの JSON（${SITE}/rankings/<公開 ID>.json）に${first.json!.games.length}件`);

    const target = picked[0]!;
    assert.equal((await api(token, 'POST', `${base}/games/${target}/exclude`)).body.game.state, 'excluded');
    const excluded = await eventually(ranking.publicId, (r) => !r.json?.games.some((g) => g.uuid === target));
    assert.ok(!excluded.json!.games.some((g) => g.uuid === target), '対象外にした対局が JSON に残っている');
    assert.equal((await api(token, 'POST', `${base}/games/${target}/restore`)).body.game.state, 'imported');
    assert.ok(sameGames(await eventually(ranking.publicId, (r) => sameGames(r, first)), first), '戻したあとの JSON が元と違う');
    console.log('ok  対象外にすると JSON から外れ、戻すと入る');

    const rb = await api(token, 'POST', `${base}/rebuild`);
    const rebuilt = await waitJob(token, rb.body.job.id);
    assert.equal(rebuilt.status, 'done', rebuilt.error);
    assert.deepEqual(rebuilt.result.failed, []);
    assert.ok(sameGames(await eventually(ranking.publicId, (r) => sameGames(r, first)), first), '作り直しで JSON が変わった');
    console.log(`ok  作り直しで同じ JSON（変わった対局 ${rebuilt.result.changed}件）`);

    const regen = await api(token, 'POST', `${base}/public-id`);
    assert.equal(regen.status, 200);
    assert.notEqual(regen.body.publicId, ranking.publicId);
    assert.equal((await eventually(regen.body.publicId, (r) => r.status === 200)).status, 200);
    const old = await eventually(ranking.publicId, (r) => r.status === 403 || r.status === 404);
    assert.ok(old.status === 403 || old.status === 404, `古い JSON が ${old.status}`);
    console.log(`ok  公開 ID の取り直し（古い URL は ${old.status}）`);
  } finally {
    await api(token, 'DELETE', base);
    console.log('ok  削除（非公開）');
  }
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
  else if (command === 'flow') await flow(args[0], args[1]);
  else if (command === 'call') await call(args[0], args[1], args[2]);
  else throw new Error('使い方: node src/apicheck/cli.ts login | smoke | flow <表示用ID> [件数] | call <METHOD> <path> [JSON]');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
