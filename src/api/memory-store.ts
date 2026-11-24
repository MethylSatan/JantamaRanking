// テスト用の Store。DynamoDB の項目を pk/sk の Map で真似る（keys は本番と同じ）。

import { keys, type LogEntry, type Ranking, type RankingAccount, type Store } from './store.ts';

type Item = Record<string, any>;

export class MemoryStore implements Store {
  readonly items = new Map<string, Item>();

  private id = (k: { pk: string; sk: string }) => `${k.pk}\u0000${k.sk}`;
  private get(k: { pk: string; sk: string }) {
    return this.items.get(this.id(k));
  }
  private put(k: { pk: string; sk: string }, value: Item) {
    this.items.set(this.id(k), { ...k, ...structuredClone(value) });
  }
  /** pk が一致し sk が prefix で始まる項目を sk の昇順で */
  private query(pk: string, prefix: string): Item[] {
    return [...this.items.values()]
      .filter((i) => i.pk === pk && String(i.sk).startsWith(prefix))
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
  }

  /** テスト用: Host を付ける（Host の項目と逆向きの項目） */
  addHost(rankingId: string, sub: string) {
    this.put(keys.member(rankingId, sub), { role: 'host', addedBy: 'test', addedAt: 'test' });
    this.put(keys.userRanking(sub, rankingId), { role: 'host' });
  }

  async getRanking(id: string) {
    const item = this.get(keys.ranking(id));
    if (!item) return undefined;
    const { pk: _pk, sk: _sk, ...rest } = item;
    return structuredClone(rest) as Ranking;
  }

  async createRanking(r: Ranking) {
    if (this.get(keys.ranking(r.id))) throw new Error('ConditionalCheckFailed');
    this.put(keys.ranking(r.id), r);
    this.put(keys.rankingListEntry(r.id), { id: r.id, name: r.name, state: r.state });
  }

  async updateRanking(id: string, changes: Partial<Pick<Ranking, 'name' | 'state'>>) {
    const meta = this.get(keys.ranking(id));
    const entry = this.get(keys.rankingListEntry(id));
    if (!meta || !entry) throw new Error('ConditionalCheckFailed');
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      meta[k] = v;
      entry[k] = v;
    }
  }

  async listAllRankings() {
    return this.query('RANKINGS', 'RANKING#').map((i) => ({ id: i.id, name: i.name, state: i.state }));
  }

  async listRankingIdsForUser(sub: string) {
    return this.query(`USER#${sub}`, 'RANKING#').map((i) => String(i.sk).slice('RANKING#'.length));
  }

  async isHost(rankingId: string, sub: string) {
    return this.get(keys.member(rankingId, sub))?.role === 'host';
  }

  async addAccount(rankingId: string, a: RankingAccount) {
    const k = keys.account(rankingId, a.displayId);
    if (this.get(k)) return false;
    this.put(k, a);
    return true;
  }

  async removeAccount(rankingId: string, displayId: string) {
    return this.items.delete(this.id(keys.account(rankingId, displayId)));
  }

  async listAccounts(rankingId: string) {
    return this.query(`RANKING#${rankingId}`, 'ACCOUNT#').map(({ pk: _pk, sk: _sk, ...rest }) => rest as RankingAccount);
  }

  async appendLog(rankingId: string, entry: LogEntry, suffix: string) {
    const k = keys.log(rankingId, entry.at, suffix);
    if (this.get(k)) throw new Error('ConditionalCheckFailed');
    this.put(k, entry);
  }

  async listLogs(rankingId: string, limit: number) {
    return this.query(`RANKING#${rankingId}`, 'LOG#')
      .reverse()
      .slice(0, limit)
      .map(({ pk: _pk, sk: _sk, ...rest }) => rest as LogEntry);
  }
}
