// 対局の結果の一覧から、ランキングを作る。ルールは固定（docs/decisions.md 2026-11-19 タスク 012）。
import type { GameResult, Mode, PlayerResult, RankingRow } from './types.ts';
import { businessMonth, businessYear, inPeriod, type Period } from './period.ts';

/** まとめるキー。アカウント ID があればそれ、無ければ名前 */
export function playerKey(p: PlayerResult): string {
  return p.accountId !== undefined ? `id:${p.accountId}` : `name:${p.name}`;
}

interface Acc {
  key: string;
  accountId?: number;
  name: string;
  lastTime: number;
  /** 0.1pt 単位の整数（浮動小数の誤差を避ける） */
  totalTenths: number;
  games: number;
  tops: number;
}

function accumulate(games: GameResult[], mode: Mode, period?: Period): Map<string, Acc> {
  const map = new Map<string, Acc>();
  for (const g of games) {
    if (g.mode !== mode) continue;
    if (period && !inPeriod(g.endTime, period)) continue;
    for (const p of g.players) {
      const key = playerKey(p);
      let a = map.get(key);
      if (!a) {
        a = { key, accountId: p.accountId, name: p.name, lastTime: g.endTime, totalTenths: 0, games: 0, tops: 0 };
        map.set(key, a);
      }
      // 表示名は最新の対局の名前。同時刻なら後に来たもの
      if (g.endTime >= a.lastTime) {
        a.lastTime = g.endTime;
        a.name = p.name;
      }
      a.totalTenths += Math.round(p.pt * 10);
      a.games += 1;
      if (p.rank === 1) a.tops += 1;
    }
  }
  return map;
}

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ランキングを作る。累計pt の大きい順。
 * 同点は対局数の少ない順、さらにキーの順（同じ入力で毎回同じ結果にする）。
 */
export function aggregate(games: GameResult[], mode: Mode, period?: Period): RankingRow[] {
  const accs = [...accumulate(games, mode, period).values()];
  accs.sort((a, b) => b.totalTenths - a.totalTenths || a.games - b.games || compareKey(a.key, b.key));
  return accs.map((a, i) => ({
    rank: i + 1,
    key: a.key,
    accountId: a.accountId,
    name: a.name,
    totalPt: a.totalTenths / 10,
    avgPt: a.totalTenths / 10 / a.games,
    games: a.games,
    tops: a.tops,
  }));
}

/** 今月（6時区切り）に1局以上打った人のキー */
export function playedThisMonth(games: GameResult[], mode: Mode, now: number): Set<string> {
  const month = businessMonth(now);
  const keys = new Set<string>();
  for (const g of games) {
    if (g.mode !== mode || businessMonth(g.endTime) !== month) continue;
    for (const p of g.players) keys.add(playerKey(p));
  }
  return keys;
}

/**
 * 今年打った人のうち、今月まだ打っていない人（旧「ちのちゃん向け」シート）。
 * 今年の対局数の多い順。同数はキーの順。
 */
export function notPlayedThisMonth(games: GameResult[], mode: Mode, now: number): RankingRow[] {
  const year = Number(businessYear(now));
  const played = playedThisMonth(games, mode, now);
  return aggregate(games, mode, { from: `${year}-01-01`, to: `${year}-12-31` })
    .filter((r) => !played.has(r.key))
    .sort((a, b) => b.games - a.games || compareKey(a.key, b.key))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
