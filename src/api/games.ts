// 候補の合わせ方と、ランキングの JSON（docs/architecture.md「データモデル」「取り込みの手順」）。

import type { GameResult } from '../ranking/index.ts';
import type { Blobs } from './blobs.ts';
import type { CandidateGame, GameState, Ranking, Store } from './store.ts';

/** 閲覧の画面に渡すランキングの JSON。集計は画面が src/ranking で行う */
export interface RankingJson {
  version: 1;
  name: string;
  generatedAt: string;
  /** 取り込み済みの対局の結果。終了時刻の順（同時刻は uuid の順） */
  games: GameResult[];
}

export function buildRankingJson(ranking: Pick<Ranking, 'name'>, states: GameState[], now: Date): RankingJson {
  const games = states
    .filter((s): s is GameState & { result: GameResult } => s.state === 'imported' && s.result !== undefined)
    .map((s) => s.result)
    .sort((a, b) => a.endTime - b.endTime || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  return { version: 1, name: ranking.name, generatedAt: now.toISOString(), games };
}

/** ランキングの JSON を作り直して置く。削除（非公開）のランキングは JSON を消す */
export async function publishRanking(deps: { store: Store; blobs: Blobs; now: () => Date }, ranking: Ranking): Promise<void> {
  if (ranking.state === 'deleted') {
    await deps.blobs.deleteRankingJson(ranking.publicId);
    return;
  }
  const json = buildRankingJson(ranking, await deps.store.listGameStates(ranking.id), deps.now());
  await deps.blobs.putRankingJson(ranking.publicId, JSON.stringify(json));
}

export interface MergedCandidate extends CandidateGame {
  /** この対局が出てきた雀魂アカウント（内部 ID） */
  sources: string[];
}

/** ランキングの雀魂アカウントたちの候補を uuid で合わせ、このランキングで状態を持つ対局を除く。新しい順 */
export async function mergedCandidates(store: Store, rankingId: string): Promise<MergedCandidate[]> {
  const [accounts, states] = await Promise.all([store.listAccounts(rankingId), store.listGameStates(rankingId)]);
  const known = new Set(states.map((s) => s.uuid));
  const byUuid = new Map<string, MergedCandidate>();
  for (const a of accounts) {
    if (!a.internalId) continue;
    for (const g of await store.listCandidates(a.internalId)) {
      if (known.has(g.uuid)) continue;
      const m = byUuid.get(g.uuid);
      if (m) m.sources.push(a.internalId);
      else byUuid.set(g.uuid, { ...g, sources: [a.internalId] });
    }
  }
  return [...byUuid.values()].sort((a, b) => b.startTime - a.startTime || (a.uuid < b.uuid ? -1 : 1));
}

/** ランキングの対局（取り込み済み・対象外の結果と、候補）に出てくる参加者。雀魂アカウントを選んで指定するのに使う（タスク 031） */
export interface RankingPlayer {
  internalId: string;
  /** 一番新しい対局での名前 */
  name: string;
  /** 出てくる対局の数 */
  games: number;
}

/** 対局の数の多い順（同数は内部 ID の順）。アカウント ID の無い席（AI・旧方式の名前だけの結果）は除く */
export async function rankingPlayers(store: Store, rankingId: string): Promise<RankingPlayer[]> {
  const seen = new Map<string, { name: string; time: number; games: Set<string> }>();
  const add = (uuid: string, time: number, id: number | undefined, name: string) => {
    if (!id) return;
    const key = String(id);
    const p = seen.get(key) ?? seen.set(key, { name, time, games: new Set() }).get(key)!;
    if (time >= p.time) {
      p.time = time;
      p.name = name;
    }
    p.games.add(uuid);
  };
  for (const s of await store.listGameStates(rankingId)) {
    for (const p of s.result?.players ?? []) add(s.uuid, s.result!.endTime, p.accountId, p.name);
  }
  for (const g of await mergedCandidates(store, rankingId)) {
    for (const p of g.players) add(g.uuid, g.endTime, p.accountId, p.nickname);
  }
  return [...seen]
    .map(([internalId, p]) => ({ internalId, name: p.name, games: p.games.size }))
    .sort((a, b) => b.games - a.games || (a.internalId < b.internalId ? -1 : a.internalId > b.internalId ? 1 : 0));
}
