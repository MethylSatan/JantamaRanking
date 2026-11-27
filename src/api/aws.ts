// 本番の依存: S3（牌譜・雀魂のバージョンと定義・ランキングの JSON）、SSM（認証情報と定義の鍵）、自分の Lambda の非同期の起動。
// 置き場所は docs/architecture.md「データモデル」と docs/deploy.md。

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { openSession, type CollectorDeps, type Credentials, type StateKey } from '../collector/index.ts';
import type { RecordGameHead } from '../ranking/index.ts';
import type { Blobs } from './blobs.ts';
import { type Directory, type DirectoryUser } from './directory.ts';
import { ADMIN_GROUP } from './authorize.ts';
import type { OpenMajsoul } from './jobs.ts';

const isNotFound = (e: unknown) => e instanceof Error && (e.name === 'NoSuchKey' || e.name === 'NotFound');

async function getText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString('utf-8')) ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

const recordKey = (uuid: string) => `records/${uuid}.json`;
const rankingKey = (publicId: string) => `rankings/${publicId}.json`;
const STATE_KEYS: Record<StateKey, string> = { 'client-version': 'state/client-version.json', liqi: 'state/liqi.json' };

export class S3Blobs implements Blobs {
  private readonly s3: S3Client;
  private readonly dataBucket: string;
  private readonly siteBucket: string;

  constructor(dataBucket: string, siteBucket: string, s3 = new S3Client({})) {
    this.s3 = s3;
    this.dataBucket = dataBucket;
    this.siteBucket = siteBucket;
  }

  async getRecord(uuid: string) {
    const text = await getText(this.s3, this.dataBucket, recordKey(uuid));
    return text === null ? undefined : (JSON.parse(text) as RecordGameHead);
  }

  async putRecord(uuid: string, head: Record<string, unknown>) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.dataBucket,
      Key: recordKey(uuid),
      Body: JSON.stringify(head),
      ContentType: 'application/json',
    }));
  }

  async putRankingJson(publicId: string, body: string) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.siteBucket,
      Key: rankingKey(publicId),
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      // 取り込みのたびに変わるので、CloudFront・ブラウザに毎回確かめさせる
      CacheControl: 'no-cache',
    }));
  }

  async deleteRankingJson(publicId: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.siteBucket, Key: rankingKey(publicId) }));
  }

  /** collector の StateStore（雀魂のバージョンと定義） */
  stateStore(): CollectorDeps['store'] {
    return {
      get: (key) => getText(this.s3, this.dataBucket, STATE_KEYS[key]),
      put: async (key, value) => {
        await this.s3.send(new PutObjectCommand({
          Bucket: this.dataBucket,
          Key: STATE_KEYS[key],
          Body: value,
          ContentType: 'application/json',
        }));
      },
    };
  }
}

/** SSM のパラメーター名（接頭辞は SSM_PREFIX）。値は手で入れる（docs/deploy.md） */
export const SSM_NAMES = {
  credentials: 'majsoul-credentials',
  luaKey: 'liqi-lua-key',
} as const;

async function getSecret(ssm: SSMClient, name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM ${name} が空`);
  return value;
}

export function createOpenMajsoul(blobs: S3Blobs, ssmPrefix: string, ssm = new SSMClient({})): OpenMajsoul {
  return (notify) =>
    openSession({
      store: blobs.stateStore(),
      credentials: async () => {
        const c = JSON.parse(await getSecret(ssm, ssmPrefix + SSM_NAMES.credentials)) as Partial<Credentials>;
        if (!c.type || !c.code || !c.uid) throw new Error(`SSM ${SSM_NAMES.credentials} に type / code / uid がない`);
        return { type: c.type, code: c.code, uid: c.uid };
      },
      // 手元の lua-key.txt と同じく latin1 で読む（src/collector/cli.ts）
      luaKey: async () => Buffer.from((await getSecret(ssm, ssmPrefix + SSM_NAMES.luaKey)).trim(), 'latin1'),
      notify,
      log: (msg) => console.log(msg),
    });
}

/** 自分の Lambda を非同期で起動する（入力 {"source":"job","jobId":…}） */
export function createStartJob(functionName: string, lambda = new LambdaClient({})) {
  return async (jobId: string) => {
    await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ source: 'job', jobId })),
    }));
  };
}

const toDirectoryUser = (u: UserType): DirectoryUser | undefined => {
  const sub = u.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub || !u.Username) return undefined;
  return { sub, username: u.Username, createdAt: (u.UserCreateDate ?? new Date(0)).toISOString() };
};

/** Cognito のユーザープールの利用者（タスク 023）。数が小さい（上限50人）ので、一覧はその都度引く */
export class CognitoDirectory implements Directory {
  private readonly cognito: CognitoIdentityProviderClient;
  private readonly poolId: string;

  constructor(poolId: string, cognito = new CognitoIdentityProviderClient({})) {
    this.poolId = poolId;
    this.cognito = cognito;
  }

  private async list(filter?: string): Promise<DirectoryUser[]> {
    const users: DirectoryUser[] = [];
    let token: string | undefined;
    do {
      const res = await this.cognito.send(new ListUsersCommand({
        UserPoolId: this.poolId,
        AttributesToGet: ['sub'],
        ...(filter ? { Filter: filter } : {}),
        PaginationToken: token,
      }));
      for (const u of res.Users ?? []) {
        const d = toDirectoryUser(u);
        if (d) users.push(d);
      }
      token = res.PaginationToken;
    } while (token);
    return users;
  }

  listUsers() {
    return this.list();
  }

  async findUser(sub: string) {
    // sub は API が経路から受け取った UUID の形の値だけ（routes.ts）。念のため引用符を外す
    return (await this.list(`sub = "${sub.replace(/"/g, '')}"`))[0];
  }

  async listAdminSubs() {
    const subs: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.cognito.send(new ListUsersInGroupCommand({ UserPoolId: this.poolId, GroupName: ADMIN_GROUP, NextToken: token }));
      for (const u of res.Users ?? []) {
        const d = toDirectoryUser(u);
        if (d) subs.push(d.sub);
      }
      token = res.NextToken;
    } while (token);
    return subs;
  }

  async deleteUser(username: string) {
    await this.cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.poolId, Username: username }));
    await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.poolId, Username: username }));
  }
}
