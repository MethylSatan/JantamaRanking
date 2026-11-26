// 主催者の友人戦の候補を出し、選んだ対局の牌譜（head）を取る（タスク 006）。
// 取り込み済み・対象外の記録は呼び出し側が持つ（Web サービスでは DynamoDB、CLI ではファイル）。
import type { Mode } from '../ranking/types.ts';
import type { Session } from './session.ts';

/** `fetchAccountInfoExtra` が種類ごとに返す最大の件数 */
export const LIST_LIMIT = 50;
/** この件数以上なら、上限が近いと警告する */
export const LIST_WARN_AT = 40;
/** 1回の実行で取る牌譜の最大の件数 */
export const MAX_RECORDS_PER_RUN = 100;
/** `fetchGameRecordsDetail` に1回で渡す uuid の数。50件まで1回で返ることを確かめた（2026-11-19。それより多くは未確認） */
export const DEFAULT_CHUNK_SIZE = 50;

const CATEGORIES: { category: number; mode: Mode }[] = [
  { category: 1, mode: '4p' },
  { category: 2, mode: '3p' },
];
const TYPE_FRIENDLY = 2;

export interface CandidatePlayer {
  seat: number;
  accountId: number;
  nickname: string;
  rank: number;
  /** 一覧の `final_point`（意味は未確認。表示の参考） */
  finalPoint: number;
}

/** 候補の対局（一覧の1件） */
export interface Candidate {
  uuid: string;
  /** epoch ms */
  startTime: number;
  endTime: number;
  mode: Mode;
  tag: number;
  subTag: number;
  players: CandidatePlayer[];
}

export interface CandidateList {
  /** 主催者の内部 ID */
  accountId: number;
  /** 取り込み済み・対象外を除いた候補。新しい順 */
  candidates: Candidate[];
  /** 雀魂が返したすべての対局（処理済みを含む）。新しい順 */
  all: Candidate[];
  /** 雀魂が返した件数（種類ごと） */
  returned: Record<Mode, number>;
  warnings: string[];
}

/** 主催者の指定。表示用 ID（プロフィールに出る ID）か、内部 ID */
export type Host = { eid: number } | { accountId: number };

/** 主催者の友人戦の候補を出す（要求2回。表示用 ID で指定したときは、内部 ID を引くので3回） */
export async function listCandidates(session: Session, host: Host, isKnown: (uuid: string) => boolean): Promise<CandidateList> {
  let accountId: number | undefined;
  if ('accountId' in host) {
    accountId = host.accountId;
  } else {
    const found = await session.call('Lobby.searchAccountByEid', { eid: host.eid });
    accountId = found.account_id;
    if (!accountId) throw new Error(`表示用 ID ${host.eid} のアカウントが見つからない`);
  }

  const candidates: Candidate[] = [];
  const all: Candidate[] = [];
  const warnings: string[] = [];
  const returned = { '4p': 0, '3p': 0 } as Record<Mode, number>;
  for (const { category, mode } of CATEGORIES) {
    const res = await session.call('Lobby.fetchAccountInfoExtra', { account_id: accountId, category, type: TYPE_FRIENDLY });
    const games = ((res.recent_games ?? []) as any[]).filter((g) => g.uuid).map((g) => toCandidate(g, mode));
    games.sort((a, b) => b.startTime - a.startTime);
    returned[mode] = games.length;
    const label = mode === '4p' ? '四麻' : '三麻';
    const oldest = games[games.length - 1];
    if (games.length >= LIST_LIMIT && oldest && !isKnown(oldest.uuid)) {
      warnings.push(`${label}: 一覧が上限の${LIST_LIMIT}件に達していて、一番古い対局も未処理。それより古い対局を取りこぼしたおそれがある`);
    } else if (games.length >= LIST_WARN_AT) {
      warnings.push(`${label}: 一覧が${games.length}件。上限の${LIST_LIMIT}件に近い。早めに取り込むか対象外にする`);
    }
    all.push(...games);
    candidates.push(...games.filter((g) => !isKnown(g.uuid)));
  }
  candidates.sort((a, b) => b.startTime - a.startTime);
  all.sort((a, b) => b.startTime - a.startTime);
  return { accountId, candidates, all, returned, warnings };
}

/**
 * 一覧の `sub_tag`（牌譜の `config.mode.mode` と同じ値）から、東風か半荘かを返す。
 * 一の位が 1 なら東風、2 なら半荘（PaifuImporter の parse() と同じ）。十の位は三麻とみられる（11・12 を三麻で確認）。
 * それ以外（4 など）は意味を確かめていないので null
 */
export function gameLength(subTag: number): '東風' | '半荘' | null {
  const m = subTag % 10;
  return m === 1 ? '東風' : m === 2 ? '半荘' : null;
}

function toCandidate(g: any, mode: Mode): Candidate {
  const players = ((g.results ?? []) as any[]).map((p) => ({
    seat: p.seat ?? 0,
    accountId: p.account_id ?? 0,
    nickname: p.nickname ?? '',
    rank: p.rank ?? 0,
    finalPoint: p.final_point ?? 0,
  }));
  players.sort((a, b) => a.seat - b.seat);
  return {
    uuid: g.uuid,
    startTime: (g.start_time ?? 0) * 1000,
    endTime: (g.end_time ?? 0) * 1000,
    mode,
    tag: g.tag ?? 0,
    subTag: g.sub_tag ?? 0,
    players,
  };
}

export interface FetchResult {
  /** 見た目の情報を外した head。要求した順 */
  heads: Record<string, unknown>[];
  /** 要求したが返らなかった uuid */
  missing: string[];
}

/**
 * 選んだ対局の牌譜（head）を取る。`chunkSize` 件ずつまとめて要求する。
 * 上限は既定で MAX_RECORDS_PER_RUN 件。`maxRecords` で変えられる（旧方式の牌譜の移行など、1回だけの作業に使う）
 */
export async function fetchHeads(
  session: Session,
  uuids: string[],
  opts: { chunkSize?: number; maxRecords?: number } = {},
): Promise<FetchResult> {
  const unique = [...new Set(uuids)];
  const max = opts.maxRecords ?? MAX_RECORDS_PER_RUN;
  if (unique.length > max) throw new Error(`1回に取れるのは${max}件まで（${unique.length}件を指定した）`);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!(chunkSize >= 1)) throw new Error(`chunkSize が不正: ${chunkSize}`);
  const byUuid = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < unique.length; i += chunkSize) {
    const res = await session.call('Lobby.fetchGameRecordsDetail', { uuid_list: unique.slice(i, i + chunkSize) });
    for (const h of (res.record_list ?? []) as Record<string, unknown>[]) byUuid.set(String(h.uuid), trimHead(h));
  }
  const heads: Record<string, unknown>[] = [];
  const missing: string[] = [];
  for (const u of unique) {
    const h = byUuid.get(u);
    if (h) heads.push(h);
    else missing.push(u);
  }
  return { heads, missing };
}

/** 参加者の見た目の情報（アバター・キャラ・装飾・称号・枠）。集計にも表示にも使わないので保存しない */
export const COSMETIC_ACCOUNT_FIELDS = ['avatar_id', 'character', 'views', 'title', 'avatar_frame'] as const;

/** head から参加者の見た目の情報を外す（元は変えない） */
export function trimHead(head: Record<string, unknown>): Record<string, unknown> {
  const accounts = Array.isArray(head.accounts) ? head.accounts : [];
  return {
    ...head,
    accounts: accounts.map((a: Record<string, unknown>) => {
      const rest = { ...a };
      for (const k of COSMETIC_ACCOUNT_FIELDS) delete rest[k];
      return rest;
    }),
  };
}
