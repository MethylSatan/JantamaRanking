import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromMjlog, parseJstTitle } from './mjlog.ts';
import { mjlog3p, mjlog4p } from './testdata.ts';

test('title[1] は日本時間として読む（0埋めなしも読む）', () => {
  assert.equal(parseJstTitle('2024/1/2 0:19:41'), Date.parse('2024-01-02T00:19:41+09:00'));
  assert.equal(parseJstTitle('2022/12/31 23:05:07'), Date.parse('2022-12-31T23:05:07+09:00'));
  assert.throws(() => parseJstTitle('2024-01-02 00:19:41'));
});

test('四麻の牌譜から結果を取り出す。順位は pt の大きい順', () => {
  const g = fromMjlog(mjlog4p());
  assert.equal(g.mode, '4p');
  assert.equal(g.uuid, '240101-00000000-0000-0000-0000-000000000001');
  assert.equal(g.endTime, Date.parse('2024-01-02T00:19:41+09:00'));
  assert.deepEqual(
    g.players.map((p) => [p.seat, p.name, p.score, p.pt, p.rank]),
    [
      [0, 'うさぎ', 22000, -8, 3],
      [1, 'かめ', 41000, 31, 1],
      [2, 'きつね', 30000, 10, 2],
      [3, 'たぬき', 7000, -33, 4],
    ],
  );
  assert.equal(g.players[0].accountId, undefined);
});

test('三麻は空席を除く', () => {
  const g = fromMjlog(mjlog3p());
  assert.equal(g.mode, '3p');
  assert.deepEqual(g.players.map((p) => [p.name, p.rank]), [['うさぎ', 1], ['かめ', 3], ['きつね', 2]]);
});

test('前期の形式（log・dan などの余分な項目あり）も読める', () => {
  const g = fromMjlog({ ...mjlog4p(), log: [[]], dan: ['', '', '', ''], rate: [0, 0, 0, 0] } as never);
  assert.equal(g.players.length, 4);
});

test('pt が同じなら席順で上', () => {
  const j = mjlog4p();
  j.sc = [25000, 5, 25000, 5, 30000, 20, 20000, -30];
  const g = fromMjlog(j);
  assert.deepEqual(g.players.map((p) => p.rank), [2, 3, 1, 4]);
});

test('知らない ratingc は弾く', () => {
  assert.throws(() => fromMjlog({ ...mjlog4p(), ratingc: 'PF2' }));
});
