// 画面に出す文の組み立て（日時、対局の種類、操作ログ、処理の結果）。

import type { Job, LogEntry } from './api.ts';

const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** 日本時間の「2026/11/25 21:05」 */
export const formatDateTime = (t: number | string): string => dateTimeFormat.format(new Date(t));

export const modeLabel = (mode: string): string => (mode === '3p' ? '三麻' : mode === '4p' ? '四麻' : mode);

/** 一覧の sub_tag の一の位: 1 なら東風、2 なら半荘（src/collector/collect.ts の gameLength と同じ規則） */
export function lengthLabel(subTag: number): string {
  const d = subTag % 10;
  return d === 1 ? '東風' : d === 2 ? '半荘' : '';
}

/** pt を「+12.3」の形に */
export const formatPt = (pt: number): string => (pt > 0 ? '+' : '') + pt.toFixed(1);

const OP_LABELS: Record<string, string> = {
  createRanking: 'ランキングを作成',
  rename: '名前を変更',
  deleteRanking: 'ランキングを削除（非公開）',
  addAccount: '雀魂アカウントを指定',
  removeAccount: '雀魂アカウントを外す',
  refresh: '候補を更新',
  import: '取り込み',
  rebuild: '作り直し',
  exclude: '対象外にする',
  restore: '戻す',
  regeneratePublicId: '公開 URL を取り直し',
};

export const opLabel = (op: string): string => OP_LABELS[op] ?? op;

const STATE_LABELS: Record<string, string> = { candidate: '候補', imported: '取り込み済み', excluded: '対象外' };

/** 操作ログの内容を1行に */
export function logSummary(entry: LogEntry): string {
  const d = (entry.detail ?? {}) as Record<string, unknown>;
  switch (entry.op) {
    case 'rename':
      return `「${String(d.from)}」→「${String(d.to)}」`;
    case 'createRanking':
      return `「${String(d.name)}」`;
    case 'addAccount':
    case 'removeAccount':
      return `ID ${entry.target ?? ''}`;
    case 'exclude':
      return `${STATE_LABELS[String(d.from)] ?? String(d.from)}から`;
    case 'restore':
      return `${STATE_LABELS[String(d.to)] ?? String(d.to)}へ`;
    case 'refresh':
    case 'import':
    case 'rebuild':
      return d.error !== undefined ? `失敗: ${String(d.error)}` : jobLines({ kind: entry.op, result: d } as Pick<Job, 'kind' | 'result'>).join(' / ');
    default:
      return '';
  }
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 処理（ジョブ）の結果を、利用者向けの行に。警告は warnings に分ける */
export function jobSummary(job: Pick<Job, 'kind' | 'result' | 'status' | 'error'>): { lines: string[]; warnings: string[] } {
  const result = (job.result ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  for (const n of arr(result.notices)) warnings.push(`お知らせ: ${String(n)}`);
  if (job.kind === 'refresh') {
    for (const a of arr(result.accounts) as Record<string, unknown>[]) {
      if (a.error !== undefined) warnings.push(`雀魂アカウント ${String(a.displayId ?? a.internalId)}: 取得できませんでした（${String(a.error)}）`);
      for (const w of arr(a.warnings)) warnings.push(`雀魂アカウント ${String(a.displayId ?? a.internalId)}: ${String(w)}`);
    }
  }
  const lines = job.status === 'failed' ? [`失敗しました: ${job.error ?? ''}`] : jobLines(job);
  return { lines, warnings };
}

function jobLines(job: Pick<Job, 'kind' | 'result'>): string[] {
  const r = (job.result ?? {}) as Record<string, unknown>;
  switch (job.kind) {
    case 'refresh':
      return (arr(r.accounts) as Record<string, unknown>[])
        .filter((a) => a.error === undefined)
        .map((a) => {
          const ret = (a.returned ?? {}) as Record<string, number>;
          return `ID ${String(a.displayId ?? a.internalId)}: 四麻${ret['4p'] ?? 0}件・三麻${ret['3p'] ?? 0}件、新しい候補${Number(a.newCandidates ?? 0)}件`;
        });
    case 'import': {
      const lines = [`${arr(r.imported).length}件を取り込みました`];
      if (arr(r.skipped).length) lines.push(`${arr(r.skipped).length}件は先にほかの操作がされていたので、そのままにしました`);
      if (arr(r.missing).length) lines.push(`${arr(r.missing).length}件は雀魂から牌譜を取れませんでした`);
      if (arr(r.failed).length) lines.push(`${arr(r.failed).length}件は牌譜を読めませんでした`);
      return lines;
    }
    case 'rebuild': {
      const lines = [`${Number(r.games ?? 0)}件を作り直し、${Number(r.changed ?? 0)}件の結果が変わりました`];
      if (arr(r.failed).length) lines.push(`${arr(r.failed).length}件は作り直せませんでした`);
      return lines;
    }
    default:
      return [];
  }
}

/** 公開 URL（閲覧者の画面。タスク 027） */
export const publicUrl = (origin: string, publicId: string): string =>
  `${origin}/ranking.html?id=${encodeURIComponent(publicId)}`;
