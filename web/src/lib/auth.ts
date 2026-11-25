// ログイン（Cognito の Hosted UI、Discord、認可コード＋PKCE）とトークンの保存・取り直し。
// トークンは sessionStorage の `tokens` に置く（タブを閉じたらログインし直し）。
// src/apicheck/cli.ts の login がこのキーと #login のボタンを使うので、名前を変えるときは合わせる。

// Cognito のアプリクライアント（秘密ではない）と、ログイン画面のドメイン（terraform output の user_pool_client_id / auth_domain）
export const CLIENT_ID = '5f11ktadqh8u5sfeej8r3j5k2v';
export const AUTH_ORIGIN = 'https://jantama-ranking-auth.methylsatan.com';

const TOKENS_KEY = 'tokens';
const PKCE_KEY = 'pkce';
/** 期限のこの時間前から取り直す */
const REFRESH_MARGIN_MS = 60_000;

export interface Tokens {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomString = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** PKCE の code_challenge（S256） */
export const codeChallenge = async (verifier: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

/** JWT の中身（署名は確かめない。表示と期限の判断だけに使う） */
export function decodeJwt(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/** アクセストークンの期限（epoch ms）。読めなければ 0 */
export function expiresAt(tokens: Tokens): number {
  try {
    const exp = decodeJwt(tokens.access_token).exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export const needsRefresh = (tokens: Tokens, now: number): boolean => expiresAt(tokens) - REFRESH_MARGIN_MS <= now;

const redirectUri = () => location.origin + location.pathname;

export function loadTokens(): Tokens | null {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? 'null');
  } catch {
    return null;
  }
}

const saveTokens = (tokens: Tokens) => sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));

export async function startLogin(): Promise<void> {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    identity_provider: 'Discord',
    scope: 'openid',
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  location.assign(`${AUTH_ORIGIN}/oauth2/authorize?${params}`);
}

export function logout(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  const params = new URLSearchParams({ client_id: CLIENT_ID, logout_uri: location.origin + '/' });
  location.assign(`${AUTH_ORIGIN}/logout?${params}`);
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${AUTH_ORIGIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error(`ログインの情報を受け取れませんでした（${res.status}）`);
  return res.json();
}

/**
 * ログインの画面から戻ってきたときの処理。戻ってきたのでなければ false。
 * 失敗したら Error を投げる（文は画面にそのまま出す）
 */
export async function handleRedirect(): Promise<boolean> {
  const query = new URLSearchParams(location.search);
  if (!query.has('code') && !query.has('error')) return false;
  history.replaceState(null, '', location.pathname + location.hash);
  if (query.has('error')) {
    throw new Error(`ログインできませんでした: ${query.get('error_description') ?? query.get('error')}`);
  }
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string } | null;
  sessionStorage.removeItem(PKCE_KEY);
  if (!saved || saved.state !== query.get('state')) {
    throw new Error('ログインできませんでした。もう一度ログインしてください。');
  }
  saveTokens(
    await tokenRequest({
      grant_type: 'authorization_code',
      code: query.get('code')!,
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier,
    }),
  );
  return true;
}

let refreshing: Promise<Tokens | null> | null = null;

/** リフレッシュトークンで取り直す。できなければ保存を消して null */
export function refreshTokens(): Promise<Tokens | null> {
  refreshing ??= (async () => {
    const current = loadTokens();
    try {
      if (!current?.refresh_token) throw new Error('no refresh token');
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh_token });
      // 取り直しの応答にはリフレッシュトークンが入らない
      const merged = { ...current, ...fresh, refresh_token: fresh.refresh_token ?? current.refresh_token };
      saveTokens(merged);
      return merged;
    } catch {
      sessionStorage.removeItem(TOKENS_KEY);
      return null;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** 使えるアクセストークン。期限が近ければ取り直す。ログインしていなければ null */
export async function accessToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (!needsRefresh(tokens, Date.now())) return tokens.access_token;
  return (await refreshTokens())?.access_token ?? null;
}
