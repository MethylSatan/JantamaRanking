// 新方式の牌譜（雀魂の `RecordGame`。牌譜回収で保存する head）から、対局の結果を取り出す。
// protobufjs の toObject（defaults: false）の形なので、0 や空の項目は無いことがある。
import type { GameResult, Mode, PlayerResult } from './types.ts';
import { rankPlayers } from './rank.ts';

export interface RecordGameHead {
  uuid: string;
  /** 終了時刻（epoch 秒） */
  end_time?: number;
  accounts?: { seat?: number; account_id?: number; nickname?: string }[];
  result?: { players?: { seat?: number; part_point_1?: number; total_point?: number }[] };
}

export function fromRecordGame(head: RecordGameHead): GameResult {
  const results = head.result?.players ?? [];
  let mode: Mode;
  if (results.length === 4) mode = '4p';
  else if (results.length === 3) mode = '3p';
  else throw new Error(`unexpected number of players: ${results.length} (${head.uuid})`);
  if (!head.end_time) throw new Error(`end_time がない (${head.uuid})`);

  const accounts = new Map((head.accounts ?? []).map((a) => [a.seat ?? 0, a]));
  const players: Omit<PlayerResult, 'rank'>[] = results
    .map((r) => {
      const seat = r.seat ?? 0;
      const a = accounts.get(seat);
      const p: Omit<PlayerResult, 'rank'> = {
        seat,
        // accounts に無い席は AI（PaifuImporter の parse() と同じ扱い）
        name: a ? (a.nickname ?? '') : 'AI',
        score: r.part_point_1 ?? 0,
        pt: (r.total_point ?? 0) / 1000,
      };
      if (a?.account_id) p.accountId = a.account_id;
      return p;
    })
    .sort((x, y) => x.seat - y.seat);
  return {
    uuid: head.uuid,
    endTime: head.end_time * 1000,
    mode,
    players: rankPlayers(players),
  };
}
