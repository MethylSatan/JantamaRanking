// できる操作の判断（ボタンの出し分けだけ。判断は必ず API で行う）。
// 表は GET /api/me の permissions（src/api/authorize.ts の PERMISSIONS）。

import type { Me, Operation, Role } from './api.ts';

/** ランキングに付かない操作（ランキングの作成など）。Admin だけ */
export function canGlobal(me: Me, op: Operation): boolean {
  const p = me.permissions[op];
  return p !== undefined && me.admin && p.roles.includes('admin');
}

/** ランキングに付く操作。役割はランキングの via（Admin なら admin） */
export function canOnRanking(me: Me, via: Role, op: Operation): boolean {
  const p = me.permissions[op];
  return p !== undefined && p.scope === 'ranking' && p.roles.includes(via);
}
