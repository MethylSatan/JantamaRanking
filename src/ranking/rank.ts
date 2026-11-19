import type { PlayerResult } from './types.ts';

/**
 * 順位をつける。pt の大きい順。pt が同じなら席順（東家が上）。
 * 雀魂は同点でも順位どおりに違うウマをつけるので、ふつう pt は同じにならない。
 */
export function rankPlayers(players: Omit<PlayerResult, 'rank'>[]): PlayerResult[] {
  const order = [...players].sort((a, b) => b.pt - a.pt || a.seat - b.seat);
  return players.map((p) => ({ ...p, rank: order.indexOf(p) + 1 }));
}
