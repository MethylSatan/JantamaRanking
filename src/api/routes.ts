// 各 API の処理（タスク 024 の分: 利用者、ランキングの管理、雀魂アカウントの指定、操作ログ）。
// 一覧は docs/architecture.md「API」。

import { authorize, authorizeGlobal, isAdmin, PERMISSIONS, type Role, type User } from './authorize.ts';
import { HttpError } from './errors.ts';
import type { Ranking, RankingSummary, Store } from './store.ts';

export interface Deps {
  store: Store;
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

const readName = (body: unknown): string => {
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== 'string') throw new HttpError(400, 'name is required');
  const trimmed = name.trim();
  if (trimmed === '' || [...trimmed].length > NAME_MAX || /\p{Cc}/u.test(trimmed)) {
    throw new HttpError(400, `name must be 1-${NAME_MAX} characters`);
  }
  return trimmed;
};

// 雀魂の表示用 ID（友達追加などで見える数字）
const readDisplayId = (raw: string): string => {
  if (!/^\d{1,12}$/.test(raw)) throw new HttpError(400, 'invalid account id');
  return raw;
};

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

const detail = async (store: Store, r: Ranking, via: Role) => ({
  ...r,
  accounts: (await store.listAccounts(r.id)).map((a) => ({ displayId: a.displayId, addedAt: a.addedAt })),
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
  return { status: 200, body: await detail(ctx.deps.store, { ...ranking, state: 'deleted' }, via) };
};

// 雀魂アカウントの指定は表示用 ID を保存するだけで、雀魂に要求しない
const addAccount: Handler = async (ctx, [id, rawDisplayId]) => {
  const { via, ranking } = await authorize(ctx.user, 'setAccounts', id!, ctx.deps.store);
  const displayId = readDisplayId(rawDisplayId!);
  const added = await ctx.deps.store.addAccount(ranking.id, {
    displayId,
    addedBy: ctx.user.sub,
    addedAt: ctx.deps.now().toISOString(),
  });
  if (added) await log(ctx, ranking.id, via, 'addAccount', displayId);
  return { status: added ? 201 : 200, body: await detail(ctx.deps.store, ranking, via) };
};

const removeAccount: Handler = async (ctx, [id, rawDisplayId]) => {
  const { via, ranking } = await authorize(ctx.user, 'setAccounts', id!, ctx.deps.store);
  const displayId = readDisplayId(rawDisplayId!);
  if (await ctx.deps.store.removeAccount(ranking.id, displayId)) {
    await log(ctx, ranking.id, via, 'removeAccount', displayId);
  }
  return { status: 200, body: await detail(ctx.deps.store, ranking, via) };
};

const listLogs: Handler = async (ctx, [id]) => {
  const { ranking } = await authorize(ctx.user, 'viewLogs', id!, ctx.deps.store);
  return { status: 200, body: { logs: await ctx.deps.store.listLogs(ranking.id, LOG_LIMIT) } };
};

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ['GET', /^\/api\/me$/, me],
  ['GET', /^\/api\/rankings$/, listRankings],
  ['POST', /^\/api\/rankings$/, createRanking],
  ['GET', new RegExp(`^/api/rankings/${RANKING_ID}$`), getRanking],
  ['PATCH', new RegExp(`^/api/rankings/${RANKING_ID}$`), renameRanking],
  ['DELETE', new RegExp(`^/api/rankings/${RANKING_ID}$`), deleteRanking],
  ['PUT', new RegExp(`^/api/rankings/${RANKING_ID}/accounts/([^/]+)$`), addAccount],
  ['DELETE', new RegExp(`^/api/rankings/${RANKING_ID}/accounts/([^/]+)$`), removeAccount],
  ['GET', new RegExp(`^/api/rankings/${RANKING_ID}/logs$`), listLogs],
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
