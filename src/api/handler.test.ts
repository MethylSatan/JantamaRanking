import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './handler.ts';
import { event, setup } from './testkit.ts';

test('/api/health は認証なしで応える', async () => {
  const res = await handler(event('GET', '/api/health'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('無いパスは 404、メソッド違いは 405', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/unknown')).status, 404);
  assert.equal((await call('POST', '/api/health')).status, 404);
  assert.equal((await call('PUT', '/api/rankings', { token: 'admin' })).status, 405);
});

test('トークンが無い・正しくない要求は 401', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: 'bogus' })).status, 401);
  assert.equal((await call('POST', '/api/rankings', { body: { name: 'x' } })).status, 401);
});

test('GET /api/me は Admin かどうかと許可の表を返す', async () => {
  const { call } = setup();
  const a = await call('GET', '/api/me', { token: 'admin' });
  assert.equal(a.status, 200);
  assert.equal(a.body.sub, 'sub-admin');
  assert.equal(a.body.admin, true);
  assert.deepEqual(a.body.permissions.createRanking, { scope: 'global', roles: ['admin'] });
  assert.equal((await call('GET', '/api/me', { token: 'stranger' })).body.admin, false);
});

test('Admin の一連の操作と操作ログ', async () => {
  const { call } = setup();
  const created = await call('POST', '/api/rankings', { token: 'admin', body: { name: '  東風戦  ' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.name, '東風戦');
  assert.equal(created.body.state, 'public');
  assert.notEqual(created.body.publicId, id);

  // 本文が base64 で来ても読める
  const renamed = await call('PATCH', `/api/rankings/${id}`, { token: 'admin', body: { name: '半荘戦' }, base64: true });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, '半荘戦');

  assert.equal((await call('PUT', `/api/rankings/${id}/accounts/12345678`, { token: 'admin' })).status, 201);
  // 2回目は何もしない
  const again = await call('PUT', `/api/rankings/${id}/accounts/12345678`, { token: 'admin' });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.accounts.map((a: { internalId: string }) => a.internalId), ['12345678']);
  await call('PUT', `/api/rankings/${id}/accounts/87654321`, { token: 'admin' });
  const removed = await call('DELETE', `/api/rankings/${id}/accounts/12345678`, { token: 'admin' });
  assert.deepEqual(removed.body.accounts.map((a: { internalId: string }) => a.internalId), ['87654321']);

  const list = await call('GET', '/api/rankings', { token: 'admin' });
  assert.deepEqual(list.body.rankings, [{ id, name: '半荘戦', state: 'public' }]);

  const deleted = await call('DELETE', `/api/rankings/${id}`, { token: 'admin' });
  assert.equal(deleted.body.state, 'deleted');
  assert.deepEqual((await call('GET', '/api/rankings', { token: 'admin' })).body.rankings, [{ id, name: '半荘戦', state: 'deleted' }]);

  const logs = (await call('GET', `/api/rankings/${id}/logs`, { token: 'admin' })).body.logs;
  assert.deepEqual(
    logs.map((l: { op: string; target?: string }) => [l.op, l.target]),
    [
      ['deleteRanking', undefined],
      ['removeAccount', '12345678'],
      ['addAccount', '87654321'],
      ['addAccount', '12345678'],
      ['rename', undefined],
      ['createRanking', undefined],
    ],
  );
  for (const l of logs) {
    assert.equal(l.sub, 'sub-admin');
    assert.equal(l.via, 'admin');
  }
  assert.deepEqual(logs[4].detail, { from: '東風戦', to: '半荘戦' });
});

test('Host は付いているランキングだけ見え、作成と削除はできない', async () => {
  const { call, store } = setup();
  const mine = (await call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  const other = (await call('POST', '/api/rankings', { token: 'admin', body: { name: 'B' } })).body.id;
  store.addHost(mine, 'sub-host');

  assert.deepEqual((await call('GET', '/api/rankings', { token: 'host' })).body.rankings, [{ id: mine, name: 'A', state: 'public' }]);
  assert.equal((await call('GET', `/api/rankings/${mine}`, { token: 'host' })).body.via, 'host');
  assert.equal((await call('GET', `/api/rankings/${other}`, { token: 'host' })).status, 404);
  assert.equal((await call('PATCH', `/api/rankings/${other}`, { token: 'host', body: { name: 'x' } })).status, 404);
  assert.equal((await call('POST', '/api/rankings', { token: 'host', body: { name: 'C' } })).status, 403);
  assert.equal((await call('DELETE', `/api/rankings/${mine}`, { token: 'host' })).status, 403);

  assert.equal((await call('PUT', `/api/rankings/${mine}/accounts/111`, { token: 'host' })).status, 201);
  const logs = (await call('GET', `/api/rankings/${mine}/logs`, { token: 'host' })).body.logs;
  assert.deepEqual([logs[0].op, logs[0].sub, logs[0].via], ['addAccount', 'sub-host', 'host']);
});

test('どのランキングにも付いていない利用者は何も見えない', async () => {
  const { call } = setup();
  const id = (await call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  assert.deepEqual((await call('GET', '/api/rankings', { token: 'stranger' })).body.rankings, []);
  assert.equal((await call('GET', `/api/rankings/${id}`, { token: 'stranger' })).status, 404);
  assert.equal((await call('GET', `/api/rankings/${id}/logs`, { token: 'stranger' })).status, 404);
});

test('不正な入力は 400', async () => {
  const { call } = setup();
  const id = (await call('POST', '/api/rankings', { token: 'admin', body: { name: 'A' } })).body.id;
  for (const body of [undefined, 'not json', {}, { name: '' }, { name: '   ' }, { name: 1 }, { name: 'a'.repeat(101) }, { name: 'a\nb' }]) {
    assert.equal((await call('POST', '/api/rankings', { token: 'admin', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', '/api/rankings', { token: 'admin', body: { name: 'あ'.repeat(100) } })).status, 201);
  assert.equal((await call('PUT', `/api/rankings/${id}/accounts/abc`, { token: 'admin' })).status, 400);
  assert.equal((await call('PUT', `/api/rankings/${id}/accounts/%E0%A4%A`, { token: 'admin' })).status, 400);
  assert.equal((await call('PUT', `/api/rankings/${id}/accounts/0123`, { token: 'admin' })).status, 400);
  for (const body of [undefined, {}, { displayId: 123 }, { displayId: 'abc' }, { displayId: '1'.repeat(13) }]) {
    assert.equal((await call('POST', `/api/rankings/${id}/accounts`, { token: 'admin', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('GET', '/api/rankings/not-a-uuid', { token: 'admin' })).status, 404);
});
