// API の呼び出し（docs/architecture.md「API」）。
// トークンは x-auth-token、GET 以外は本文の SHA-256 を x-amz-content-sha256 に付ける（CloudFront の OAC の署名。docs/deploy.md「API と OAC」）。

import type { PERMISSIONS } from '../../../src/api/authorize.ts';
import type { MergedCandidate } from '../../../src/api/games.ts';
import type { GameState, Job, LogEntry, Ranking, RankingSummary } from '../../../src/api/store.ts';
import { accessToken, refreshTokens } from './auth.ts';

export type { GameState, Job, LogEntry, MergedCandidate, Ranking, RankingSummary };

export type Role = 'admin' | 'host';
export type Permissions = typeof PERMISSIONS;
export type Operation = keyof Permissions;

/** 本人の申請（タスク 023）。申請していなければ無い */
export interface MyProfile {
  name: string;
  note: string;
  status: 'pending' | 'approved';
  appliedAt: string;
}

export interface Me {
  sub: string;
  admin: boolean;
  permissions: Record<Operation, { scope: 'global' | 'ranking'; roles: readonly Role[] }>;
  profile?: MyProfile;
}

/** 管理人が見る利用者（Cognito の利用者に、申請の内容を合わせたもの） */
export interface UserRow {
  sub: string;
  discordId: string | null;
  createdAt: string;
  admin: boolean;
  name?: string;
  note?: string;
  status?: 'pending' | 'approved';
  appliedAt?: string;
  rankingIds: string[];
}

/** ランキングの主催者（Host） */
export interface HostView {
  sub: string;
  name?: string;
  discordId?: string;
  addedAt: string;
}

/** 管理人の一覧では、雀魂アカウントの数が付く */
export type RankingListItem = RankingSummary & { accountCount?: number };

/** ランキングの雀魂アカウント。内部 ID か、表示用 ID で指定してまだ確かめていない仮の項目（pendingId）。表示用 ID は来ない */
export interface AccountView {
  internalId?: string;
  pendingId?: string;
  name?: string;
  lastRefreshedAt?: string;
  addedAt: string;
}

export interface RankingDetail extends Ranking {
  accounts: AccountView[];
  via: Role;
}

export type GamesAccount = AccountView;

/** ランキングの対局の参加者（雀魂アカウントを選んで指定する） */
export interface Player {
  internalId: string;
  name: string;
  games: number;
}

export type GameListState = 'candidate' | 'imported' | 'excluded';

export type GamesResponse =
  | { state: 'candidate'; accounts: GamesAccount[]; games: MergedCandidate[] }
  | { state: 'imported' | 'excluded'; accounts: GamesAccount[]; games: GameState[] };

/** API の失敗。message は画面にそのまま出せる文 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(errorMessage(status, detail));
    this.status = status;
    this.detail = detail;
  }
}

/** ログインし直しが要る（トークンが無い・取り直せない） */
export class LoginRequired extends Error {
  constructor() {
    super('ログインしてください。');
  }
}

/** API の応答の誤りを、利用者向けの文に直す */
export function errorMessage(status: number, detail: string): string {
  switch (status) {
    case 400:
      if (detail === 'no accounts') return '雀魂アカウントが指定されていません。設定で指定してください。';
      if (detail.startsWith('name')) return '名前は1〜100文字で入れてください。';
      if (detail.startsWith('note')) return 'ひとことは500文字までにしてください。';
      if (detail === 'user is not approved') return '承認していない人は、主催者に付けられません。先に「利用者」で承認してください。';
      if (detail === 'cannot delete admin' || detail === 'admin cannot delete self') return '管理人は、この画面からは消せません。';
      if (detail === 'invalid account id') return '雀魂の ID は数字で入れてください。';
      if (detail.startsWith('not candidates')) return '候補にない対局が含まれています。一覧を読み直してください。';
      if (detail.startsWith('at most')) return '一度に取り込めるのは100件までです。';
      return `入力に誤りがあります（${detail}）。`;
    case 401:
      return 'ログインしてください。';
    case 403:
      return 'この操作をする権限がありません。';
    case 404:
      return '見つかりません。削除されたか、見る権限がありません。';
    case 429:
      return '少し前に更新したばかりです。少し時間をおいてから、もう一度押してください。';
    default:
      return `うまくいきませんでした（${status}）。時間をおいて、もう一度試してください。`;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 要求のヘッダー */
export async function requestHeaders(token: string, method: string, text: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'x-auth-token': token };
  if (method !== 'GET' && method !== 'HEAD') headers['x-amz-content-sha256'] = await sha256Hex(text);
  if (text) headers['content-type'] = 'application/json';
  return headers;
}

async function send(token: string, method: string, path: string, text: string): Promise<Response> {
  return fetch(path, { method, headers: await requestHeaders(token, method, text), ...(text ? { body: text } : {}) });
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? '' : JSON.stringify(body);
  let token = await accessToken();
  if (!token) throw new LoginRequired();
  let res = await send(token, method, path, text);
  if (res.status === 401) {
    // 期限の前でも無効になっていることがある。1回だけ取り直してやり直す
    token = (await refreshTokens())?.access_token ?? null;
    if (!token) throw new LoginRequired();
    res = await send(token, method, path, text);
    if (res.status === 401) throw new LoginRequired();
  }
  const resText = await res.text();
  let json: unknown = undefined;
  try {
    json = resText ? JSON.parse(resText) : undefined;
  } catch {
    // 本文が JSON でない（CloudFront の誤りの画面など）
  }
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string } | undefined)?.error ?? resText.slice(0, 200));
  return json as T;
}

const r = (id: string) => `/api/rankings/${encodeURIComponent(id)}`;

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  listRankings: () => call<{ rankings: RankingListItem[] }>('GET', '/api/rankings'),
  putMyProfile: (name: string, note: string) => call<{ profile: MyProfile }>('PUT', '/api/me/profile', { name, note }),
  deleteMe: () => call<{ deleted: true }>('DELETE', '/api/me'),
  listUsers: () => call<{ users: UserRow[] }>('GET', '/api/users'),
  approveUser: (sub: string) => call<{ approved: true }>('POST', `/api/users/${encodeURIComponent(sub)}/approve`),
  deleteUser: (sub: string) => call<{ deleted: true }>('DELETE', `/api/users/${encodeURIComponent(sub)}`),
  listHosts: (id: string) => call<{ hosts: HostView[] }>('GET', `${r(id)}/hosts`),
  addHost: (id: string, sub: string) => call<{ hosts: HostView[] }>('PUT', `${r(id)}/hosts/${encodeURIComponent(sub)}`),
  removeHost: (id: string, sub: string) => call<{ hosts: HostView[] }>('DELETE', `${r(id)}/hosts/${encodeURIComponent(sub)}`),
  createRanking: (name: string) => call<RankingDetail>('POST', '/api/rankings', { name }),
  getRanking: (id: string) => call<RankingDetail>('GET', r(id)),
  renameRanking: (id: string, name: string) => call<RankingDetail>('PATCH', r(id), { name }),
  deleteRanking: (id: string) => call<RankingDetail>('DELETE', r(id)),
  addAccount: (id: string, internalId: string) =>
    call<RankingDetail>('PUT', `${r(id)}/accounts/${encodeURIComponent(internalId)}`),
  /** 表示用 ID は URL に入れず、本文で送る */
  addAccountByDisplayId: (id: string, displayId: string) => call<RankingDetail>('POST', `${r(id)}/accounts`, { displayId }),
  removeAccount: (id: string, a: AccountView) =>
    call<RankingDetail>(
      'DELETE',
      a.internalId ? `${r(id)}/accounts/${encodeURIComponent(a.internalId)}` : `${r(id)}/accounts/pending/${encodeURIComponent(a.pendingId ?? '')}`,
    ),
  listPlayers: (id: string) => call<{ players: Player[] }>('GET', `${r(id)}/players`),
  listGames: (id: string, state: GameListState) => call<GamesResponse>('GET', `${r(id)}/games?state=${state}`),
  refresh: (id: string) => call<{ job: Job }>('POST', `${r(id)}/refresh`),
  importGames: (id: string, uuids: string[]) => call<{ job: Job }>('POST', `${r(id)}/import`, { uuids }),
  rebuild: (id: string) => call<{ job: Job }>('POST', `${r(id)}/rebuild`),
  exclude: (id: string, uuid: string) =>
    call<{ game: GameState }>('POST', `${r(id)}/games/${encodeURIComponent(uuid)}/exclude`),
  restore: (id: string, uuid: string) =>
    call<{ game: GameState }>('POST', `${r(id)}/games/${encodeURIComponent(uuid)}/restore`),
  regeneratePublicId: (id: string) => call<RankingDetail>('POST', `${r(id)}/public-id`),
  logs: (id: string) => call<{ logs: LogEntry[] }>('GET', `${r(id)}/logs`),
  job: (jobId: string) => call<{ job: Job }>('GET', `/api/jobs/${encodeURIComponent(jobId)}`),
};
