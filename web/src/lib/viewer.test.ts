import { test } from 'node:test';
import assert from 'node:assert/strict';
import { game } from '../../../src/ranking/testdata.ts';
import { parseJstTitle } from '../../../src/ranking/index.ts';
import {
  defaultMode,
  joinNames,
  matchesName,
  nextSort,
  notYetRows,
  parseRankingJson,
  periodLabel,
  queryFromState,
  rankingRows,
  stateFromQuery,
  toPeriod,
  yearsOf,
  type ViewState,
} from './viewer.ts';

const games = [
  game('2025/6/1 21:00:00', [['うさぎ', 40000, 1], ['かめ', 30000, 2], ['きつね', 20000, 3], ['たぬき', 10000, 4]]),
  // 11月2日 0:30 は 11月1日（6時区切り）
  game('2026/11/2 0:30:00', [['うさぎ', 10000, 1], ['かめ', 20000, 2], ['きつね', 30000, 3], ['ＴＡＮＵＫＩ', 40000, 4]]),
  game('2026/10/10 22:00:00', [['うさぎ', 35000, 1], ['かめ', 35000, 2], ['きつね', 35000, 3]]),
];
const now = parseJstTitle('2026/11/25 12:00:00');
const base: ViewState = { mode: '4p', period: { kind: 'year', year: 2026 }, q: '', tab: 'ranking', sort: 'rank', desc: false };

test('ランキングの JSON の確認', () => {
  const ok = parseRankingJson({ version: 1, name: 'テスト', generatedAt: '2026-11-25T00:00:00Z', games: [] });
  assert.equal(ok.name, 'テスト');
  assert.throws(() => parseRankingJson({ version: 2, name: 'x', games: [] }));
  assert.throws(() => parseRankingJson(null));
});

test('年の一覧は新しい順で、今年を含む', () => {
  assert.deepEqual(yearsOf(games, now), [2026, 2025]);
  assert.deepEqual(yearsOf([], parseJstTitle('2027/1/1 7:00:00')), [2027]);
});

test('四麻が無ければ三麻を既定にする', () => {
  assert.equal(defaultMode(games), '4p');
  assert.equal(defaultMode([games[2]]), '3p');
  assert.equal(defaultMode([]), '4p');
});

test('クエリと状態の行き来', () => {
  const def = stateFromQuery(new URLSearchParams('id=abc'), games, now);
  assert.deepEqual(def, base);
  assert.equal(queryFromState('abc', def), 'id=abc&mode=4p&year=2026');

  const s: ViewState = { mode: '3p', period: { kind: 'range', from: '2026-01-01', to: '' }, q: 'う', tab: 'notyet', sort: 'games', desc: true };
  const q = queryFromState('abc', s);
  assert.deepEqual(stateFromQuery(new URLSearchParams(q), games, now), s);

  assert.deepEqual(stateFromQuery(new URLSearchParams('year=all'), games, now).period, { kind: 'all' });
  // おかしい値は既定に
  const bad = stateFromQuery(new URLSearchParams('mode=5p&year=x&from=2026/1/1&sort=evil&tab=?'), games, now);
  assert.deepEqual(bad, base);
});

test('期間', () => {
  assert.equal(toPeriod({ kind: 'all' }), undefined);
  assert.deepEqual(toPeriod({ kind: 'year', year: 2025 }), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(toPeriod({ kind: 'range', from: '', to: '2026-03-31' }), { from: undefined, to: '2026-03-31' });
  assert.equal(periodLabel({ kind: 'range', from: '2026-01-01', to: '' }), '2026/01/01〜');
  assert.equal(periodLabel({ kind: 'year', year: 2025 }), '2025年');
});

test('名前は全角・半角、大文字・小文字、ひらがな・カタカナを区別せずに部分一致', () => {
  assert.equal(matchesName('ねこ', 'ネコ'), true);
  assert.equal(matchesName('ネコ', 'ねこ'), true);
  assert.equal(matchesName('ﾈｺ', 'ねこ'), true);
  assert.equal(matchesName('ＴＡＮＵＫＩ', 'nuk'), true);
  assert.equal(matchesName('うさぎ', ' '), true);
  assert.equal(matchesName('うさぎ', 'かめ'), false);
});

test('ランキングの行: 期間・今月・名前の絞り込み（順位は振り直さない）', () => {
  const rows = rankingRows(games, base, now);
  assert.deepEqual(rows.map((r) => [r.rank, r.name, r.thisMonth]), [
    [1, 'ＴＡＮＵＫＩ', true],
    [2, 'きつね', true],
    [3, 'かめ', true],
    [4, 'うさぎ', true],
  ]);
  const all = rankingRows(games, { ...base, period: { kind: 'all' } }, now);
  // 2025 の「たぬき」は ID 4 で ＴＡＮＵＫＩ と同じ人。名前は新しい対局のもの
  assert.equal(all.length, 4);
  assert.equal(all.find((r) => r.accountId === 4)?.games, 2);
  assert.equal(all.find((r) => r.accountId === 4)?.name, 'ＴＡＮＵＫＩ');
  const filtered = rankingRows(games, { ...base, q: 'かめ' }, now);
  assert.deepEqual(filtered.map((r) => r.rank), [3]);
});

test('並べ替え: 同じ値は順位の順、同じ列をもう一度で逆順', () => {
  const byGames = rankingRows(games, { ...base, sort: 'games', desc: true }, now);
  assert.deepEqual(byGames.map((r) => r.rank), [1, 2, 3, 4]);
  const byName = rankingRows(games, { ...base, sort: 'name', desc: false }, now);
  assert.deepEqual(byName.map((r) => r.name), ['ＴＡＮＵＫＩ', 'うさぎ', 'かめ', 'きつね']);
  assert.deepEqual(nextSort(base, 'totalPt'), { sort: 'totalPt', desc: true });
  assert.deepEqual(nextSort({ sort: 'totalPt', desc: true }, 'totalPt'), { sort: 'totalPt', desc: false });
  assert.deepEqual(nextSort(base, 'name'), { sort: 'name', desc: false });
});

test('今月まだの人と1行の文', () => {
  // 三麻は今年10月だけ → 3人とも今月まだ
  const rows = notYetRows(games, '3p', now);
  assert.equal(rows.length, 3);
  assert.equal(joinNames(rows), rows.map((r) => r.name).join('　'));
  assert.deepEqual(notYetRows(games, '4p', now), []);
});
