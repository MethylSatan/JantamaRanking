// API のデータの読み書き（DynamoDB。テーブルは pk/sk、GSI なし）。
// 項目の形は docs/architecture.md「データモデル」と「ランキングごとの権限の持ち方」。

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';

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
}

export const keys = {
  ranking: (id: string) => ({ pk: `RANKING#${id}`, sk: 'META' }),
  rankingListEntry: (id: string) => ({ pk: 'RANKINGS', sk: `RANKING#${id}` }),
  member: (rankingId: string, sub: string) => ({ pk: `RANKING#${rankingId}`, sk: `MEMBER#${sub}` }),
  userRanking: (sub: string, rankingId: string) => ({ pk: `USER#${sub}`, sk: `RANKING#${rankingId}` }),
  account: (rankingId: string, displayId: string) => ({ pk: `RANKING#${rankingId}`, sk: `ACCOUNT#${displayId}` }),
  log: (rankingId: string, at: string, suffix: string) => ({ pk: `RANKING#${rankingId}`, sk: `LOG#${at}#${suffix}` }),
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
  e instanceof Error && e.name === 'ConditionalCheckFailedException';

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
    const fields = Object.entries(changes).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = fields.map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
    const update = {
      TableName: this.table,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
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
}
