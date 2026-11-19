import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromRecordGame } from './record.ts';

test('四麻の牌譜（head）から結果を取り出す。0 の項目が省かれていても読む', () => {
  const g = fromRecordGame({
    uuid: '240101-00000000-0000-0000-0000-000000000001',
    end_time: Date.parse('2024-01-02T00:19:41+09:00') / 1000,
    // seat 0 は toObject（defaults: false）で省かれる
    accounts: [{ account_id: 101, nickname: 'うさぎ' }, { seat: 1, account_id: 102, nickname: 'かめ' }, { seat: 2, account_id: 103, nickname: 'きつね' }, { seat: 3, account_id: 104, nickname: 'たぬき' }],
    result: {
      players: [
        { seat: 1, part_point_1: 41000, total_point: 31000 },
        { seat: 2, part_point_1: 30000, total_point: 10000 },
        { part_point_1: 22000, total_point: -8000 },
        { seat: 3, part_point_1: 7000, total_point: -33000 },
      ],
    },
  });
  assert.equal(g.mode, '4p');
  assert.equal(g.endTime, Date.parse('2024-01-02T00:19:41+09:00'));
  assert.deepEqual(
    g.players.map((p) => [p.seat, p.accountId, p.name, p.score, p.pt, p.rank]),
    [
      [0, 101, 'うさぎ', 22000, -8, 3],
      [1, 102, 'かめ', 41000, 31, 1],
      [2, 103, 'きつね', 30000, 10, 2],
      [3, 104, 'たぬき', 7000, -33, 4],
    ],
  );
});

test('三麻。accounts に無い席は AI', () => {
  const g = fromRecordGame({
    uuid: 'u',
    end_time: 1,
    accounts: [{ account_id: 1, nickname: 'A' }, { seat: 1, account_id: 2, nickname: 'B' }],
    result: { players: [{ part_point_1: 50000, total_point: 30000 }, { seat: 1, part_point_1: 35000, total_point: 0 }, { seat: 2, part_point_1: 20000, total_point: -30000 }] },
  });
  assert.equal(g.mode, '3p');
  assert.deepEqual(g.players.map((p) => [p.name, p.accountId, p.rank]), [['A', 1, 1], ['B', 2, 2], ['AI', undefined, 3]]);
  assert.equal('accountId' in g.players[2], false);
});

test('人数や終了時刻がおかしければ例外', () => {
  assert.throws(() => fromRecordGame({ uuid: 'u', end_time: 1, result: { players: [{}, {}] } }), /players/);
  assert.throws(() => fromRecordGame({ uuid: 'u', result: { players: [{}, {}, {}] } }), /end_time/);
});
