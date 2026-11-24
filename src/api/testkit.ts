// API のテストの共通の準備。メモリの Store と S3、偽の雀魂（実在の対局・ニックネームは使わない）。

import type { Session } from '../collector/index.ts';
import type { User } from './authorize.ts';
import { MemoryBlobs } from './blobs.ts';
import { HttpError } from './errors.ts';
import { createHandler, type FunctionUrlEvent } from './handler.ts';
import type { OpenMajsoul } from './jobs.ts';
import { MemoryStore } from './memory-store.ts';

export const event = (
  method: string,
  rawPath: string,
  opts: { token?: string; body?: unknown; base64?: boolean; query?: Record<string, string> } = {},
): FunctionUrlEvent => {
  const text = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: opts.token ? { 'x-auth-token': opts.token } : {},
    ...(opts.query ? { queryStringParameters: opts.query } : {}),
    ...(text !== undefined
      ? opts.base64
        ? { body: Buffer.from(text).toString('base64'), isBase64Encoded: true }
        : { body: text, isBase64Encoded: false }
      : {}),
  };
};

// トークンの代わりに利用者の名前をそのまま送る（JWT の検証は jwt.test.ts）
export const USERS: Record<string, User> = {
  admin: { sub: 'sub-admin', groups: ['admins', 'pool_Discord'] },
  host: { sub: 'sub-host', groups: ['pool_Discord'] },
  stranger: { sub: 'sub-stranger', groups: ['pool_Discord'] },
};

/** 偽の雀魂。表示用 ID → 内部 ID、内部 ID ごとの友人戦の一覧、牌譜（head） */
export class FakeMajsoul {
  readonly eids = new Map<number, number>();
  readonly lists = new Map<number, { '4p': any[]; '3p': any[] }>();
  readonly heads = new Map<string, Record<string, unknown>>();
  logins = 0;
  readonly calls: string[] = [];
  failLogin = false;

  /** 主催者の雀魂アカウントを作る */
  account(eid: number, internalId: number) {
    this.eids.set(eid, internalId);
    this.lists.set(internalId, { '4p': [], '3p': [] });
  }

  /**
   * 対局を足す。一覧の1件と牌譜を作り、listedBy の一覧に載せる。
   * players は席順に [名前, 内部 ID, 点数, total_point]
   */
  game(uuid: string, endSec: number, players: [string, number, number, number][], listedBy: number[]) {
    const mode = players.length === 4 ? '4p' : '3p';
    const order = players.map((p, seat) => ({ seat, pt: p[3] })).sort((a, b) => b.pt - a.pt || a.seat - b.seat);
    const listed = {
      uuid,
      start_time: endSec - 1800,
      end_time: endSec,
      tag: 2,
      sub_tag: 1,
      results: players.map(([nickname, account_id], seat) => ({
        ...(seat ? { seat } : {}),
        account_id,
        nickname,
        rank: order.findIndex((o) => o.seat === seat) + 1,
      })),
    };
    for (const id of listedBy) this.lists.get(id)![mode].push(listed);
    this.heads.set(uuid, {
      uuid,
      end_time: endSec,
      accounts: players.map(([nickname, account_id], seat) => ({ ...(seat ? { seat } : {}), account_id, nickname, avatar_id: 1 })),
      result: {
        players: players.map(([, , part_point_1, total_point], seat) => ({ ...(seat ? { seat } : {}), part_point_1, total_point })),
      },
    });
  }

  open: OpenMajsoul = async (notify) => {
    this.logins++;
    if (this.failLogin) {
      notify('ログインに失敗した');
      throw new Error('login failed');
    }
    const session: Session = {
      call: async (method, body) => {
        this.calls.push(method);
        if (method === 'Lobby.searchAccountByEid') return { account_id: this.eids.get(body.eid as number) };
        if (method === 'Lobby.fetchAccountInfoExtra') {
          const list = this.lists.get(body.account_id as number);
          return { recent_games: list ? list[body.category === 1 ? '4p' : '3p'] : [] };
        }
        if (method === 'Lobby.fetchGameRecordsDetail') {
          return { record_list: (body.uuid_list as string[]).map((u) => this.heads.get(u)).filter(Boolean) };
        }
        throw new Error(`unexpected ${method}`);
      },
      close() {},
      refreshed: { clientVersion: false, liqi: false },
    };
    return session;
  };
}

export const setup = () => {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const majsoul = new FakeMajsoul();
  const started: string[] = [];
  let n = 0;
  let clock = Date.parse('2026-11-25T00:00:00Z');
  const h = createHandler(() => ({
    store,
    blobs,
    now: () => new Date((clock += 1000)),
    newRankingId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    newPublicId: () => `public-${++n}`,
    newLogSuffix: () => `s${++n}`,
    newJobId: () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    startJob: async (jobId) => {
      started.push(jobId);
    },
    openMajsoul: majsoul.open,
    sleep: async (ms) => {
      clock += ms;
    },
    verifyToken: async (token) => {
      const user = USERS[token];
      if (!user) throw new HttpError(401, 'unauthorized');
      return user;
    },
  }));
  const call = async (...args: Parameters<typeof event>) => {
    const res = await h(event(...args));
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  };
  /** 起動を頼まれたジョブを順に処理する */
  const runStarted = async () => {
    while (started.length) await h({ source: 'job', jobId: started.shift()! });
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, blobs, majsoul, started, h, call, runStarted, advance };
};
