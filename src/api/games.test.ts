// タスク 025: 候補の更新・取り込み・対象外・作り直し・公開 ID・ジョブ（API を通して確かめる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_TTL_MS } from './jobs.ts';
import { setup } from './testkit.ts';

const HOST_EID = 1001;
const HOST_ID = 501;

/** ランキングを作り、主催者の雀魂アカウントを指定して、対局を3つ（四麻2・三麻1）用意する */
const prepare = async () => {
  const t = setup();
  t.majsoul.account(HOST_EID, HOST_ID);
  t.majsoul.game('g1', 1_800_000_000, [['主催', HOST_ID, 40000, 30000], ['い', 2, 30000, 10000], ['ろ', 3, 20000, -10000], ['は', 4, 10000, -30000]], [HOST_ID]);
  t.majsoul.game('g2', 1_800_010_000, [['い', 2, 50000, 40000], ['主催', HOST_ID, 30000, 10000], ['ろ', 3, 15000, -15000], ['は', 4, 5000, -35000]], [HOST_ID]);
  t.majsoul.game('g3', 1_800_020_000, [['主催', HOST_ID, 50000, 30000], ['い', 2, 35000, 0], ['ろ', 3, 20000, -30000]], [HOST_ID]);
  const created = await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'テスト' } });
  const id: string = created.body.id;
  await t.call('POST', `/api/rankings/${id}/accounts`, { token: 'admin', body: { displayId: String(HOST_EID) } });
  const base = `/api/rankings/${id}`;
  const job = async (res: { status: number; body: any }) => {
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await t.runStarted();
    return (await t.call('GET', `/api/jobs/${res.body.job.id}`, { token: 'admin' })).body.job;
  };
  const publicJson = async () => {
    const r = (await t.call('GET', base, { token: 'admin' })).body;
    const s = t.blobs.rankings.get(r.publicId);
    return s === undefined ? undefined : JSON.parse(s);
  };
  const candidates = async () =>
    (await t.call('GET', `${base}/games`, { token: 'admin' })).body.games.map((g: { uuid: string }) => g.uuid);
  return { ...t, id, base, job, publicJson, candidates };
};

test('候補の更新 → 候補 → 取り込み → ランキングの JSON', async () => {
  const t = await prepare();
  const refreshed = await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  assert.equal(refreshed.status, 'done', refreshed.error);
  assert.equal(refreshed.result.accounts[0].internalId, String(HOST_ID));
  assert.deepEqual(refreshed.result.accounts[0].returned, { '4p': 2, '3p': 1 });
  assert.equal(t.majsoul.logins, 1);
  // 最初の更新で、表示用 ID から内部 ID を引く
  assert.deepEqual(t.majsoul.calls, ['Lobby.searchAccountByEid', 'Lobby.fetchAccountInfoExtra', 'Lobby.fetchAccountInfoExtra']);

  const list = await t.call('GET', `${t.base}/games`, { token: 'admin' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.games.map((g: any) => [g.uuid, g.mode, g.sources]), [
    ['g3', '3p', [String(HOST_ID)]],
    ['g2', '4p', [String(HOST_ID)]],
    ['g1', '4p', [String(HOST_ID)]],
  ]);
  assert.equal(list.body.accounts[0].internalId, String(HOST_ID));
  assert.equal(list.body.accounts[0].name, '主催');
  assert.ok(list.body.accounts[0].lastRefreshedAt);
  assert.equal(await t.publicJson(), undefined);

  const imported = await t.job(await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['g2', 'g1'] } }));
  assert.equal(imported.status, 'done', imported.error);
  assert.deepEqual(imported.result.imported, ['g2', 'g1']);
  assert.equal(t.majsoul.logins, 2);
  // 牌譜は見た目の情報を外して S3 に置く
  assert.equal(JSON.parse(t.blobs.records.get('g1')!).accounts[0].avatar_id, undefined);

  const json = await t.publicJson();
  assert.equal(json.name, 'テスト');
  assert.deepEqual(json.games.map((g: any) => g.uuid), ['g1', 'g2']);
  assert.deepEqual(json.games[0].players[0], { seat: 0, name: '主催', score: 40000, pt: 30, rank: 1, accountId: HOST_ID });
  assert.deepEqual(await t.candidates(), ['g3']);
  assert.deepEqual(
    (await t.call('GET', `${t.base}/games`, { token: 'admin', query: { state: 'imported' } })).body.games.map((g: any) => g.uuid),
    ['g2', 'g1'],
  );

  const ops = (await t.call('GET', `${t.base}/logs`, { token: 'admin' })).body.logs.map((l: any) => l.op);
  assert.deepEqual(ops.slice(0, 2), ['import', 'refresh']);
});

test('S3 に牌譜がある対局は、雀魂に要求せずに取り込む（別のランキングでも）', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  await t.job(await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['g1'] } }));
  const logins = t.majsoul.logins;

  const other = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: '別' } })).body.id;
  // 内部 ID で指定すれば、内部 ID を引く要求は要らない。候補はアカウントごとに共有なので、更新しなくても出る
  await t.call('PUT', `/api/rankings/${other}/accounts/${HOST_ID}`, { token: 'admin' });
  const before = t.majsoul.logins;
  assert.equal(before, logins);
  // 対局の状態はランキングごと。もう一方で取り込み済みでも、ここでは候補
  const res = await t.job(await t.call('POST', `/api/rankings/${other}/import`, { token: 'admin', body: { uuids: ['g1'] } }));
  assert.deepEqual(res.result.imported, ['g1']);
  assert.equal(t.majsoul.logins, before);
});

test('対象外にすると JSON から外れ、戻すと入る。作り直しで同じ JSON になる', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  await t.job(await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['g1', 'g2'] } }));
  const original = await t.publicJson();

  assert.equal((await t.call('POST', `${t.base}/games/g1/exclude`, { token: 'admin' })).body.game.state, 'excluded');
  assert.deepEqual((await t.publicJson()).games.map((g: any) => g.uuid), ['g2']);
  assert.deepEqual(
    (await t.call('GET', `${t.base}/games`, { token: 'admin', query: { state: 'excluded' } })).body.games.map((g: any) => g.uuid),
    ['g1'],
  );
  assert.equal((await t.call('POST', `${t.base}/games/g1/restore`, { token: 'admin' })).body.game.state, 'imported');
  assert.deepEqual((await t.publicJson()).games, original.games);

  // 候補から直接対象外にした対局は、戻すと候補に戻る
  await t.call('POST', `${t.base}/games/g3/exclude`, { token: 'admin' });
  assert.deepEqual(await t.candidates(), []);
  assert.equal((await t.call('POST', `${t.base}/games/g3/restore`, { token: 'admin' })).body.game.state, 'candidate');
  assert.deepEqual(await t.candidates(), ['g3']);

  const logins = t.majsoul.logins;
  const rebuilt = await t.job(await t.call('POST', `${t.base}/rebuild`, { token: 'admin' }));
  assert.equal(rebuilt.status, 'done', rebuilt.error);
  assert.deepEqual(rebuilt.result, { games: 2, changed: 0, failed: [] });
  assert.deepEqual((await t.publicJson()).games, original.games);
  assert.equal(t.majsoul.logins, logins, '作り直しは雀魂に接続しない');

  // 結果が壊れていても、牌譜から作り直せる
  const state = await t.store.getGameState(t.id, 'g2');
  await t.store.putGameState(t.id, { ...state!, result: { ...state!.result!, players: [] } });
  const again = await t.job(await t.call('POST', `${t.base}/rebuild`, { token: 'admin' }));
  assert.equal(again.result.changed, 1);
  assert.deepEqual((await t.publicJson()).games, original.games);

  const ops = (await t.call('GET', `${t.base}/logs`, { token: 'admin' })).body.logs.map((l: any) => `${l.op}:${l.target ?? ''}`);
  assert.ok(ops.includes('exclude:g1') && ops.includes('restore:g1') && ops.includes('exclude:g3'));
});

test('取り込みは候補だけ・100件まで。対象外は候補か状態のある対局だけ', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  assert.equal((await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['nope'] } })).status, 400);
  assert.equal((await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: [] } })).status, 400);
  assert.equal((await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['a/b'] } })).status, 400);
  const many = Array.from({ length: 101 }, (_, i) => `x${i}`);
  assert.equal((await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: many } })).status, 400);
  assert.equal((await t.call('POST', `${t.base}/games/nope/exclude`, { token: 'admin' })).status, 404);
  assert.equal((await t.call('POST', `${t.base}/games/g1/restore`, { token: 'admin' })).status, 404);
  assert.equal((await t.call('GET', `${t.base}/games`, { token: 'admin', query: { state: 'bad' } })).status, 400);
});

test('手動の候補の更新は、雀魂アカウントごとに数秒あける', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  t.advance(10_000);
  assert.equal((await t.call('POST', `${t.base}/refresh`, { token: 'admin' })).status, 202);
  assert.equal((await t.call('POST', `${t.base}/refresh`, { token: 'admin' })).status, 429);
  t.advance(10_000);
  assert.equal((await t.call('POST', `${t.base}/refresh`, { token: 'admin' })).status, 202);
});

test('初めての候補の更新（表示用 ID で指定した直後）も、続けて送ると間隔の中なら 429', async () => {
  const t = await prepare();
  const first = await t.call('POST', `${t.base}/refresh`, { token: 'admin' });
  assert.equal(first.status, 202);
  assert.equal((await t.call('POST', `${t.base}/refresh`, { token: 'admin' })).status, 429);
  t.advance(10_000);
  assert.equal((await t.call('POST', `${t.base}/refresh`, { token: 'admin' })).status, 202);
});

test('雀魂アカウントが無ければ候補の更新は 400', async () => {
  const t = setup();
  const id = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: 'x' } })).body.id;
  assert.equal((await t.call('POST', `/api/rankings/${id}/refresh`, { token: 'admin' })).status, 400);
});

test('ロックが空かなければ、待ったあと失敗にする。同じジョブは1回だけ動く', async () => {
  const t = await prepare();
  await t.store.acquireLock('other', Date.now() + 1e12, LOCK_TTL_MS);
  const res = await t.call('POST', `${t.base}/refresh`, { token: 'admin' });
  const jobId = res.body.job.id;
  await t.runStarted();
  const failed = (await t.call('GET', `/api/jobs/${jobId}`, { token: 'admin' })).body.job;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ほかの処理/);
  assert.equal(t.majsoul.logins, 0);
  await t.store.releaseLock('other');

  // 2回起動されても、待ちでないジョブは動かさない
  await t.h({ source: 'job', jobId });
  assert.equal((await t.call('GET', `/api/jobs/${jobId}`, { token: 'admin' })).body.job.status, 'failed');
});

test('ログインに失敗したらジョブは失敗し、通知を結果に残す。ロックは外れる', async () => {
  const t = await prepare();
  t.majsoul.failLogin = true;
  const job = await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.result.notices, ['ログインに失敗した']);
  assert.equal(await t.store.acquireLock('next', Date.now(), LOCK_TTL_MS), true);
});

test('表示用 ID が見つからないアカウントは、そのアカウントだけ失敗にする', async () => {
  const t = await prepare();
  await t.call('POST', `${t.base}/accounts`, { token: 'admin', body: { displayId: '9999' } });
  const job = await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  assert.equal(job.status, 'done');
  const ok = job.result.accounts.find((a: any) => !a.error);
  const ng = job.result.accounts.find((a: any) => a.error);
  assert.equal(ok.internalId, String(HOST_ID));
  assert.match(ng.error, /見つからない/);
  // 表示用 ID はジョブの結果に出さない
  assert.ok(!JSON.stringify(job).includes('9999'));
  // 見つからなかった仮の項目は残る（外せる）
  const detail = (await t.call('GET', t.base, { token: 'admin' })).body;
  assert.deepEqual(detail.accounts.map((a: any) => a.pendingId ?? a.internalId).sort(), [String(HOST_ID), ng.pendingId].sort());
  const removed = await t.call('DELETE', `${t.base}/accounts/pending/${ng.pendingId}`, { token: 'admin' });
  assert.deepEqual(removed.body.accounts.map((a: any) => a.internalId), [String(HOST_ID)]);
});

test('定期取得は、登録されたすべての雀魂アカウントの候補を更新する', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  t.majsoul.game('g4', 1_800_030_000, [['主催', HOST_ID, 40000, 30000], ['い', 2, 30000, 10000], ['ろ', 3, 20000, -10000], ['は', 4, 10000, -30000]], [HOST_ID]);
  await t.h({ source: 'scheduler', action: 'refresh-candidates' });
  assert.deepEqual(await t.candidates(), ['g4', 'g3', 'g2', 'g1']);
  // 雀魂アカウントを外すと、定期取得の一覧からも外れる
  await t.call('DELETE', `${t.base}/accounts/${HOST_ID}`, { token: 'admin' });
  assert.deepEqual(await t.store.listMajsouls(), []);
});

test('公開 ID を取り直すと、新しい JSON を置いて古い JSON を消す。削除で JSON も消す', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  await t.job(await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['g1'] } }));
  const old = (await t.call('GET', t.base, { token: 'admin' })).body.publicId;
  const res = await t.call('POST', `${t.base}/public-id`, { token: 'admin' });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.publicId, old);
  assert.equal(t.blobs.rankings.has(old), false);
  assert.ok(t.blobs.rankings.has(res.body.publicId));

  await t.call('PATCH', t.base, { token: 'admin', body: { name: '改名' } });
  assert.equal((await t.publicJson()).name, '改名');

  await t.call('DELETE', t.base, { token: 'admin' });
  assert.equal(t.blobs.rankings.size, 0);
});

test('付いていない利用者には、対局・ジョブを 404 で返す。Host は操作できる', async () => {
  const t = await prepare();
  const refresh = await t.call('POST', `${t.base}/refresh`, { token: 'admin' });
  for (const [method, path] of [
    ['GET', `${t.base}/games`],
    ['POST', `${t.base}/refresh`],
    ['POST', `${t.base}/rebuild`],
    ['POST', `${t.base}/public-id`],
    ['GET', `/api/jobs/${refresh.body.job.id}`],
  ] as const) {
    assert.equal((await t.call(method, path, { token: 'stranger' })).status, 404, `${method} ${path}`);
  }
  await t.runStarted();
  t.store.addHost(t.id, 'sub-host');
  const job = await t.job(await t.call('POST', `${t.base}/import`, { token: 'host', body: { uuids: ['g1'] } }));
  assert.equal(job.status, 'done');
  const log = (await t.call('GET', `${t.base}/logs`, { token: 'host' })).body.logs[0];
  assert.deepEqual([log.op, log.sub, log.via], ['import', 'sub-host', 'host']);
});

test('表示用 ID で指定すると、最初の候補の更新で内部 ID の項目に置き換わり、表示用 ID はどこにも残らない', async () => {
  const t = await prepare();
  const before = (await t.call('GET', t.base, { token: 'admin' })).body;
  assert.equal(before.accounts.length, 1);
  assert.ok(before.accounts[0].pendingId);
  assert.equal(before.accounts[0].internalId, undefined);
  // 同じ表示用 ID をもう一度指定しても、仮の項目は増えない
  const again = await t.call('POST', `${t.base}/accounts`, { token: 'admin', body: { displayId: String(HOST_EID) } });
  assert.equal(again.status, 200);
  assert.equal(again.body.accounts.length, 1);

  const job = await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.accounts[0].name, '主催');

  const after = (await t.call('GET', t.base, { token: 'admin' })).body;
  assert.deepEqual(after.accounts.map((a: any) => [a.internalId, a.pendingId, a.name]), [[String(HOST_ID), undefined, '主催']]);
  const logs = (await t.call('GET', `${t.base}/logs`, { token: 'admin' })).body.logs;
  const everything = JSON.stringify([...(t.store as any).items.values()]) + JSON.stringify(logs) + JSON.stringify(after);
  assert.ok(!everything.includes(String(HOST_EID)), '表示用 ID が残っている');
  // 次の更新では、表示用 ID からは引かない
  t.majsoul.calls.length = 0;
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  assert.ok(!t.majsoul.calls.includes('Lobby.searchAccountByEid'));
});

test('ランキングの対局の参加者から選んで、内部 ID で指定できる（雀魂に要求しない）', async () => {
  const t = await prepare();
  await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
  await t.job(await t.call('POST', `${t.base}/import`, { token: 'admin', body: { uuids: ['g1'] } }));
  const other = (await t.call('POST', '/api/rankings', { token: 'admin', body: { name: '別' } })).body.id;
  // 対局の無いランキングでは参加者は空
  assert.deepEqual((await t.call('GET', `/api/rankings/${other}/players`, { token: 'admin' })).body.players, []);

  const players = (await t.call('GET', `${t.base}/players`, { token: 'admin' })).body.players;
  // 対局の数の多い順。同数は内部 ID の順（g3 は三麻なので、は（4）は2局）
  assert.deepEqual(players, [
    { internalId: '2', name: 'い', games: 3 },
    { internalId: '3', name: 'ろ', games: 3 },
    { internalId: String(HOST_ID), name: '主催', games: 3 },
    { internalId: '4', name: 'は', games: 2 },
  ]);

  const logins = t.majsoul.logins;
  const added = await t.call('PUT', `${t.base}/accounts/2`, { token: 'admin' });
  assert.equal(added.status, 201);
  const { addedAt: _at, ...view } = added.body.accounts.find((a: any) => a.internalId === '2');
  assert.deepEqual(view, { internalId: '2', name: 'い' });
  assert.equal(t.majsoul.logins, logins);
  // 定期取得の一覧にもすぐ入る
  assert.deepEqual((await t.store.listMajsouls()).sort(), ['2', String(HOST_ID)].sort());
  const log = (await t.call('GET', `${t.base}/logs`, { token: 'admin' })).body.logs[0];
  assert.deepEqual([log.op, log.target, log.detail], ['addAccount', '2', { name: 'い' }]);
});

test('取りこぼしの警告: 未処理の対局が残っていても出ず、前回の更新から一覧の上限を超えて増えたときだけ出る', async () => {
  const t = await prepare();
  const four = (uuid: string, sec: number) =>
    t.majsoul.game(uuid, sec, [['主催', HOST_ID, 40000, 30000], ['い', 2, 30000, 10000], ['ろ', 3, 20000, -10000], ['は', 4, 10000, -30000]], [HOST_ID]);
  const warningsOf = async () => {
    const job = await t.job(await t.call('POST', `${t.base}/refresh`, { token: 'admin' }));
    assert.equal(job.status, 'done', job.error);
    return job.result.accounts[0].warnings as string[];
  };
  // 四麻を上限まで（すべて未処理。リーグ以外の友人戦のつもり）。初めての更新は「これより古い対局は取れない」だけ
  for (let i = 0; i < 50; i++) four(`a${i}`, 1_810_000_000 + i * 3600);
  assert.deepEqual((await warningsOf()).map((w) => /取れない/.test(w)), [true]);
  // 上限の範囲で増えただけなら、未処理が残っていても警告しない
  t.advance(10_000);
  for (let i = 0; i < 10; i++) four(`b${i}`, 1_820_000_000 + i * 3600);
  assert.deepEqual(await warningsOf(), []);
  // 前回の更新から50件を超えて増えると、前回の一番新しい対局が一覧から外れる → 取りこぼし
  t.advance(10_000);
  for (let i = 0; i < 51; i++) four(`c${i}`, 1_830_000_000 + i * 3600);
  const w = await warningsOf();
  assert.equal(w.length, 1);
  assert.match(w[0]!, /^四麻: .*取りこぼした/);
});
