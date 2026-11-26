import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHeads, gameLength, listCandidates, trimHead, MAX_RECORDS_PER_RUN } from './collect.ts';
import type { Session } from './session.ts';

function fakeSession(handler: (method: string, body: any) => any) {
  const calls: { method: string; body: any }[] = [];
  const session: Session = {
    async call(method, body) {
      calls.push({ method, body });
      return handler(method, body);
    },
    close() {},
    refreshed: { clientVersion: false, liqi: false },
  };
  return { session, calls };
}

const game = (uuid: string, start: number) => ({
  uuid, start_time: start, end_time: start + 1800, tag: 2, sub_tag: 1,
  // seat 0 は toObject で省かれる（defaults: false）
  results: [{ account_id: 11, nickname: 'A', rank: 2 }, { seat: 1, account_id: 12, nickname: 'B', rank: 1 }],
});

test('四麻・三麻の友人戦を取り、既知の対局を除いて新しい順に並べる', async () => {
  const { session, calls } = fakeSession((m, b) => {
    if (m === 'Lobby.searchAccountByEid') return { account_id: 999 };
    if (b.category === 1) return { recent_games: [game('u1', 100), game('u3', 300), game('known', 200)] };
    return { recent_games: [game('u2', 250)] };
  });
  const r = await listCandidates(session, { eid: 12345 }, (u) => u === 'known');
  assert.deepEqual(calls.map((c) => [c.method, c.body.category, c.body.type]), [
    ['Lobby.searchAccountByEid', undefined, undefined],
    ['Lobby.fetchAccountInfoExtra', 1, 2],
    ['Lobby.fetchAccountInfoExtra', 2, 2],
  ]);
  assert.equal(calls[1].body.account_id, 999);
  assert.deepEqual(r.candidates.map((c) => [c.uuid, c.mode]), [['u3', '4p'], ['u2', '3p'], ['u1', '4p']]);
  assert.deepEqual(r.returned, { '4p': 3, '3p': 1 });
  assert.equal(r.candidates[0].startTime, 300_000);
  assert.deepEqual(r.candidates[0].players.map((p) => [p.seat, p.nickname, p.rank]), [[0, 'A', 2], [1, 'B', 1]]);
  assert.deepEqual(r.warnings, []);
});

test('一覧が上限に近い・達したときに警告する', async () => {
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => game(`${prefix}${i}`, 1000 - i));
  const run = (four: number, three: number, known: (u: string) => boolean) => {
    const { session } = fakeSession((m, b) => (m === 'Lobby.searchAccountByEid' ? { account_id: 1 } : { recent_games: many(b.category === 1 ? four : three, `c${b.category}-`) }));
    return listCandidates(session, { accountId: 1 }, known);
  };
  // 四麻: 50件で、一番古い（c1-49）が未処理 → 取りこぼしのおそれ。三麻: 40件 → 上限が近い
  let r = await run(50, 40, () => false);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /^四麻: .*取りこぼした/);
  assert.match(r.warnings[1], /^三麻: .*近い/);
  // 一番古い対局が処理済みなら、取りこぼしではなく「近い」の警告
  r = await run(50, 39, (u) => u === 'c1-49');
  assert.deepEqual(r.warnings.map((w) => /近い/.test(w)), [true]);
});

test('表示用 ID が見つからなければ例外', async () => {
  const { session } = fakeSession(() => ({}));
  await assert.rejects(listCandidates(session, { eid: 1 }, () => false), /見つからない/);
});

test('内部 ID で指定したら、表示用 ID の検索をしない', async () => {
  const { session, calls } = fakeSession(() => ({ recent_games: [] }));
  const r = await listCandidates(session, { accountId: 777 }, () => false);
  assert.deepEqual(calls.map((c) => [c.method, c.body.account_id]), [['Lobby.fetchAccountInfoExtra', 777], ['Lobby.fetchAccountInfoExtra', 777]]);
  assert.equal(r.accountId, 777);
});

const head = (uuid: string) => ({
  uuid, end_time: 1,
  accounts: [{ account_id: 1, nickname: 'A', avatar_id: 5, character: { charid: 1 }, views: [{ item_id: 2 }], title: 3, avatar_frame: 4, level: { id: 10 } }],
});

test('牌譜はまとめて要求し、返らなかった uuid を報告する。見た目の情報は外す', async () => {
  const { session, calls } = fakeSession((_m, b) => ({ record_list: b.uuid_list.filter((u: string) => u !== 'u4').map(head) }));
  const r = await fetchHeads(session, ['u1', 'u2', 'u3', 'u4', 'u5', 'u1'], { chunkSize: 2 });
  assert.deepEqual(calls.map((c) => c.body.uuid_list), [['u1', 'u2'], ['u3', 'u4'], ['u5']]); // 重複は1回だけ
  assert.deepEqual(r.heads.map((h) => h.uuid), ['u1', 'u2', 'u3', 'u5']);
  assert.deepEqual(r.missing, ['u4']);
  assert.deepEqual(r.heads[0].accounts, [{ account_id: 1, nickname: 'A', level: { id: 10 } }]);
});

test(`1回に取れるのは${MAX_RECORDS_PER_RUN}件まで`, async () => {
  const { session, calls } = fakeSession(() => ({}));
  const uuids = Array.from({ length: MAX_RECORDS_PER_RUN + 1 }, (_, i) => `u${i}`);
  await assert.rejects(fetchHeads(session, uuids), /まで/);
  assert.equal(calls.length, 0);
  await assert.rejects(fetchHeads(session, ['u'], { chunkSize: 0 }), /chunkSize/);
});

test('maxRecords で上限を変えられる', async () => {
  const { session, calls } = fakeSession(() => ({}));
  const uuids = Array.from({ length: MAX_RECORDS_PER_RUN + 1 }, (_, i) => `u${i}`);
  const r = await fetchHeads(session, uuids, { maxRecords: MAX_RECORDS_PER_RUN + 1 });
  assert.equal(r.missing.length, MAX_RECORDS_PER_RUN + 1);
  assert.equal(calls.length, 3);
  await assert.rejects(fetchHeads(session, ['u1', 'u2'], { maxRecords: 1 }), /1件まで/);
});

test('trimHead は元の head を変えない', () => {
  const h = head('u');
  const t = trimHead(h);
  assert.equal(h.accounts[0].avatar_id, 5);
  assert.equal((t.accounts as any[])[0].avatar_id, undefined);
});

test('sub_tag から東風・半荘を出す。意味を確かめていない値は null', () => {
  assert.deepEqual([1, 2, 11, 12, 4, 0].map(gameLength), ['東風', '半荘', '東風', '半荘', null, null]);
});
