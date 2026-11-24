// API のデータの読み書き（DynamoDB。テーブルは pk/sk、GSI なし）。
// 項目の形は docs/architecture.md「データモデル」と「ランキングごとの権限の持ち方」。

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Candidate } from '../collector/index.ts';
import type { GameResult } from '../ranking/index.ts';

export type RankingState = 'public' | 'deleted';

export interface Ranking {
  id: string;
  name: string;
  /** 公開の URL に使う、推測されない値（ランキング ID とは別） */
  publicId: string;
  state: RankingState;
  createdBy: string;
  createdAt: string;
}

export type RankingSummary = Pick<Ranking, 'id' | 'name' | 'state'>;

/** ランキングの雀魂アカウント。内部 ID は最初の候補の更新で引く（タスク 025） */
export interface RankingAccount {
  displayId: string;
  internalId?: string;
  addedBy: string;
  addedAt: string;
}

export interface LogEntry {
  at: string;
  sub: string;
  via: 'admin' | 'host';
  op: string;
  target?: string;
  detail?: Record<string, unknown>;
}

/** 雀魂アカウント（ランキングをまたいで共有。内部 ID で引く） */
export interface MajsoulAccount {
  internalId: string;
  /** 最後に候補を更新した時刻 */
  lastRefreshedAt?: string;
  /** 最後に候補の更新を受け付けた時刻（手動の更新の間隔に使う） */
  lastRequestedAt?: string;
  /** 一覧に出ていたニックネーム */
  name?: string;
}

/** 候補の対局（雀魂アカウントごと）。形は collector の Candidate のまま */
export type CandidateGame = Candidate;

export type GameStateKind = 'imported' | 'excluded';

/** ランキングごとの対局の状態。項目が無ければ候補 */
export interface GameState {
  uuid: string;
  state: GameStateKind;
  /** 取り込んだ対局の結果。候補から直接対象外にした対局には無い */
  result?: GameResult;
  changedBy: string;
  changedAt: string;
}

export type JobKind = 'refresh' | 'import' | 'rebuild';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: JobKind;
  /** 定期取得（Scheduler）のジョブには無い */
  rankingId?: string;
  status: JobStatus;
  /** 作った人の sub。定期取得は `scheduler` */
  createdBy: string;
  via: 'admin' | 'host' | 'scheduler';
  createdAt: string;
  updatedAt: string;
  /** 取り込む牌譜 uuid（import） */
  uuids?: string[];
  progress?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface Store {
  getRanking(id: string): Promise<Ranking | undefined>;
  createRanking(ranking: Ranking): Promise<void>;
  /** 名前・状態を変える。META と一覧用の項目を一緒に書く */
  updateRanking(id: string, changes: Partial<Pick<Ranking, 'name' | 'state'>>): Promise<void>;
  /** Admin 用。すべてのランキング */
  listAllRankings(): Promise<RankingSummary[]>;
  /** Host として付いているランキングの ID（逆向きの項目から） */
  listRankingIdsForUser(sub: string): Promise<string[]>;
  isHost(rankingId: string, sub: string): Promise<boolean>;
  /** すでにあれば何もせず false */
  addAccount(rankingId: string, account: RankingAccount): Promise<boolean>;
  /** 無ければ false */
  removeAccount(rankingId: string, displayId: string): Promise<boolean>;
  listAccounts(rankingId: string): Promise<RankingAccount[]>;
  appendLog(rankingId: string, entry: LogEntry, suffix: string): Promise<void>;
  /** 新しい順 */
  listLogs(rankingId: string, limit: number): Promise<LogEntry[]>;

  updatePublicId(rankingId: string, publicId: string): Promise<void>;
  /** 表示用 ID に内部 ID を書き、雀魂アカウント → ランキングと、定期取得用の一覧の項目を作る。表示用 ID が外されていたら false */
  linkAccount(rankingId: string, displayId: string, internalId: string): Promise<boolean>;
  getMajsoul(internalId: string): Promise<MajsoulAccount | undefined>;
  /** 定期取得用。登録されている雀魂アカウントの内部 ID */
  listMajsouls(): Promise<string[]>;
  /** その雀魂アカウントを指しているランキングの ID */
  listRankingIdsForMajsoul(internalId: string): Promise<string[]>;
  /** 前回の受け付けから minIntervalMs たっていれば、受け付けた時刻を書いて true */
  reserveRefresh(internalId: string, now: Date, minIntervalMs: number): Promise<boolean>;
  markRefreshed(internalId: string, at: string, name?: string): Promise<void>;
  /** 候補の対局を書く（同じ uuid は上書き） */
  putCandidates(internalId: string, games: CandidateGame[]): Promise<void>;
  listCandidates(internalId: string): Promise<CandidateGame[]>;
  listGameStates(rankingId: string): Promise<GameState[]>;
  getGameState(rankingId: string, uuid: string): Promise<GameState | undefined>;
  putGameState(rankingId: string, state: GameState): Promise<void>;
  deleteGameState(rankingId: string, uuid: string): Promise<void>;
  createJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | undefined>;
  updateJob(id: string, changes: Partial<Omit<Job, 'id'>>): Promise<void>;
  /** 状態が from のときだけ to にする（同じジョブが2回起動されても1回だけ動かす） */
  transitionJob(id: string, from: JobStatus, to: JobStatus, at: string): Promise<boolean>;
  /** 雀魂へ要求するためのロック。空いているか期限切れなら取って true */
  acquireLock(owner: string, nowMs: number, ttlMs: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
}

export const keys = {
  ranking: (id: string) => ({ pk: `RANKING#${id}`, sk: 'META' }),
  rankingListEntry: (id: string) => ({ pk: 'RANKINGS', sk: `RANKING#${id}` }),
  member: (rankingId: string, sub: string) => ({ pk: `RANKING#${rankingId}`, sk: `MEMBER#${sub}` }),
  userRanking: (sub: string, rankingId: string) => ({ pk: `USER#${sub}`, sk: `RANKING#${rankingId}` }),
  account: (rankingId: string, displayId: string) => ({ pk: `RANKING#${rankingId}`, sk: `ACCOUNT#${displayId}` }),
  log: (rankingId: string, at: string, suffix: string) => ({ pk: `RANKING#${rankingId}`, sk: `LOG#${at}#${suffix}` }),
  majsoul: (internalId: string) => ({ pk: `MAJSOUL#${internalId}`, sk: 'META' }),
  majsoulRanking: (internalId: string, rankingId: string) => ({ pk: `MAJSOUL#${internalId}`, sk: `RANKING#${rankingId}` }),
  majsoulListEntry: (internalId: string) => ({ pk: 'MAJSOULS', sk: `MAJSOUL#${internalId}` }),
  candidate: (internalId: string, uuid: string) => ({ pk: `MAJSOUL#${internalId}`, sk: `GAME#${uuid}` }),
  gameState: (rankingId: string, uuid: string) => ({ pk: `RANKING#${rankingId}`, sk: `GAME#${uuid}` }),
  job: (id: string) => ({ pk: `JOB#${id}`, sk: 'META' }),
  lock: () => ({ pk: 'LOCK', sk: 'MAJSOUL' }),
};

/** 項目から pk / sk を外す */
export const strip = <T>(item: Record<string, any>): T => {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as T;
};

const rankingFromItem = (item: Record<string, any>): Ranking => ({
  id: item.id,
  name: item.name,
  publicId: item.publicId,
  state: item.state,
  createdBy: item.createdBy,
  createdAt: item.createdAt,
});

const accountFromItem = (item: Record<string, any>): RankingAccount => ({
  displayId: item.displayId,
  ...(item.internalId ? { internalId: item.internalId } : {}),
  addedBy: item.addedBy,
  addedAt: item.addedAt,
});

const logFromItem = (item: Record<string, any>): LogEntry => ({
  at: item.at,
  sub: item.sub,
  via: item.via,
  op: item.op,
  ...(item.target !== undefined ? { target: item.target } : {}),
  ...(item.detail !== undefined ? { detail: item.detail } : {}),
});

const isConditionalFailure = (e: unknown) =>
  e instanceof Error && (e.name === 'ConditionalCheckFailedException' || e.name === 'TransactionCanceledException');

/** 更新の式を作る（undefined の項目は書かない） */
const setExpression = (changes: Record<string, unknown>) => {
  const fields = Object.entries(changes).filter(([, v]) => v !== undefined);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = fields.map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  return { empty: fields.length === 0, expr: `SET ${sets.join(', ')}`, names, values };
};

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(table: string, client: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
    this.table = table;
    this.doc = client;
  }

  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Record<string, any>[]> {
    const items: Record<string, any>[] = [];
    let start: Record<string, any> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ ...input, TableName: this.table, ExclusiveStartKey: start }));
      items.push(...(res.Items ?? []));
      start = res.LastEvaluatedKey;
    } while (start);
    return items;
  }

  async getRanking(id: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: keys.ranking(id) }));
    return res.Item ? rankingFromItem(res.Item) : undefined;
  }

  async createRanking(r: Ranking) {
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.table,
            Item: { ...keys.ranking(r.id), ...r },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: { ...keys.rankingListEntry(r.id), id: r.id, name: r.name, state: r.state },
          },
        },
      ],
    }));
  }

  async updateRanking(id: string, changes: Partial<Pick<Ranking, 'name' | 'state'>>) {
    const u = setExpression(changes);
    if (u.empty) return;
    const update = {
      TableName: this.table,
      UpdateExpression: u.expr,
      ExpressionAttributeNames: u.names,
      ExpressionAttributeValues: u.values,
      ConditionExpression: 'attribute_exists(pk)',
    };
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Update: { ...update, Key: keys.ranking(id) } },
        { Update: { ...update, Key: keys.rankingListEntry(id) } },
      ],
    }));
  }

  async listAllRankings() {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'RANKINGS' },
    });
    return items.map((i) => ({ id: i.id, name: i.name, state: i.state }) as RankingSummary);
  }

  async listRankingIdsForUser(sub: string) {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':prefix': 'RANKING#' },
    });
    return items.map((i) => String(i.sk).slice('RANKING#'.length));
  }

  async isHost(rankingId: string, sub: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: keys.member(rankingId, sub) }));
    return res.Item?.role === 'host';
  }

  async addAccount(rankingId: string, a: RankingAccount) {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { ...keys.account(rankingId, a.displayId), ...a },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return true;
    } catch (e) {
      if (isConditionalFailure(e)) return false;
      throw e;
    }
  }

  async removeAccount(rankingId: string, displayId: string) {
    const res = await this.doc.send(new DeleteCommand({
      TableName: this.table,
      Key: keys.account(rankingId, displayId),
      ReturnValues: 'ALL_OLD',
    }));
    const internalId = res.Attributes?.internalId as string | undefined;
    if (internalId) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: keys.majsoulRanking(internalId, rankingId) }));
      // どのランキングからも指されなくなったら、定期取得の一覧から外す
      if ((await this.listRankingIdsForMajsoul(internalId)).length === 0) {
        await this.doc.send(new DeleteCommand({ TableName: this.table, Key: keys.majsoulListEntry(internalId) }));
      }
    }
    return res.Attributes !== undefined;
  }

  async listAccounts(rankingId: string) {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `RANKING#${rankingId}`, ':prefix': 'ACCOUNT#' },
    });
    return items.map(accountFromItem);
  }

  async appendLog(rankingId: string, entry: LogEntry, suffix: string) {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { ...keys.log(rankingId, entry.at, suffix), ...entry },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  async listLogs(rankingId: string, limit: number) {
    const res = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `RANKING#${rankingId}`, ':prefix': 'LOG#' },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (res.Items ?? []).map(logFromItem);
  }

  async updatePublicId(rankingId: string, publicId: string) {
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: keys.ranking(rankingId),
      UpdateExpression: 'SET publicId = :p',
      ExpressionAttributeValues: { ':p': publicId },
      ConditionExpression: 'attribute_exists(pk)',
    }));
  }

  async linkAccount(rankingId: string, displayId: string, internalId: string) {
    try {
      await this.doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.table,
              Key: keys.account(rankingId, displayId),
              UpdateExpression: 'SET internalId = :i',
              ExpressionAttributeValues: { ':i': internalId },
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          { Put: { TableName: this.table, Item: { ...keys.majsoulRanking(internalId, rankingId), displayId } } },
          { Put: { TableName: this.table, Item: { ...keys.majsoulListEntry(internalId), internalId } } },
        ],
      }));
      return true;
    } catch (e) {
      if (isConditionalFailure(e)) return false;
      throw e;
    }
  }

  async getMajsoul(internalId: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: keys.majsoul(internalId) }));
    return res.Item ? { ...strip<MajsoulAccount>(res.Item), internalId } : undefined;
  }

  async listMajsouls() {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'MAJSOULS' },
    });
    return items.map((i) => String(i.sk).slice('MAJSOUL#'.length));
  }

  async listRankingIdsForMajsoul(internalId: string) {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `MAJSOUL#${internalId}`, ':prefix': 'RANKING#' },
    });
    return items.map((i) => String(i.sk).slice('RANKING#'.length));
  }

  async reserveRefresh(internalId: string, now: Date, minIntervalMs: number) {
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.table,
        Key: keys.majsoul(internalId),
        UpdateExpression: 'SET lastRequestedAt = :now',
        ConditionExpression: 'attribute_not_exists(lastRequestedAt) OR lastRequestedAt <= :cutoff',
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':cutoff': new Date(now.getTime() - minIntervalMs).toISOString(),
        },
      }));
      return true;
    } catch (e) {
      if (isConditionalFailure(e)) return false;
      throw e;
    }
  }

  async markRefreshed(internalId: string, at: string, name?: string) {
    const u = setExpression({ lastRefreshedAt: at, name });
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: keys.majsoul(internalId),
      UpdateExpression: u.expr,
      ExpressionAttributeNames: u.names,
      ExpressionAttributeValues: u.values,
    }));
  }

  async putCandidates(internalId: string, games: CandidateGame[]) {
    let requests = games.map((g) => ({ PutRequest: { Item: { ...keys.candidate(internalId, g.uuid), ...g } } }));
    // BatchWriteItem は25件ずつ。処理されなかった分は少し待ってやり直す
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 5) throw new Error('候補の対局を書き切れなかった');
      const rest: typeof requests = [];
      for (let i = 0; i < requests.length; i += 25) {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: requests.slice(i, i + 25) } }));
        rest.push(...((res.UnprocessedItems?.[this.table] ?? []) as typeof requests));
      }
      requests = rest;
      if (requests.length) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
  }

  async listCandidates(internalId: string) {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `MAJSOUL#${internalId}`, ':prefix': 'GAME#' },
    });
    return items.map((i) => strip<CandidateGame>(i));
  }

  async listGameStates(rankingId: string) {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `RANKING#${rankingId}`, ':prefix': 'GAME#' },
    });
    return items.map((i) => strip<GameState>(i));
  }

  async getGameState(rankingId: string, uuid: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: keys.gameState(rankingId, uuid) }));
    return res.Item ? strip<GameState>(res.Item) : undefined;
  }

  async putGameState(rankingId: string, state: GameState) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...keys.gameState(rankingId, state.uuid), ...state } }));
  }

  async deleteGameState(rankingId: string, uuid: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: keys.gameState(rankingId, uuid) }));
  }

  async createJob(job: Job) {
    await this.doc.send(new PutCommand({
      TableName: this.table,
      Item: { ...keys.job(job.id), ...job },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  async getJob(id: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: keys.job(id) }));
    return res.Item ? strip<Job>(res.Item) : undefined;
  }

  async updateJob(id: string, changes: Partial<Omit<Job, 'id'>>) {
    const u = setExpression(changes);
    if (u.empty) return;
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: keys.job(id),
      UpdateExpression: u.expr,
      ExpressionAttributeNames: u.names,
      ExpressionAttributeValues: u.values,
      ConditionExpression: 'attribute_exists(pk)',
    }));
  }

  async transitionJob(id: string, from: JobStatus, to: JobStatus, at: string) {
    try {
      await this.doc.send(new UpdateCommand({
        TableName: this.table,
        Key: keys.job(id),
        UpdateExpression: 'SET #s = :to, updatedAt = :at',
        ConditionExpression: '#s = :from',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':to': to, ':from': from, ':at': at },
      }));
      return true;
    } catch (e) {
      if (isConditionalFailure(e)) return false;
      throw e;
    }
  }

  async acquireLock(owner: string, nowMs: number, ttlMs: number) {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { ...keys.lock(), owner, expiresAt: nowMs + ttlMs },
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': nowMs },
      }));
      return true;
    } catch (e) {
      if (isConditionalFailure(e)) return false;
      throw e;
    }
  }

  async releaseLock(owner: string) {
    try {
      await this.doc.send(new DeleteCommand({
        TableName: this.table,
        Key: keys.lock(),
        ConditionExpression: '#o = :o',
        ExpressionAttributeNames: { '#o': 'owner' },
        ExpressionAttributeValues: { ':o': owner },
      }));
    } catch (e) {
      // 期限が切れて、別のジョブが取り直していた
      if (!isConditionalFailure(e)) throw e;
    }
  }
}
