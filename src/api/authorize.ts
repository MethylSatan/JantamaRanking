// 権限の判断を1か所にまとめる（docs/architecture.md「権限」）。
// 操作と、それを許す役割の表は、文書の「操作ごとの許可」と同じ形にする。画面はこの表を GET /api/me で受け取る。

import { HttpError } from './errors.ts';
import type { Ranking, Store } from './store.ts';

export type Role = 'admin' | 'host';

/** JWT から取った利用者 */
export interface User {
  sub: string;
  groups: string[];
}

/** Admin は Cognito のグループ admins で持つ */
export const ADMIN_GROUP = 'admins';

export const isAdmin = (user: User): boolean => user.groups.includes(ADMIN_GROUP);

/**
 * 操作ごとに許す役割。Host は自分が付いているランキングに限る。
 * scope が global の操作はランキングに付かない（Admin だけ）。
 * Admin の付け外しは CLI だけなので、表に入れない。
 */
export const PERMISSIONS = {
  createRanking: { scope: 'global', roles: ['admin'] },
  viewRanking: { scope: 'ranking', roles: ['admin', 'host'] },
  setAccounts: { scope: 'ranking', roles: ['admin', 'host'] },
  rename: { scope: 'ranking', roles: ['admin', 'host'] },
  deleteRanking: { scope: 'ranking', roles: ['admin'] },
  refresh: { scope: 'ranking', roles: ['admin', 'host'] },
  import: { scope: 'ranking', roles: ['admin', 'host'] },
  exclude: { scope: 'ranking', roles: ['admin', 'host'] },
  rebuild: { scope: 'ranking', roles: ['admin', 'host'] },
  viewLogs: { scope: 'ranking', roles: ['admin', 'host'] },
  publicUrl: { scope: 'ranking', roles: ['admin', 'host'] },
  manageHosts: { scope: 'ranking', roles: ['admin'] },
  manageUsers: { scope: 'global', roles: ['admin'] },
} as const satisfies Record<string, { scope: 'global' | 'ranking'; roles: readonly Role[] }>;

export type Operation = keyof typeof PERMISSIONS;
type ScopedOperation = { [K in Operation]: (typeof PERMISSIONS)[K]['scope'] extends 'ranking' ? K : never }[Operation];
type GlobalOperation = Exclude<Operation, ScopedOperation>;

const allows = (op: Operation, role: Role): boolean => (PERMISSIONS[op].roles as readonly Role[]).includes(role);

/** ランキングに付かない操作の判断。許さなければ 403 */
export function authorizeGlobal(user: User, op: GlobalOperation): { via: Role } {
  if (isAdmin(user) && allows(op, 'admin')) return { via: 'admin' };
  throw new HttpError(403, 'forbidden');
}

/**
 * ランキングに付く操作の判断。
 * ランキングが無い、または Admin でなく Host として付いていないときは 404（存在も知らせない）。
 * 付いているが表で許されないときは 403。
 */
export async function authorize(
  user: User,
  op: ScopedOperation,
  rankingId: string,
  store: Store,
): Promise<{ via: Role; ranking: Ranking }> {
  const admin = isAdmin(user);
  const [ranking, host] = await Promise.all([
    store.getRanking(rankingId),
    admin ? Promise.resolve(false) : store.isHost(rankingId, user.sub),
  ]);
  if (!ranking || !(admin || host)) throw new HttpError(404, 'not found');
  const role: Role = admin ? 'admin' : 'host';
  if (!allows(op, role)) throw new HttpError(403, 'forbidden');
  return { via: role, ranking };
}
