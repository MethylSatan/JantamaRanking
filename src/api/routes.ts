// 各 API の処理。024: 利用者、ランキングの管理、雀魂アカウントの指定、操作ログ。
// 025: 候補の更新・取り込み・対象外・作り直し・公開 ID・ジョブ。一覧は docs/architecture.md「API」。

import { authorize, authorizeGlobal, isAdmin, PERMISSIONS, type Role, type User } from './authorize.ts';
import type { Blobs } from './blobs.ts';
import { HttpError } from './errors.ts';
import { randomUUID } from 'node:crypto';
import { mergedCandidates, publishRanking, rankingPlayers } from './games.ts';
import { MIN_REFRESH_INTERVAL_MS, newJob, type OpenMajsoul } from './jobs.ts';
import type { Job, Ranking, RankingAccount, RankingSummary, Store } from './store.ts';
import { MAX_RECORDS_PER_RUN } from '../collector/index.ts';

export interface Deps {
  store: Store;
  blobs: Blobs;
  /** ジョブ ID */
  newJobId: () => string;
  /** ジョブを非同期で起動する（本番は自分の Lambda を InvocationType: Event で呼ぶ） */
  startJob: (jobId: string) => Promise<void>;
  /** 雀魂への接続（ジョブの中で使う） */
  openMajsoul: OpenMajsoul;
  sleep: (ms: number) => Promise<void>;
  /** 現在時刻 */
  now: () => Date;
  /** ランキング ID */
  newRankingId: () => string;
  /** 公開 ID（推測されない値） */
  newPublicId: () => string;
  /** 操作ログの sk の末尾（同じ時刻の項目を分ける） */
  newLogSuffix: () => string;
}

export interface Context {
  user: User;
  deps: Deps;
  /** JSON の本文（無い・壊れていれば 400） */
  body: () => unknown;
  /** クエリ文字列 */
  query: Record<string, string | undefined>;
}

export interface Response {
  status: number;
  body?: unknown;
}

type Handler = (ctx: Context, params: string[]) => Promise<Response>;

const NAME_MAX = 100;
const LOG_LIMIT = 100;
// ランキング ID は randomUUID()
const RANKING_ID = '([0-9a-f-]{36})';
// 牌譜 uuid（`yymmdd-` に UUID が続く形）
const GAME_UUID = '([0-9A-Za-z-]{1,64})';
const isGameUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9A-Za-z-]{1,64}$/.test(s);

const readName = (body: unknown): string => {
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== 'string') throw new HttpError(400, 'name is required');
  const trimmed = name.trim();
  if (trimmed === '' || [...trimmed].length > NAME_MAX || /\p{Cc}/u.test(trimmed)) {
    throw new HttpError(400, `name must be 1-${NAME_MAX} characters`);
  }
  return trimmed;
};

// 雀魂の内部 ID（牌譜の参加者の account_id）。表示用 ID（友達追加などで見える数字）とは別
const readInternalId = (raw: string): string => {
  if (!/^[1-9]\d{0,11}$/.test(raw)) throw new HttpError(400, 'invalid account id');
  return raw;
};

// 表示用 ID は URL に入れない（アクセスログなどに残るため）。本文で受け取る
const readDisplayId = (body: unknown): string => {
  const v = (body as { displayId?: unknown } | null)?.displayId;
  if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) throw new HttpError(400, 'invalid displayId');
  return v;
};

// 仮の項目の印は randomUUID()
const PENDING_ID = '([0-9a-f-]{36})';

const log = (
  ctx: Context,
  rankingId: string,
  via: Role,
  op: string,
  target?: string,
  detail?: Record<string, unknown>,
) =>
  ctx.deps.store.appendLog(
    rankingId,
    {
      at: ctx.deps.now().toISOString(),
      sub: ctx.user.sub,
      via,
      op,
      ...(target !== undefined ? { target } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
    ctx.deps.newLogSuffix(),
  );

const summary = (r: Ranking): RankingSummary => ({ id: r.id, name: r.name, state: r.state });

/**
 * 画面に返す雀魂アカウント。表示用 ID は返さない（タスク 031）。
 * 名前は、候補の更新で分かったもの（雀魂アカウントの項目）を、指定したときの名前より優先する
 */
const accountViews = (store: Store, accounts: RankingAccount[]) =>
  Promise.all(
    accounts.map(async (a) => {
      const m = a.internalId ? await store.getMajsoul(a.internalId) : undefined;
      const name = m?.name ?? a.name;
      return {
        ...(a.internalId ? { internalId: a.internalId } : { pendingId: a.pendingId }),
        ...(name !== undefined ? { name } : {}),
        ...(m?.lastRefreshedAt ? { lastRefreshedAt: m.lastRefreshedAt } : {}),
        addedAt: a.addedAt,
      };
    }),
  );

const detail = async (store: Store, r: Ranking, via: Role) => ({
  ...r,
  accounts: await accountViews(store, await store.listAccounts(r.id)),
  via,
});

const me: Handler = async (ctx) => ({
  status: 200,
  body: { sub: ctx.user.sub, admin: isAdmin(ctx.user), permissions: PERMISSIONS },
});

const listRankings: Handler = async (ctx) => {
  const { store } = ctx.deps;
  if (isAdmin(ctx.user)) return { status: 200, body: { rankings: await store.listAllRankings() } };
  const ids = await ctx.deps.store.listRankingIdsForUser(ctx.user.sub);
  const rankings = (await Promise.all(ids.map((id) => store.getRanking(id))))
    .filter((r): r is Ranking => r !== undefined)
    .map(summary);
  return { status: 200, body: { rankings } };
};

const createRanking: Handler = async (ctx) => {
  const { via } = authorizeGlobal(ctx.user, 'createRanking');
  const name = readName(ctx.body());
  const ranking: Ranking = {
    id: ctx.deps.newRankingId(),
    name,
    publicId: ctx.deps.newPublicId(),
    state: 'public',
    createdBy: ctx.user.sub,
    createdAt: ctx.deps.now().toISOString(),
  };
  await ctx.deps.store.createRanking(ranking);
  await log(ctx, ranking.id, via, 'createRanking', undefined, { name });
  return { status: 201, body: { ...ranking, accounts: [], via } };
};

const getRanking: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'viewRanking', id!, ctx.deps.store);
  return { status: 200, body: await detail(ctx.deps.store, ranking, via) };
};

const renameRanking: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'rename', id!, ctx.deps.store);
  const name = readName(ctx.body());
  if (name !== ranking.name) {
    await ctx.deps.store.updateRanking(ranking.id, { name });
    await log(ctx, ranking.id, via, 'rename', undefined, { from: ranking.name, to: name });
    // ランキングの JSON に名前が入っている
    await publishRanking(ctx.deps, { ...ranking, name });
  }
  return { status: 200, body: await detail(ctx.deps.store, { ...ranking, name }, via) };
};

// 削除は非公開にするだけで、データは消さない
const deleteRanking: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'deleteRanking', id!, ctx.deps.store);
  if (ranking.state !== 'deleted') {
    await ctx.deps.store.updateRanking(ranking.id, { state: 'deleted' });
    await log(ctx, ranking.id, via, 'deleteRanking');
  }
  // 非公開にするので、ランキングの JSON を消す
  await publishRanking(ctx.deps, { ...ranking, state: 'deleted' });
  return { status: 200, body: await detail(ctx.deps.store, { ...ranking, state: 'deleted' }, via) };
};

// 雀魂アカウントの指定（タスク 031）。どの形でも雀魂には要求しない
// 内部 ID で指定する（ランキングの対局の参加者から選ぶ、または Admin が直接）。名前は対局から引く
const addAccount: Handler = async (ctx, [id, rawInternalId]) => {
  const { via, ranking } = await authorize(ctx.user, 'setAccounts', id!, ctx.deps.store);
  const internalId = readInternalId(rawInternalId!);
  const name = (await rankingPlayers(ctx.deps.store, ranking.id)).find((p) => p.internalId === internalId)?.name;
  const added = await ctx.deps.store.addAccount(ranking.id, {
    internalId,
    ...(name !== undefined ? { name } : {}),
    addedBy: ctx.user.sub,
    addedAt: ctx.deps.now().toISOString(),
  });
  if (added) await log(ctx, ranking.id, via, 'addAccount', internalId, name !== undefined ? { name } : undefined);
  return { status: added ? 201 : 200, body: await detail(ctx.deps.store, ranking, via) };
};

// 表示用 ID で指定する。最初の候補の更新で内部 ID を引くまでの仮の項目にし、引いたら表示用 ID は消す。
// 表示用 ID は応答・操作ログに出さない。同じ表示用 ID の仮の項目があれば何もしない
const addAccountByDisplayId: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'setAccounts', id!, ctx.deps.store);
  const displayId = readDisplayId(ctx.body());
  const { store } = ctx.deps;
  if ((await store.listAccounts(ranking.id)).some((a) => a.displayId === displayId)) {
    return { status: 200, body: await detail(store, ranking, via) };
  }
  const pendingId = randomUUID();
  await store.addPendingAccount(ranking.id, { pendingId, displayId, addedBy: ctx.user.sub, addedAt: ctx.deps.now().toISOString() });
  await log(ctx, ranking.id, via, 'addAccount', undefined, { byDisplayId: true });
  return { status: 201, body: await detail(store, ranking, via) };
};

const removeAccount: Handler = async (ctx, [id, rawInternalId]) => {
  const { via, ranking } = await authorize(ctx.user, 'setAccounts', id!, ctx.deps.store);
  const internalId = readInternalId(rawInternalId!);
  const { store } = ctx.deps;
  const name = (await accountViews(store, (await store.listAccounts(ranking.id)).filter((a) => a.internalId === internalId)))[0]?.name;
  if (await store.removeAccount(ranking.id, internalId)) {
    await log(ctx, ranking.id, via, 'removeAccount', internalId, name !== undefined ? { name } : undefined);
  }
  return { status: 200, body: await detail(store, ranking, via) };
};

const removePendingAccount: Handler = async (ctx, [id, pendingId]) => {
  const { via, ranking } = await authorize(ctx.user, 'setAccounts', id!, ctx.deps.store);
  if (await ctx.deps.store.removePendingAccount(ranking.id, pendingId!)) {
    await log(ctx, ranking.id, via, 'removeAccount', undefined, { byDisplayId: true });
  }
  return { status: 200, body: await detail(ctx.deps.store, ranking, via) };
};

// ランキングの対局の参加者（雀魂アカウントを選んで指定するため）
const listPlayers: Handler = async (ctx, [id]) => {
  const { ranking } = await authorize(ctx.user, 'viewRanking', id!, ctx.deps.store);
  return { status: 200, body: { players: await rankingPlayers(ctx.deps.store, ranking.id) } };
};

const listLogs: Handler = async (ctx, [id]) => {
  const { ranking } = await authorize(ctx.user, 'viewLogs', id!, ctx.deps.store);
  return { status: 200, body: { logs: await ctx.deps.store.listLogs(ranking.id, LOG_LIMIT) } };
};

const GAME_STATES = ['candidate', 'imported', 'excluded'] as const;

const listGames: Handler = async (ctx, [id]) => {
  const { ranking } = await authorize(ctx.user, 'viewRanking', id!, ctx.deps.store);
  const state = ctx.query.state ?? 'candidate';
  if (!(GAME_STATES as readonly string[]).includes(state)) throw new HttpError(400, 'invalid state');
  const { store } = ctx.deps;
  const accounts = await accountViews(store, await store.listAccounts(ranking.id));
  if (state === 'candidate') {
    return { status: 200, body: { state, accounts, games: await mergedCandidates(store, ranking.id) } };
  }
  const games = (await store.listGameStates(ranking.id))
    .filter((g) => g.state === state)
    .sort((a, b) => (b.result?.endTime ?? 0) - (a.result?.endTime ?? 0) || (a.uuid < b.uuid ? -1 : 1));
  return { status: 200, body: { state, accounts, games } };
};

/** ジョブを作って起動する。起動に失敗したらジョブを失敗にする */
const enqueue = async (ctx: Context, job: Job): Promise<Response> => {
  await ctx.deps.store.createJob(job);
  try {
    await ctx.deps.startJob(job.id);
  } catch (e) {
    await ctx.deps.store.updateJob(job.id, { status: 'failed', error: 'could not start', updatedAt: ctx.deps.now().toISOString() });
    throw e;
  }
  return { status: 202, body: { job } };
};

const refresh: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'refresh', id!, ctx.deps.store);
  const accounts = await ctx.deps.store.listAccounts(ranking.id);
  if (accounts.length === 0) throw new HttpError(400, 'no accounts');
  // 手動の更新の間隔は雀魂アカウントごと。内部 ID がまだ無い（初めての更新）アカウントは数えない
  const now = ctx.deps.now();
  for (const a of accounts) {
    if (a.internalId && !(await ctx.deps.store.reserveRefresh(a.internalId, now, MIN_REFRESH_INTERVAL_MS))) {
      throw new HttpError(429, 'refreshed too recently');
    }
  }
  return enqueue(ctx, newJob(ctx.deps.newJobId(), 'refresh', { sub: ctx.user.sub, via }, now, { rankingId: ranking.id }));
};

const importGames: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'import', id!, ctx.deps.store);
  const raw = (ctx.body() as { uuids?: unknown } | null)?.uuids;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isGameUuid)) throw new HttpError(400, 'uuids is required');
  const uuids = [...new Set(raw)];
  if (uuids.length > MAX_RECORDS_PER_RUN) throw new HttpError(400, `at most ${MAX_RECORDS_PER_RUN} games`);
  // 候補（このランキングで状態を持たない、雀魂アカウントの一覧に出た対局）だけを受け付ける
  const candidates = new Set((await mergedCandidates(ctx.deps.store, ranking.id)).map((g) => g.uuid));
  const unknown = uuids.filter((u) => !candidates.has(u));
  if (unknown.length) throw new HttpError(400, `not candidates: ${unknown.join(',')}`);
  return enqueue(
    ctx,
    newJob(ctx.deps.newJobId(), 'import', { sub: ctx.user.sub, via }, ctx.deps.now(), { rankingId: ranking.id, uuids }),
  );
};

const rebuild: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'rebuild', id!, ctx.deps.store);
  return enqueue(ctx, newJob(ctx.deps.newJobId(), 'rebuild', { sub: ctx.user.sub, via }, ctx.deps.now(), { rankingId: ranking.id }));
};

// 対象外にする。取り込み済みの対局は結果を残したまま外す
const exclude: Handler = async (ctx, [id, uuid]) => {
  const { via, ranking } = await authorize(ctx.user, 'exclude', id!, ctx.deps.store);
  const { store } = ctx.deps;
  const current = await store.getGameState(ranking.id, uuid!);
  if (current?.state === 'excluded') return { status: 200, body: { game: current } };
  if (!current && !(await mergedCandidates(store, ranking.id)).some((g) => g.uuid === uuid)) {
    throw new HttpError(404, 'game not found');
  }
  const game = {
    uuid: uuid!,
    state: 'excluded' as const,
    ...(current?.result ? { result: current.result } : {}),
    changedBy: ctx.user.sub,
    changedAt: ctx.deps.now().toISOString(),
  };
  await store.putGameState(ranking.id, game);
  await log(ctx, ranking.id, via, 'exclude', uuid, { from: current?.state ?? 'candidate' });
  if (current?.state === 'imported') await publishRanking(ctx.deps, ranking);
  return { status: 200, body: { game } };
};

// 戻す。結果を持っていれば取り込み済みに、無ければ候補に
const restore: Handler = async (ctx, [id, uuid]) => {
  const { via, ranking } = await authorize(ctx.user, 'exclude', id!, ctx.deps.store);
  const { store } = ctx.deps;
  const current = await store.getGameState(ranking.id, uuid!);
  if (!current) throw new HttpError(404, 'game not found');
  if (current.state !== 'excluded') return { status: 200, body: { game: current } };
  if (current.result) {
    const game = { ...current, state: 'imported' as const, changedBy: ctx.user.sub, changedAt: ctx.deps.now().toISOString() };
    await store.putGameState(ranking.id, game);
    await log(ctx, ranking.id, via, 'restore', uuid, { to: 'imported' });
    await publishRanking(ctx.deps, ranking);
    return { status: 200, body: { game } };
  }
  await store.deleteGameState(ranking.id, uuid!);
  await log(ctx, ranking.id, via, 'restore', uuid, { to: 'candidate' });
  return { status: 200, body: { game: { uuid, state: 'candidate' } } };
};

// 公開 ID の取り直し。新しい JSON を置いてから、古い JSON を消す
const regeneratePublicId: Handler = async (ctx, [id]) => {
  const { via, ranking } = await authorize(ctx.user, 'publicUrl', id!, ctx.deps.store);
  const publicId = ctx.deps.newPublicId();
  await ctx.deps.store.updatePublicId(ranking.id, publicId);
  const updated = { ...ranking, publicId };
  await publishRanking(ctx.deps, updated);
  await ctx.deps.blobs.deleteRankingJson(ranking.publicId);
  await log(ctx, ranking.id, via, 'regeneratePublicId');
  return { status: 200, body: await detail(ctx.deps.store, updated, via) };
};

// ジョブは、そのランキングを見られる人だけが見られる。定期取得のジョブは Admin だけ
const getJob: Handler = async (ctx, [jobId]) => {
  const job = await ctx.deps.store.getJob(jobId!);
  if (!job) throw new HttpError(404, 'not found');
  if (job.rankingId) await authorize(ctx.user, 'viewRanking', job.rankingId, ctx.deps.store);
  else if (!isAdmin(ctx.user)) throw new HttpError(404, 'not found');
  return { status: 200, body: { job } };
};

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ['GET', /^\/api\/me$/, me],
  ['GET', /^\/api\/rankings$/, listRankings],
  ['POST', /^\/api\/rankings$/, createRanking],
  ['GET', new RegExp(`^/api/rankings/${RANKING_ID}$`), getRanking],
  ['PATCH', new RegExp(`^/api/rankings/${RANKING_ID}$`), renameRanking],
  ['DELETE', new RegExp(`^/api/rankings/${RANKING_ID}$`), deleteRanking],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/accounts$`), addAccountByDisplayId],
  ['DELETE', new RegExp(`^/api/rankings/${RANKING_ID}/accounts/pending/${PENDING_ID}$`), removePendingAccount],
  ['PUT', new RegExp(`^/api/rankings/${RANKING_ID}/accounts/([^/]+)$`), addAccount],
  ['DELETE', new RegExp(`^/api/rankings/${RANKING_ID}/accounts/([^/]+)$`), removeAccount],
  ['GET', new RegExp(`^/api/rankings/${RANKING_ID}/players$`), listPlayers],
  ['GET', new RegExp(`^/api/rankings/${RANKING_ID}/logs$`), listLogs],
  ['GET', new RegExp(`^/api/rankings/${RANKING_ID}/games$`), listGames],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/refresh$`), refresh],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/import$`), importGames],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/rebuild$`), rebuild],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/games/${GAME_UUID}/exclude$`), exclude],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/games/${GAME_UUID}/restore$`), restore],
  ['POST', new RegExp(`^/api/rankings/${RANKING_ID}/public-id$`), regeneratePublicId],
  ['GET', new RegExp(`^/api/jobs/${RANKING_ID}$`), getJob],
];

/** パスとメソッドに合う処理。パスはあるがメソッドが違えば 405、パスが無ければ undefined */
export function route(method: string, path: string): { handler: Handler; params: string[] } | undefined {
  let pathMatched = false;
  for (const [m, pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (m === method) {
      try {
        return { handler, params: match.slice(1).map((s) => decodeURIComponent(s)) };
      } catch {
        throw new HttpError(400, 'invalid path');
      }
    }
    pathMatched = true;
  }
  if (pathMatched) throw new HttpError(405, 'method not allowed');
  return undefined;
}
