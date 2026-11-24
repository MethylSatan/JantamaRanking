import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, authorizeGlobal, PERMISSIONS, type Operation, type User } from './authorize.ts';
import { HttpError } from './errors.ts';
import { MemoryStore } from './memory-store.ts';

const RID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const admin: User = { sub: 'admin', groups: ['admins', 'pool_Discord'] };
const host: User = { sub: 'host', groups: ['pool_Discord'] };
const stranger: User = { sub: 'stranger', groups: ['pool_Discord'] };

const setup = async () => {
  const store = new MemoryStore();
  for (const id of [RID, OTHER]) {
    await store.createRanking({ id, name: id, publicId: `p-${id}`, state: 'public', createdBy: 'admin', createdAt: 't' });
  }
  store.addHost(RID, 'host');
  return store;
};

const status = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
};

// docs/architecture.md「操作ごとの許可」と同じ表。表を変えたら両方を直す
const EXPECTED: Record<Operation, { admin: boolean; host: boolean }> = {
  createRanking: { admin: true, host: false },
  viewRanking: { admin: true, host: true },
  setAccounts: { admin: true, host: true },
  rename: { admin: true, host: true },
  deleteRanking: { admin: true, host: false },
  refresh: { admin: true, host: true },
  import: { admin: true, host: true },
  exclude: { admin: true, host: true },
  rebuild: { admin: true, host: true },
  viewLogs: { admin: true, host: true },
  publicUrl: { admin: true, host: true },
  manageHosts: { admin: true, host: false },
  manageUsers: { admin: true, host: false },
};

test('表の操作は文書と同じ', () => {
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), Object.keys(EXPECTED).sort());
});

for (const [op, expected] of Object.entries(EXPECTED) as [Operation, { admin: boolean; host: boolean }][]) {
  test(`${op}: Admin=${expected.admin} Host=${expected.host}`, async () => {
    const store = await setup();
    const perm = PERMISSIONS[op];
    if (perm.scope === 'global') {
      const run = (u: User) => status(() => authorizeGlobal(u, op as 'createRanking' | 'manageUsers'));
      assert.equal(await run(admin), expected.admin ? 'ok' : 403);
      assert.equal(await run(host), 403);
      assert.equal(await run(stranger), 403);
      return;
    }
    const scoped = op as Exclude<Operation, 'createRanking' | 'manageUsers'>;
    // Admin はすべてのランキング
    assert.equal(await status(authorize(admin, scoped, RID, store)), expected.admin ? 'ok' : 403);
    assert.equal(await status(authorize(admin, scoped, OTHER, store)), expected.admin ? 'ok' : 403);
    // Host は付いているランキングだけ。付いていないランキングは存在も知らせない
    assert.equal(await status(authorize(host, scoped, RID, store)), expected.host ? 'ok' : 403);
    assert.equal(await status(authorize(host, scoped, OTHER, store)), 404);
    // どちらでもない利用者
    assert.equal(await status(authorize(stranger, scoped, RID, store)), 404);
    // 無いランキングは Admin にも 404
    assert.equal(await status(authorize(admin, scoped, 'missing', store)), 404);
  });
}

test('許可したときは役割（via）を返す', async () => {
  const store = await setup();
  assert.equal((await authorize(admin, 'rename', RID, store)).via, 'admin');
  assert.equal((await authorize(host, 'rename', RID, store)).via, 'host');
  assert.equal(authorizeGlobal(admin, 'createRanking').via, 'admin');
});

test('Host の項目が残っていてもランキングが無ければ 404', async () => {
  const store = await setup();
  store.addHost('ghost', 'host');
  assert.equal(await status(authorize(host, 'viewRanking', 'ghost', store)), 404);
});
