// 牌譜（data バケットの records/）と、ランキングの JSON（site バケットの rankings/）の置き場所。
// 本番は S3（aws.ts）、テストはメモリ。

import type { RecordGameHead } from '../ranking/index.ts';

export interface Blobs {
  /** 牌譜（head）。無ければ undefined */
  getRecord(uuid: string): Promise<RecordGameHead | undefined>;
  putRecord(uuid: string, head: Record<string, unknown>): Promise<void>;
  /** ランキングの JSON を `rankings/<公開 ID>.json` に置く */
  putRankingJson(publicId: string, body: string): Promise<void>;
  deleteRankingJson(publicId: string): Promise<void>;
}

export class MemoryBlobs implements Blobs {
  readonly records = new Map<string, string>();
  readonly rankings = new Map<string, string>();

  async getRecord(uuid: string) {
    const s = this.records.get(uuid);
    return s === undefined ? undefined : (JSON.parse(s) as RecordGameHead);
  }

  async putRecord(uuid: string, head: Record<string, unknown>) {
    this.records.set(uuid, JSON.stringify(head));
  }

  async putRankingJson(publicId: string, body: string) {
    this.rankings.set(publicId, body);
  }

  async deleteRankingJson(publicId: string) {
    this.rankings.delete(publicId);
  }
}
