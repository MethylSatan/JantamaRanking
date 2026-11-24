import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createJwksFetcher, verifyCognitoToken, type Jwk } from './jwt.ts';
import { HttpError } from './errors.ts';

const issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TEST';
const clientId = 'client-123';
const NOW = 1_800_000_000_000;

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey, publicKey } = pair();
const jwk: Jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

const makeToken = (
  claims: Record<string, unknown> = {},
  { kid = 'k1', alg = 'RS256', key = privateKey }: { kid?: string; alg?: string; key?: KeyObject } = {},
) => {
  const payload = {
    sub: 'user-1',
    iss: issuer,
    token_use: 'access',
    client_id: clientId,
    exp: NOW / 1000 + 600,
    'cognito:groups': ['admins', 'ap-northeast-1_TEST_Discord'],
    ...claims,
  };
  const signingInput = `${b64({ kid, alg })}.${b64(payload)}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url')}`;
};

const opts = (keys: Jwk[] = [jwk]) => ({ issuer, clientId, getJwks: async () => keys, now: () => NOW });

const rejects401 = (p: Promise<unknown>) =>
  assert.rejects(p, (e) => e instanceof HttpError && e.status === 401);

test('正しいトークンから sub とグループを取る', async () => {
  const user = await verifyCognitoToken(makeToken(), opts());
  assert.deepEqual(user, { sub: 'user-1', groups: ['admins', 'ap-northeast-1_TEST_Discord'] });
});

test('グループが無ければ空', async () => {
  const user = await verifyCognitoToken(makeToken({ 'cognito:groups': undefined }), opts());
  assert.deepEqual(user.groups, []);
});

test('別の鍵の署名は拒む', async () => {
  await rejects401(verifyCognitoToken(makeToken({}, { key: pair().privateKey }), opts()));
});

test('中身を書き換えたトークンは拒む', async () => {
  const [h, , s] = makeToken().split('.');
  const forged = `${h}.${b64({ sub: 'other', iss: issuer, token_use: 'access', client_id: clientId, exp: NOW / 1000 + 600, 'cognito:groups': ['admins'] })}.${s}`;
  await rejects401(verifyCognitoToken(forged, opts()));
});

test('期限切れは拒む', async () => {
  await rejects401(verifyCognitoToken(makeToken({ exp: NOW / 1000 }), opts()));
  await rejects401(verifyCognitoToken(makeToken({ exp: undefined }), opts()));
});

test('発行者・token_use・client_id が違えば拒む', async () => {
  await rejects401(verifyCognitoToken(makeToken({ iss: 'https://example.com' }), opts()));
  await rejects401(verifyCognitoToken(makeToken({ token_use: 'id' }), opts()));
  await rejects401(verifyCognitoToken(makeToken({ client_id: 'other' }), opts()));
});

test('sub が無ければ拒む', async () => {
  await rejects401(verifyCognitoToken(makeToken({ sub: undefined }), opts()));
});

test('RS256 以外と none は拒む', async () => {
  await rejects401(verifyCognitoToken(makeToken({}, { alg: 'HS256' }), opts()));
  const [h, p] = makeToken({}, { alg: 'none' }).split('.');
  await rejects401(verifyCognitoToken(`${h}.${p}.`, opts()));
});

test('知らない kid は JWKS を取り直し、それでも無ければ拒む', async () => {
  const calls: boolean[] = [];
  const getJwks = async (refresh: boolean) => {
    calls.push(refresh);
    return refresh ? [jwk] : [];
  };
  assert.equal((await verifyCognitoToken(makeToken(), { ...opts(), getJwks })).sub, 'user-1');
  assert.deepEqual(calls, [false, true]);
  await rejects401(verifyCognitoToken(makeToken({}, { kid: 'unknown' }), opts()));
});

test('形の崩れたトークンは拒む', async () => {
  for (const t of ['', 'a.b', 'a.b.c', 'x.y.z.w', `${b64({ alg: 'RS256' })}.${b64({})}.x`]) {
    await rejects401(verifyCognitoToken(t, opts()));
  }
});

test('JWKS はキャッシュし、取り直しは間隔を空ける', async () => {
  let fetched = 0;
  let now = 0;
  const fetchFn = (async () => {
    fetched++;
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  const get = createJwksFetcher('https://example.com/jwks.json', fetchFn, () => now, 60_000);
  await get(false);
  await get(false);
  await get(true);
  assert.equal(fetched, 1);
  now = 60_000;
  await get(true);
  assert.equal(fetched, 2);
});
