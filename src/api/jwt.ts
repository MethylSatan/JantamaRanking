// Cognito のアクセストークン（JWT）の検証。依存を増やさないため node:crypto で書く。
// 確かめること: 署名（RS256、ユーザープールの JWKS）、発行者、token_use=access、client_id、期限。
// 手順は https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html

import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { User } from './authorize.ts';
import { HttpError } from './errors.ts';

export interface Jwk extends JsonWebKey {
  kid: string;
}

export interface VerifyOptions {
  /** https://cognito-idp.<リージョン>.amazonaws.com/<ユーザープール ID> */
  issuer: string;
  /** アプリクライアントの ID */
  clientId: string;
  /** JWKS の鍵。refresh が true なら取り直す（知らない kid のとき） */
  getJwks: (refresh: boolean) => Promise<Jwk[]>;
  /** 現在時刻（ミリ秒） */
  now: () => number;
}

const unauthorized = () => new HttpError(401, 'unauthorized');

const decodePart = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return value as Record<string, unknown>;
};

export async function verifyCognitoToken(token: string, opts: VerifyOptions): Promise<User> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized();
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodePart(h);
    payload = decodePart(p);
  } catch {
    throw unauthorized();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw unauthorized();

  let jwk = (await opts.getJwks(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await opts.getJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw unauthorized();

  let ok = false;
  try {
    const key: KeyObject = createPublicKey({ key: jwk, format: 'jwk' });
    ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw unauthorized();

  if (payload.iss !== opts.issuer) throw unauthorized();
  if (payload.token_use !== 'access') throw unauthorized();
  if (payload.client_id !== opts.clientId) throw unauthorized();
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= opts.now()) throw unauthorized();
  if (typeof payload.sub !== 'string' || payload.sub === '') throw unauthorized();

  const groups = payload['cognito:groups'];
  return {
    sub: payload.sub,
    groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
  };
}

/**
 * JWKS を取ってきてキャッシュする。取り直しは、前に取ってから minRefreshMs 経つまで行わない
 * （知らない kid のトークンを送り続けられても、Cognito を何度も呼ばない）。
 */
export function createJwksFetcher(
  url: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  minRefreshMs = 60_000,
): (refresh: boolean) => Promise<Jwk[]> {
  let cached: Jwk[] | undefined;
  let fetchedAt = 0;
  return async (refresh) => {
    if (cached && !(refresh && now() - fetchedAt >= minRefreshMs)) return cached;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`JWKS の取得に失敗: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    cached = body.keys ?? [];
    fetchedAt = now();
    return cached;
  };
}
