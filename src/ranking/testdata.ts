// テスト用の架空のデータを作る補助。実在の対局・ニックネームは使わない。
import type { GameResult, Mode } from './types.ts';
import { parseJstTitle, type Mjlog } from './mjlog.ts';
import { rankPlayers } from './rank.ts';

let seq = 0;

/** 四麻: ウマ 5-15、三麻: ウマ 0-15、オカなし（旧シートの部屋の設定）で pt を計算した対局 */
export function game(jst: string, players: Array<[string, number] | [string, number, number]>, mode?: Mode): GameResult {
  const m: Mode = mode ?? (players.length === 4 ? '4p' : '3p');
  const base = m === '4p' ? 25000 : 35000;
  const uma = m === '4p' ? [15, 5, -5, -15] : [15, 0, -15];
  // 同点は席順で上（雀魂と同じ）
  const order = players.map((p, seat) => ({ score: p[1], seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
  const ranked = rankPlayers(
    players.map(([name, score, accountId], seat) => {
      const r = order.findIndex((o) => o.seat === seat);
      return { seat, name, score, accountId, pt: Math.round(((score - base) / 1000 + uma[r]) * 10) / 10 };
    }),
  );
  return { uuid: `test-${++seq}`, endTime: parseJstTitle(jst), mode: m, players: ranked };
}

export function mjlog4p(): Mjlog {
  return {
    ref: '240101-00000000-0000-0000-0000-000000000001',
    ratingc: 'PF4',
    name: ['うさぎ', 'かめ', 'きつね', 'たぬき'],
    sc: [22000, -8, 41000, 31, 30000, 10, 7000, -33],
    title: ['友人戦東喰赤: 12345', '2024/1/2 0:19:41'],
  };
}

export function mjlog3p(): Mjlog {
  return {
    ref: '240101-00000000-0000-0000-0000-000000000002',
    ratingc: 'PF3',
    name: ['うさぎ', 'かめ', 'きつね', ''],
    sc: [41000, 21, 28200, -21.8, 35800, 0.8, 0, 0],
    title: ['三友人戦赤: 12345', '2024/12/23 0:33:14'],
  };
}
