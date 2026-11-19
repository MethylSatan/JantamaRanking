// 日付の区切り。日本時間の朝6時で日を区切る（深夜の対局は前の日に数える）。
// 日付は `YYYY-MM-DD` の文字列で扱い、文字列の比較で前後を決める。

const DAY_START_HOUR = 6;
const JST_OFFSET_HOUR = 9;

/** 対局の終了時刻が属する日（6時区切り） */
export function businessDay(endTime: number): string {
  const d = new Date(endTime + (JST_OFFSET_HOUR - DAY_START_HOUR) * 3600_000);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM` */
export function businessMonth(endTime: number): string {
  return businessDay(endTime).slice(0, 7);
}

/** `YYYY` */
export function businessYear(endTime: number): string {
  return businessDay(endTime).slice(0, 4);
}

/** 期間。どちらの端も含む。省略した端は無制限 */
export interface Period {
  from?: string;
  to?: string;
}

export function inPeriod(endTime: number, period: Period): boolean {
  const day = businessDay(endTime);
  return (period.from === undefined || period.from <= day) && (period.to === undefined || day <= period.to);
}

export function yearPeriod(year: number): Period {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
