import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MajsoulError, type Conn } from './connection.ts';
import { openSession, type CollectorDeps, type StaticSource, type StateKey } from './session.ts';
import type { ClientVersion } from './static.ts';
import { miniLiqi } from './testdata.ts';

const V1: ClientVersion = { clientVersionString: 'WebGL_2022-0.16.1', resource: '0.16.1', package: '4.0.0' };
const V2: ClientVersion = { clientVersionString: 'WebGL_2022-0.16.2', resource: '0.16.2', package: '4.0.0' };

/** 偽の環境。`authErrors` の順に oauth2Auth が失敗する（0 は成功） */
function setup(opts: { stored?: Partial<Record<StateKey, unknown>>; latest?: ClientVersion; latestLiqi?: unknown; authErrors?: number[] }) {
  const store = new Map<StateKey, string>();
  for (const [k, v] of Object.entries(opts.stored ?? {})) store.set(k as StateKey, JSON.stringify(v));
  const calls: string[] = [];
  const notices: string[] = [];
  const authErrors = [...(opts.authErrors ?? [])];
  let staticRequests = 0;
  const sentVersions: string[] = [];
  const statics: StaticSource = {
    bundleInfo: async () => { staticRequests++; return { bundles: [], assets: new Map() }; },
    clientVersion: async () => { staticRequests += 2; return opts.latest ?? V1; },
    liqi: async () => { staticRequests += 2; return { json: (opts.latestLiqi ?? miniLiqi()) as any, messages: 1, enums: 0, methods: 8, skipped: [] }; },
  };
  const deps: CollectorDeps = {
    store: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) },
    credentials: async () => ({ type: 21, code: 'c', uid: 'u' }),
    luaKey: async () => Buffer.from('k'),
    notify: (m) => void notices.push(m),
    statics,
    sleep: async () => {},
    connect: async () => {
      const conn: Conn = {
        async call(method, body) {
          calls.push(method);
          if (method === 'Lobby.oauth2Auth') {
            sentVersions.push(String(body.client_version_string));
            const code = authErrors.shift() ?? 0;
            if (code) throw new MajsoulError(method, code);
            return { access_token: 't' };
          }
          return {};
        },
        startHeartbeat() {},
        close() { calls.push('close'); },
      };
      return conn;
    },
  };
  return { deps, store, calls, notices, sentVersions, staticRequests: () => staticRequests };
}

test('保存済みのバージョンと定義でログインする。静的ファイルは取らない', async () => {
  const t = setup({ stored: { 'client-version': V1, liqi: miniLiqi() } });
  const s = await openSession(t.deps);
  assert.equal(t.staticRequests(), 0);
  assert.deepEqual(t.sentVersions, [V1.clientVersionString]);
  assert.deepEqual(t.calls.filter((c) => c.startsWith('Lobby.')), ['Lobby.oauth2Auth', 'Lobby.oauth2Check', 'Lobby.oauth2Login']);
  await s.call('Lobby.searchAccountByEid', {});
  assert.equal(t.calls.at(-1), 'Lobby.searchAccountByEid');
});

test('何も保存されていなければ、先に作って保存する', async () => {
  const t = setup({ latest: V2 });
  await openSession(t.deps);
  assert.equal(t.staticRequests(), 5);
  assert.deepEqual(JSON.parse(t.store.get('client-version')!), V2);
  assert.ok(t.store.get('liqi'));
  assert.deepEqual(t.sentVersions, [V2.clientVersionString]);
});

test('err=151 なら、バージョンを取り直してログインを1回だけやり直す', async () => {
  const t = setup({ stored: { 'client-version': V1, liqi: miniLiqi() }, latest: V2, authErrors: [151] });
  const s = await openSession(t.deps);
  assert.deepEqual(t.sentVersions, [V1.clientVersionString, V2.clientVersionString]);
  assert.deepEqual(JSON.parse(t.store.get('client-version')!), V2);
  assert.equal(s.refreshed.clientVersion, true);
  assert.equal(t.calls.filter((c) => c === 'close').length, 1); // 失敗した接続は閉じる
});

test('やり直しても err=151 なら、それ以上やり直さずに通知する', async () => {
  const t = setup({ stored: { 'client-version': V1, liqi: miniLiqi() }, latest: V2, authErrors: [151, 151] });
  await assert.rejects(openSession(t.deps), /err=151/);
  assert.equal(t.sentVersions.length, 2);
  assert.equal(t.notices.length, 1);
});

test('err=151 でも、バージョンも定義も変わっていなければ、やり直さない', async () => {
  const t = setup({ stored: { 'client-version': V1, liqi: miniLiqi() }, latest: V1, authErrors: [151] });
  await assert.rejects(openSession(t.deps), /err=151/);
  assert.equal(t.sentVersions.length, 1);
  assert.match(t.notices[0], /変わっていない/);
});

test('作り直した定義で使っている型が変わっていたら、採用せずに通知する（バージョンは採用する）', async () => {
  const changed = miniLiqi();
  changed.nested.lq.nested.RecordGame.fields.end_time.id = 9;
  const t = setup({ stored: { 'client-version': V1, liqi: miniLiqi() }, latest: V2, latestLiqi: changed, authErrors: [151] });
  await openSession(t.deps);
  assert.deepEqual(JSON.parse(t.store.get('liqi')!), miniLiqi());
  assert.match(t.notices[0], /採用せず/);
  assert.deepEqual(t.sentVersions, [V1.clientVersionString, V2.clientVersionString]);
});

test('err=151 以外の失敗は、作り直さずに通知する', async () => {
  const t = setup({ stored: { 'client-version': V1, liqi: miniLiqi() }, authErrors: [1003] });
  await assert.rejects(openSession(t.deps), /err=1003/);
  assert.equal(t.staticRequests(), 0);
  assert.match(t.notices[0], /ログインに失敗/);
});
