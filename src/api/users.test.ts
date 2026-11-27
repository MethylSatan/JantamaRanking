// 申請・利用者・Host の付け外し（タスク 023）と、Host が付いていないランキングに触れないこと（完了条件）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_ALERT_COUNT } from './routes.ts';
import { setup, UUID_USERS } from './testkit.ts';

const ALICE = UUID_USERS.alice!.sub;
const BOB = UUID_USERS.bob!.sub;
const BOSS = UUID_USERS.boss!.sub;

/** alice が申請し、管理人が承認する */
const approved = async (t: ReturnType<typeof setup>, token = 'alice') => {
  assert.equal((await t.call('PUT', '/api/me/profile', { token, body: { name: 'アリス', note: 'A リーグ' } })).status, 200);
  assert.equal((await t.call('POST', `/api/users/${UUID_USERS[token]!.sub}/approve`, { token: 'admin' })).status, 200);
};

test('申請すると承認待ちになり、管理人の一覧に出る', async () => {
  const t = setup();
  assert.equal((await t.call('GET', '/api/me', { token: 'alice' })).body.profile, undefined);
  const res = await t.call('PUT', '/api/me/profile', { token: 'alice', body: { name: ' アリス ', note: 'A リーグ\n連絡は X で' } });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ...res.body.profile, appliedAt: undefined },
    { name: 'アリス', note: 'A リーグ\n連絡は X で', status: 'pending', appliedAt: undefined },
  );
  assert.equal((await t.call('GET', '/api/me', { token: 'alice' })).body.profile.status, 'pending');
  // 承認待ちの人は、ランキングの作成も一覧もできない
  assert.equal((await t.call('POST', '/api/rankings', { token: 'alice', body: { name: 'x' } })).status, 403);
  assert.deepEqual((await t.call('GET', '/api/rankings', { token: 'alice' })).body.rankings, []);

  const users = (await t.call('GET', '/api/users', { token: 'admin' })).body.users;
  const alice = users.find((u: any) => u.sub === ALICE);
  assert.equal(alice.status, 'pending');
  assert.equal(alice.name, 'アリス');
  assert.match(alice.discordId, /^\d+$/);
  // 申請していない人（ログインだけ）も出る
  const bob = users.find((u: any) => u.sub === BOB);
  assert.equal(bob.status, undefined);
  assert.equal(users.find((u: any) => u.sub === BOSS).admin, true);
  // 申請した人が先
  assert.equal(users[0].sub, ALICE);
});

test('申請の入力の誤りは 400', async () => {
  const t = setup();
  for (const body of [{}, { name: '' }, { name: 'a', note: 1 }, { name: 'a', note: 'x'.repeat(501) }, { name: 'a', note: 'a\u0007b' }]) {
    assert.equal((await t.call('PUT', '/api/me/profile', { token: 'alice', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await t.call('PUT', '/api/me/profile', { token: 'alice', body: { name: 'a' } })).status, 200);
});

test('Cognito から消えた利用者（トークンだけ残っている）は申請できない', async () => {
  const t = setup();
  t.directory.users.delete(ALICE);
  assert.equal((await t.call('PUT', '/api/me/profile', { token: 'alice', body: { name: 'a' } })).status, 401);
  assert.equal(t.store.items.size, 0);
});

test('承認・却下・利用者の一覧は管理人だけ', async () => {
  const t = setup();
  const id = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  await t.store.addHost(id, 'sub-host');
  await t.call('PUT', '/api/me/profile', { token: 'bob', body: { name: 'ボブ' } });
  for (const token of ['host', 'alice', 'bob']) {
    assert.equal((await t.call('GET', '/api/users', { token })).status, 403);
    assert.equal((await t.call('POST', `/api/users/${BOB}/approve`, { token })).status, 403);
    assert.equal((await t.call('DELETE', `/api/users/${BOB}`, { token })).status, 403);
  }
  assert.equal((await t.call('GET', '/api/me', { token: 'bob' })).body.profile.status, 'pending');
  // 申請していない人は承認できない
  assert.equal((await t.call('POST', `/api/users/${ALICE}/approve`, { token: 'admin' })).status, 404);
  // 管理人は消せない
  assert.equal((await t.call('DELETE', `/api/users/${BOSS}`, { token: 'admin' })).status, 400);
});

test('Host の付け外しは管理人だけで、承認済みの人だけ付けられる', async () => {
  const t = setup();
  const id = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  await t.call('PUT', '/api/me/profile', { token: 'bob', body: { name: 'ボブ' } });
  // 承認待ち・申請なしは付けられない
  assert.equal((await t.call('PUT', `/api/rankings/${id}/hosts/${BOB}`, { token: 'admin' })).status, 400);
  assert.equal((await t.call('PUT', `/api/rankings/${id}/hosts/${ALICE}`, { token: 'admin' })).status, 400);

  await approved(t);
  const added = await t.call('PUT', `/api/rankings/${id}/hosts/${ALICE}`, { token: 'admin' });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.hosts.map((h: any) => [h.sub, h.name]), [[ALICE, 'アリス']]);
  assert.equal((await t.call('PUT', `/api/rankings/${id}/hosts/${ALICE}`, { token: 'admin' })).status, 200);

  // Host は自分のランキングを操作できるが、Host の付け外しはできない
  assert.equal((await t.call('GET', `/api/rankings/${id}`, { token: 'alice' })).body.via, 'host');
  assert.equal((await t.call('GET', `/api/rankings/${id}/hosts`, { token: 'alice' })).status, 403);
  assert.equal((await t.call('PUT', `/api/rankings/${id}/hosts/${ALICE}`, { token: 'alice' })).status, 403);
  assert.equal((await t.call('DELETE', `/api/rankings/${id}/hosts/${ALICE}`, { token: 'alice' })).status, 403);

  const logs = (await t.call('GET', `/api/rankings/${id}/logs`, { token: 'admin' })).body.logs;
  assert.deepEqual([logs[0].op, logs[0].target, logs[0].via], ['addHost', ALICE, 'admin']);
  // 操作ログに Discord の ID・名前は書かない
  assert.doesNotMatch(JSON.stringify(logs), /アリス/);

  const removed = await t.call('DELETE', `/api/rankings/${id}/hosts/${ALICE}`, { token: 'admin' });
  assert.deepEqual(removed.body.hosts, []);
  assert.equal((await t.call('GET', `/api/rankings/${id}`, { token: 'alice' })).status, 404);
  assert.deepEqual((await t.call('GET', '/api/rankings', { token: 'alice' })).body.rankings, []);
  assert.equal((await t.call('GET', `/api/rankings/${id}/logs`, { token: 'admin' })).body.logs[0].op, 'removeHost');
});

test('Host は付いていないランキングのどの経路にも 404（存在も知らせない）', async () => {
  const t = setup();
  const mine = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  const other = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'B' } })).body.id;
  await t.call('PUT', `/api/rankings/${other}/accounts/222`, { token: 'admin' });
  await approved(t);
  await t.call('PUT', `/api/rankings/${mine}/hosts/${ALICE}`, { token: 'admin' });

  const pending = '00000000-0000-4000-8000-00000000ffff';
  const requests: [string, string, unknown?][] = [
    ['GET', ''],
    ['PATCH', '', { name: 'x' }],
    ['DELETE', ''],
    ['POST', '/accounts', { displayId: '123' }],
    ['PUT', '/accounts/111'],
    ['DELETE', '/accounts/222'],
    ['DELETE', `/accounts/pending/${pending}`],
    ['GET', '/players'],
    ['GET', '/logs'],
    ['GET', '/games'],
    ['POST', '/refresh'],
    ['POST', '/import', { uuids: ['x'] }],
    ['POST', '/rebuild'],
    ['POST', '/games/x/exclude'],
    ['POST', '/games/x/restore'],
    ['POST', '/public-id'],
    ['GET', '/hosts'],
    ['PUT', `/hosts/${ALICE}`],
    ['DELETE', `/hosts/${ALICE}`],
  ];
  const before = JSON.stringify([...t.store.items.entries()].filter(([k]) => k.includes(other)));
  for (const [method, path, body] of requests) {
    const res = await t.call(method, `/api/rankings/${other}${path}`, { token: 'alice', ...(body ? { body } : {}) });
    assert.deepEqual([res.status, res.body.error], [404, 'not found'], `${method} ${path}`);
    // 自分のランキングでは、ランキングが見えないの 404 にはならない（403 は表で許されない操作、
    // 「game not found」は無い対局を指したとき）
    const ok = await t.call(method, `/api/rankings/${mine}${path}`, { token: 'alice', ...(body ? { body } : {}) });
    assert.notDeepEqual([ok.status, ok.body.error], [404, 'not found'], `mine ${method} ${path}`);
  }
  // 付いていないランキングの項目は何も変わっていない
  assert.equal(JSON.stringify([...t.store.items.entries()].filter(([k]) => k.includes(other))), before);
  assert.deepEqual((await t.call('GET', '/api/rankings', { token: 'alice' })).body.rankings.map((r: any) => r.id), [mine]);
});

test('利用者を消すと、Host の項目・利用者の情報・Cognito の利用者が消え、操作ログには sub だけ残る', async () => {
  const t = setup();
  const a = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  const b = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'B' } })).body.id;
  await approved(t);
  await t.call('PUT', `/api/rankings/${a}/hosts/${ALICE}`, { token: 'admin' });
  await t.call('PUT', `/api/rankings/${b}/hosts/${ALICE}`, { token: 'admin' });

  assert.equal((await t.call('DELETE', `/api/users/${ALICE}`, { token: 'admin' })).status, 200);
  assert.deepEqual([...t.store.items.keys()].filter((k) => k.includes(ALICE) && !k.includes('LOG#')), []);
  assert.equal(t.directory.users.has(ALICE), false);
  for (const id of [a, b]) {
    const log = (await t.call('GET', `/api/rankings/${id}/logs`, { token: 'admin' })).body.logs[0];
    assert.deepEqual([log.op, log.target], ['removeHost', ALICE]);
  }
  // トークンが残っていても、何も見えず、申請し直せない
  assert.deepEqual((await t.call('GET', '/api/rankings', { token: 'alice' })).body.rankings, []);
  assert.equal((await t.call('PUT', '/api/me/profile', { token: 'alice', body: { name: 'a' } })).status, 401);
});

test('本人は申請を取り下げて消せる。管理人は自分を消せない', async () => {
  const t = setup();
  await t.call('PUT', '/api/me/profile', { token: 'bob', body: { name: 'ボブ' } });
  assert.equal((await t.call('DELETE', '/api/me', { token: 'bob' })).status, 200);
  assert.equal(t.directory.users.has(BOB), false);
  assert.equal((await t.call('GET', '/api/me', { token: 'bob' })).body.profile, undefined);
  assert.equal((await t.call('DELETE', '/api/me', { token: 'admin' })).status, 400);
});

test('管理人が申請を書くと承認済みになる', async () => {
  const t = setup();
  const res = await t.call('PUT', '/api/me/profile', { token: 'admin', body: { name: '管理人' } });
  assert.equal(res.body.profile.status, 'approved');
});

test(`雀魂アカウントが ${ACCOUNT_ALERT_COUNT} 件以上になると [通知] を出し、管理人の一覧に数が出る`, async (ctx) => {
  const t = setup();
  const id = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  const logs: string[] = [];
  ctx.mock.method(console, 'log', (msg: string) => logs.push(String(msg)));
  for (let i = 1; i < ACCOUNT_ALERT_COUNT; i++) await t.call('PUT', `/api/rankings/${id}/accounts/${1000 + i}`, { token: 'admin' });
  assert.equal(logs.filter((l) => l.startsWith('[通知]')).length, 0);
  await t.call('POST', `/api/rankings/${id}/accounts`, { token: 'admin', body: { displayId: '5555' } });
  assert.equal(logs.filter((l) => l.startsWith('[通知]')).length, 1);
  assert.equal((await t.call('GET', '/api/rankings', { token: 'admin' })).body.rankings[0].accountCount, ACCOUNT_ALERT_COUNT);
});
