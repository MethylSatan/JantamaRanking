// 集計の入力と出力の型。Lambda（取り込み時）と画面（絞り込み時）の両方で使う。

export type Mode = '4p' | '3p';

/** 1対局の1人分の結果 */
export interface PlayerResult {
  /** 席（0=東家） */
  seat: number;
  /** 雀魂のアカウント ID。旧方式の牌譜（mjlog）には無い */
  accountId?: number;
  /** その対局時点のニックネーム */
  name: string;
  /** 終局時の持ち点 */
  score: number;
  /** 雀魂が計算した最終の pt（total_point / 1000） */
  pt: number;
  /** 順位（1から） */
  rank: number;
}

/** 1対局の結果 */
export interface GameResult {
  /** 牌譜 uuid */
  uuid: string;
  /** 対局の終了時刻（epoch ms） */
  endTime: number;
  mode: Mode;
  /** 席順 */
  players: PlayerResult[];
}

/** ランキングの1行 */
export interface RankingRow {
  /** 1, 2, 3… と振る（同点でも同じ順位にしない） */
  rank: number;
  /** まとめるキー。`id:<accountId>` か `name:<ニックネーム>` */
  key: string;
  accountId?: number;
  /** 表示名（最新の対局の名前） */
  name: string;
  totalPt: number;
  avgPt: number;
  games: number;
  /** 1位の回数 */
  tops: number;
}
