// Web サービスの API（Lambda Function URL）の入口。CloudFront の /api/* から呼ばれる。
// 認証は x-auth-token ヘッダーの Cognito のアクセストークン（OAC が Authorization を上書きするため。docs/deploy.md「API と OAC」）。

import { randomBytes, randomUUID } from 'node:crypto';
import type { User } from './authorize.ts';
import { CognitoDirectory, createOpenMajsoul, createStartJob, S3Blobs } from './aws.ts';
import { HttpError } from './errors.ts';
import { newJob, runJob } from './jobs.ts';
import { createJwksFetcher, verifyCognitoToken } from './jwt.ts';
import { route, type Deps } from './routes.ts';
import { DynamoStore } from './store.ts';

/** Function URL のイベントのうち、使う部分だけ（ペイロード形式 2.0） */
export interface FunctionUrlEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandlerDeps extends Deps {
  /** トークンを確かめて利用者を返す。だめなら 401 の HttpError */
  verifyToken: (token: string) => Promise<User>;
}

const json = (statusCode: number, value: unknown): FunctionUrlResult => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(value),
});

const parseBody = (event: FunctionUrlEvent) => (): unknown => {
  if (!event.body) throw new HttpError(400, 'body is required');
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
};

/** 自分の Lambda の非同期の起動（ジョブ）と、定期取得（Scheduler）の入力 */
export type InternalEvent = { source: 'job'; jobId: string } | { source: 'scheduler'; action: 'refresh-candidates' };

const isInternal = (event: unknown): event is InternalEvent =>
  typeof event === 'object' && event !== null && 'source' in event && !('requestContext' in event);

export interface LambdaHandler {
  (event: FunctionUrlEvent): Promise<FunctionUrlResult>;
  (event: InternalEvent): Promise<void>;
}

export function createHandler(getDeps: () => HandlerDeps): LambdaHandler {
  const http = createHttpHandler(getDeps);
  return (async (event: FunctionUrlEvent | InternalEvent): Promise<FunctionUrlResult | void> => {
    if (!isInternal(event)) return http(event);
    const deps = getDeps();
    if (event.source === 'job') return runJob(deps, event.jobId);
    if (event.source === 'scheduler' && event.action === 'refresh-candidates') {
      const job = newJob(deps.newJobId(), 'refresh', { sub: 'scheduler', via: 'scheduler' }, deps.now());
      await deps.store.createJob(job);
      return runJob(deps, job.id);
    }
    throw new Error(`知らない入力: ${JSON.stringify(event)}`);
  }) as LambdaHandler;
}

function createHttpHandler(getDeps: () => HandlerDeps) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    try {
      if (path === '/api/health' && (method === 'GET' || method === 'HEAD')) {
        return json(200, { ok: true });
      }
      const matched = route(method, path);
      if (!matched) return json(404, { error: 'not found' });

      const deps = getDeps();
      const token = event.headers?.['x-auth-token'];
      if (!token) throw new HttpError(401, 'unauthorized');
      const user = await deps.verifyToken(token);

      const res = await matched.handler(
        { user, deps, body: parseBody(event), query: event.queryStringParameters ?? {} },
        matched.params,
      );
      return json(res.status, res.body ?? {});
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(`${method} ${path}`, e);
      return json(500, { error: 'internal error' });
    }
  };
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} がない`);
  return value;
};

// 本番の依存。最初の要求で作り、Lambda の実行環境が続く間は使い回す（JWKS のキャッシュも）
let prodDeps: HandlerDeps | undefined;
const getProdDeps = (): HandlerDeps => {
  if (prodDeps) return prodDeps;
  const region = process.env.AWS_REGION ?? 'ap-northeast-1';
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${env('USER_POOL_ID')}`;
  const clientId = env('USER_POOL_CLIENT_ID');
  const getJwks = createJwksFetcher(`${issuer}/.well-known/jwks.json`);
  const blobs = new S3Blobs(env('DATA_BUCKET'), env('SITE_BUCKET'));
  prodDeps = {
    store: new DynamoStore(env('TABLE_NAME')),
    directory: new CognitoDirectory(env('USER_POOL_ID')),
    blobs,
    newJobId: () => randomUUID(),
    startJob: createStartJob(env('AWS_LAMBDA_FUNCTION_NAME')),
    openMajsoul: createOpenMajsoul(blobs, env('SSM_PREFIX')),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    newRankingId: () => randomUUID(),
    newPublicId: () => randomBytes(16).toString('base64url'),
    newLogSuffix: () => randomBytes(4).toString('hex'),
    verifyToken: (token) => verifyCognitoToken(token, { issuer, clientId, getJwks, now: Date.now }),
  };
  return prodDeps;
};

export const handler = createHandler(getProdDeps);
