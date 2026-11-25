// 閲覧の画面（タスク 027）の純粋な処理: ランキングの JSON の確認、絞り込みの状態と URL のクエリ、並べ替え。
// 集計そのものは src/ranking（aggregate など）を使う。

import {
  aggregate,
  businessYear,
  notPlayedThisMonth,
  playedThisMonth,
  yearPeriod,
  type GameResult,
  type Mode,
  type Period,
  type RankingRow,
} from '../../../src/ranking/index.ts';

/** site バケットの rankings/<公開 ID>.json（src/api/games.ts の形） */
export interface RankingJson {
  version: 1;
  name: string;
  generatedAt: string;
  games: GameResult[];
}

export function parseRankingJson(v: unknown): RankingJson {
  const o = v as Partial<RankingJson> | null;
  if (!o || typeof o !== 'object' || o.version !== 1 || typeof o.name !== 'string' || !Array.isArray(o.games)) {
    throw new Error('unexpected ranking json');
  }
  return { version: 1, name: o.name, generatedAt: String(o.generatedAt ?? ''), games: o.games };
}

export type Tab = 'ranking' | 'notyet';
export type PeriodChoice = { kind: 'all' } | { kind: 'year'; year: number } | { kind: 'range'; from: string; to: string };
export type SortKey = 'rank' | 'name' | 'totalPt' | 'avgPt' | 'games' | 'tops' | 'thisMonth';

export interface ViewState {
  mode: Mode;
  period: PeriodChoice;
  q: string;
  tab: Tab;
  sort: SortKey;
  desc: boolean;
}

const SORT_KEYS: SortKey[] = ['rank', 'name', 'totalPt', 'avgPt', 'games', 'tops', 'thisMonth'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 対局のある年（新しい順）。今年は対局が無くても入れる */
export function yearsOf(games: GameResult[], now: number): number[] {
  const set = new Set<number>([Number(businessYear(now))]);
  for (const g of games) set.add(Number(businessYear(g.endTime)));
  return [...set].sort((a, b) => b - a);
}

/** 四麻の対局が無く三麻だけあるときは三麻、ほかは四麻 */
export function defaultMode(games: GameResult[]): Mode {
  return games.some((g) => g.mode === '4p') || !games.some((g) => g.mode === '3p') ? '4p' : '3p';
}

/** URL のクエリから状態を作る。無い・おかしい値は既定（四麻か三麻は対局から、期間は今年、順位の順） */
export function stateFromQuery(params: URLSearchParams, games: GameResult[], now: number): ViewState {
  const m = params.get('mode');
  const mode: Mode = m === '4p' || m === '3p' ? m : defaultMode(games);
  const year = params.get('year');
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  let period: PeriodChoice;
  if (year === 'all') period = { kind: 'all' };
  else if (year && /^\d{4}$/.test(year)) period = { kind: 'year', year: Number(year) };
  else if ((from && DATE_RE.test(from)) || (to && DATE_RE.test(to)))
    period = { kind: 'range', from: DATE_RE.test(from) ? from : '', to: DATE_RE.test(to) ? to : '' };
  else period = { kind: 'year', year: Number(businessYear(now)) };
  const sort = params.get('sort') as SortKey | null;
  return {
    mode,
    period,
    q: params.get('q') ?? '',
    tab: params.get('tab') === 'notyet' ? 'notyet' : 'ranking',
    sort: sort && SORT_KEYS.includes(sort) ? sort : 'rank',
    desc: params.get('desc') === '1',
  };
}

/** 状態を URL のクエリに。公開 ID（id）は残す */
export function queryFromState(id: string, s: ViewState): string {
  const p = new URLSearchParams({ id, mode: s.mode });
  if (s.period.kind === 'all') p.set('year', 'all');
  else if (s.period.kind === 'year') p.set('year', String(s.period.year));
  else {
    if (s.period.from) p.set('from', s.period.from);
    if (s.period.to) p.set('to', s.period.to);
  }
  if (s.q) p.set('q', s.q);
  if (s.tab !== 'ranking') p.set('tab', s.tab);
  if (s.sort !== 'rank') p.set('sort', s.sort);
  if (s.desc) p.set('desc', '1');
  return p.toString();
}

export function toPeriod(c: PeriodChoice): Period | undefined {
  if (c.kind === 'all') return undefined;
  if (c.kind === 'year') return yearPeriod(c.year);
  return { from: c.from || undefined, to: c.to || undefined };
}

export interface ViewRow extends RankingRow {
  thisMonth: boolean;
}

/** 名前を比べる形に（全角・半角、大文字・小文字、ひらがな・カタカナを区別しない） */
const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function matchesName(name: string, q: string): boolean {
  const t = norm(q.trim());
  return t === '' || norm(name).includes(t);
}

/** ランキングのタブの行。順位は期間で集計したときのまま（名前で絞っても振り直さない） */
export function rankingRows(games: GameResult[], s: ViewState, now: number): ViewRow[] {
  const played = playedThisMonth(games, s.mode, now);
  const rows = aggregate(games, s.mode, toPeriod(s.period))
    .filter((r) => matchesName(r.name, s.q))
    .map((r) => ({ ...r, thisMonth: played.has(r.key) }));
  return sortRows(rows, s.sort, s.desc);
}

/** 見出しを初めて押したときの向き。数は大きい順、順位と名前は小さい順 */
export const defaultDesc = (key: SortKey): boolean => key !== 'rank' && key !== 'name';

function cmp(a: ViewRow, b: ViewRow, key: SortKey): number {
  switch (key) {
    case 'rank':
      return a.rank - b.rank;
    case 'name':
      return a.name.localeCompare(b.name, 'ja');
    case 'thisMonth':
      return Number(a.thisMonth) - Number(b.thisMonth);
    default:
      return a[key] - b[key];
  }
}

/** 並べ替え。同じ値は順位の順 */
export function sortRows(rows: ViewRow[], key: SortKey, desc: boolean): ViewRow[] {
  return [...rows].sort((a, b) => (desc ? -cmp(a, b, key) : cmp(a, b, key)) || a.rank - b.rank);
}

/** 見出しを押したときの次の並べ方。同じ列ならもう一度で逆順 */
export function nextSort(s: Pick<ViewState, 'sort' | 'desc'>, key: SortKey): Pick<ViewState, 'sort' | 'desc'> {
  return s.sort === key ? { sort: key, desc: !s.desc } : { sort: key, desc: defaultDesc(key) };
}

/** 今月まだの人（今年・選んだ四麻か三麻。期間と名前の絞り込みは効かない） */
export const notYetRows = (games: GameResult[], mode: Mode, now: number): RankingRow[] => notPlayedThisMonth(games, mode, now);

/** 旧「ちのちゃん向け」シートと同じく、名前を全角スペースでつないだ1行 */
export const joinNames = (rows: RankingRow[]): string => rows.map((r) => r.name).join('　');

/** 期間の見出し */
export function periodLabel(c: PeriodChoice): string {
  if (c.kind === 'all') return '全期間';
  if (c.kind === 'year') return `${c.year}年`;
  if (!c.from && !c.to) return '全期間';
  return `${c.from ? c.from.replaceAll('-', '/') : ''}〜${c.to ? c.to.replaceAll('-', '/') : ''}`;
}
