import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, notPlayedThisMonth, playedThisMonth } from './aggregate.ts';
import { game } from './testdata.ts';

const jst = (s: string) => Date.parse(`${s}+09:00`);

const games = [
  game('2024/1/10 22:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]), // A+30 B+10 C-10 D-30
  game('2024/1/11 1:00:00', [['B', 45000], ['A', 25000], ['C', 25000], ['D', 5000]]), // B+35 A+5 C-5 D-35
  game('2024/1/11 2:00:00', [['A', 40000], ['B', 35000], ['C', 30000]]), // 三麻 A+20 B0 C-20
];

test('累計pt・平均pt・対局数・トップ回数。累計pt の大きい順', () => {
  const rows = aggregate(games, '4p');
  assert.deepEqual(
    rows.map((r) => [r.rank, r.name, r.totalPt, r.avgPt, r.games, r.tops]),
    [
      [1, 'B', 45, 22.5, 2, 1],
      [2, 'A', 35, 17.5, 2, 1],
      [3, 'C', -15, -7.5, 2, 0],
      [4, 'D', -65, -32.5, 2, 0],
    ],
  );
});

test('四麻と三麻は別に集計する', () => {
  const rows = aggregate(games, '3p');
  assert.deepEqual(rows.map((r) => [r.name, r.totalPt, r.tops]), [['A', 20, 1], ['B', 0, 0], ['C', -20, 0]]);
});

test('pt の合計で浮動小数の誤差を出さない', () => {
  const gs = [0, 1, 2].map((i) => game(`2024/2/${i + 1} 22:00:00`, [['A', 25100], ['B', 25000], ['C', 25000], ['D', 24900]]));
  // A は 15.1 を3回
  const a = aggregate(gs, '4p').find((r) => r.name === 'A')!;
  assert.equal(a.totalPt, 45.3);
});

test('累計pt が同じなら対局数の少ない順、さらにキーの順。同点でも順位は分ける', () => {
  const gs = [
    game('2024/3/1 22:00:00', [['Y', 35000], ['X', 35000], ['P', 15000], ['Q', 15000]]), // Y+25 X+15 P-15 Q-25
    game('2024/3/2 22:00:00', [['X', 35000], ['Z', 35000], ['P', 15000], ['Q', 15000]]), // X+25 Z+15
    game('2024/3/3 22:00:00', [['Z', 35000], ['R', 35000], ['P', 15000], ['Q', 15000]]), // Z+25 R+15
  ];
  // X: 40 (2局)、Z: 40 (2局)、Y: 25 (1局)、R: 15 (1局)
  const rows = aggregate(gs, '4p');
  assert.deepEqual(rows.slice(0, 4).map((r) => [r.rank, r.name]), [[1, 'X'], [2, 'Z'], [3, 'Y'], [4, 'R']]);
  // 対局数が違う同点: 1局で 40 の W は、2局で 40 の X より上
  const w = game('2024/3/4 22:00:00', [['W', 50000], ['S', 25000], ['T', 15000], ['U', 10000]]); // W+40
  const rows2 = aggregate([...gs, w], '4p');
  assert.deepEqual(rows2.slice(0, 3).map((r) => r.name), ['W', 'X', 'Z']);
  // 入力の順を変えても同じ
  assert.deepEqual(aggregate([w, ...gs].reverse(), '4p'), rows2);
});

test('期間で絞る（6時区切り）', () => {
  const gs = [
    game('2024/12/31 23:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]),
    game('2025/1/1 2:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]), // 2024年扱い
    game('2025/1/1 6:00:00', [['B', 40000], ['A', 30000], ['C', 20000], ['D', 10000]]),
  ];
  assert.equal(aggregate(gs, '4p', { from: '2024-01-01', to: '2024-12-31' })[0].games, 2);
  assert.deepEqual(aggregate(gs, '4p', { from: '2025-01-01' }).map((r) => r.name), ['B', 'A', 'C', 'D']);
});

test('アカウント ID があればそれでまとめ、表示は最新の名前', () => {
  const gs = [
    game('2024/4/2 22:00:00', [['新しい名前', 40000, 1], ['B', 30000, 2], ['C', 20000, 3], ['D', 10000, 4]]),
    game('2024/4/1 22:00:00', [['古い名前', 40000, 1], ['B', 30000, 2], ['C', 20000, 3], ['D', 10000, 4]]),
  ];
  const top = aggregate(gs, '4p')[0];
  assert.deepEqual([top.key, top.accountId, top.name, top.games], ['id:1', 1, '新しい名前', 2]);
});

test('アカウント ID が無ければ名前でまとめる（名前を変えると別人）', () => {
  const gs = [
    game('2024/4/1 22:00:00', [['古い名前', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]),
    game('2024/4/2 22:00:00', [['新しい名前', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]),
  ];
  const rows = aggregate(gs, '4p');
  assert.equal(rows.length, 5);
  assert.equal(rows.find((r) => r.key === 'name:古い名前')!.games, 1);
});

test('今月参加済み: 6時区切りの今月に打った人。月初の深夜は前の月', () => {
  const gs = [
    game('2024/5/31 22:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]),
    game('2024/6/1 2:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['E', 10000]]), // 5月扱い
    game('2024/6/1 22:00:00', [['A', 40000], ['F', 30000], ['C', 20000], ['G', 10000]]),
  ];
  const now = jst('2024-06-15T12:00:00');
  assert.deepEqual([...playedThisMonth(gs, '4p', now)].sort(), ['name:A', 'name:C', 'name:F', 'name:G']);
  // 1日の0時〜6時は、まだ前の月
  assert.deepEqual([...playedThisMonth(gs, '4p', jst('2024-06-01T05:00:00'))].sort(), ['name:A', 'name:B', 'name:C', 'name:D', 'name:E']);
});

test('今月まだ打っていない人: 今年打った人のうち、今年の対局数の多い順', () => {
  const gs = [
    game('2023/12/1 22:00:00', [['H', 40000], ['A', 30000], ['C', 20000], ['D', 10000]]), // 去年だけの H は出ない
    game('2024/5/1 22:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['D', 10000]]),
    game('2024/5/2 22:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['E', 10000]]),
    game('2024/5/3 22:00:00', [['A', 40000], ['B', 30000], ['C', 20000], ['E', 10000]]),
    game('2024/6/2 22:00:00', [['A', 40000], ['F', 30000], ['C', 20000], ['G', 10000]]),
  ];
  const rows = notPlayedThisMonth(gs, '4p', jst('2024-06-15T12:00:00'));
  assert.deepEqual(rows.map((r) => [r.rank, r.name, r.games]), [[1, 'B', 3], [2, 'E', 2], [3, 'D', 1]]);
});
