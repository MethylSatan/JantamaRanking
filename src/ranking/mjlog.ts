// downloadlogs 由来の mjlog 形式（ver 2.3）の牌譜 json から、対局の結果を取り出す。
// 前期（Tampermonkey の downloadlogs）と後期（PaifuImporter の parse()）の両方に共通の項目だけを読む。
import type { GameResult, Mode, PlayerResult } from './types.ts';
import { rankPlayers } from './rank.ts';

export interface Mjlog {
  ref: string;
  ratingc: string;
  name: string[];
  sc: number[];
  title: string[];
}

/** `2024/12/23 0:19:41`（日本時間）を epoch ms にする */
export function parseJstTitle(s: string): number {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`unexpected title[1]: ${s}`);
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, mi, se);
}

export function fromMjlog(json: Mjlog): GameResult {
  let mode: Mode;
  if (json.ratingc === 'PF4') mode = '4p';
  else if (json.ratingc === 'PF3') mode = '3p';
  else throw new Error(`unexpected ratingc: ${json.ratingc}`);

  const seats = mode === '4p' ? 4 : 3;
  const players: Omit<PlayerResult, 'rank'>[] = [];
  for (let seat = 0; seat < seats; seat++) {
    players.push({
      seat,
      name: json.name[seat],
      score: json.sc[2 * seat],
      pt: json.sc[2 * seat + 1],
    });
  }
  return {
    uuid: json.ref,
    endTime: parseJstTitle(json.title[1]),
    mode,
    players: rankPlayers(players),
  };
}
