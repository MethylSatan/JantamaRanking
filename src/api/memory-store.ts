// テスト用の Store。DynamoDB の項目を pk/sk の Map で真似る（keys は本番と同じ）。

import {
  keys,
  strip,
  type CandidateGame,
  type GameState,
  type HostEntry,
  type Profile,
  type Job,
  type JobStatus,
  type LogEntry,
  type Ranking,
  type LinkedAccount,
  type PendingAccount,
  type RankingAccount,
  type Store,
} from './store.ts';

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

  /** Host を付ける（Host の項目と逆向きの項目）。テストでは sub だけ渡してもよい */
  async addHost(rankingId: string, host: HostEntry | string) {
    const h = typeof host === 'string' ? { sub: host, addedBy: 'test', addedAt: 'test' } : host;
    if (this.get(keys.member(rankingId, h.sub))) return false;
    this.put(keys.member(rankingId, h.sub), { role: 'host', addedBy: h.addedBy, addedAt: h.addedAt });
    this.put(keys.userRanking(h.sub, rankingId), { role: 'host' });
    return true;
  }

  async removeHost(rankingId: string, sub: string) {
    this.items.delete(this.id(keys.userRanking(sub, rankingId)));
    return this.items.delete(this.id(keys.member(rankingId, sub)));
  }

  async listHosts(rankingId: string) {
    return this.query(`RANKING#${rankingId}`, 'MEMBER#')
      .filter((i) => i.role === 'host')
      .map((i) => ({ sub: String(i.sk).slice('MEMBER#'.length), addedBy: i.addedBy, addedAt: i.addedAt }));
  }

  async getProfile(sub: string) {
    const item = this.get(keys.profile(sub));
    return item ? strip<Profile>(structuredClone(item)) : undefined;
  }

  async putProfile(sub: string, profile: Profile) {
    this.put(keys.profile(sub), profile);
  }

  async deleteProfile(sub: string) {
    this.items.delete(this.id(keys.profile(sub)));
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

  async addAccount(rankingId: string, a: LinkedAccount) {
    const k = keys.account(rankingId, a.internalId);
    if (this.get(k)) return false;
    this.put(k, a);
    this.put(keys.majsoulRanking(a.internalId, rankingId), {});
    this.put(keys.majsoulListEntry(a.internalId), { internalId: a.internalId });
    return true;
  }

  async addPendingAccount(rankingId: string, a: PendingAccount) {
    const k = keys.pendingAccount(rankingId, a.pendingId);
    if (this.get(k)) return false;
    this.put(k, a);
    return true;
  }

  async removePendingAccount(rankingId: string, pendingId: string) {
    return this.items.delete(this.id(keys.pendingAccount(rankingId, pendingId)));
  }

  async resolvePendingAccount(rankingId: string, pendingId: string, internalId: string, name?: string) {
    const k = keys.pendingAccount(rankingId, pendingId);
    const old = this.get(k);
    if (!old) return false;
    this.items.delete(this.id(k));
    await this.addAccount(rankingId, { internalId, ...(name !== undefined ? { name } : {}), addedBy: old.addedBy, addedAt: old.addedAt });
    return true;
  }

  async removeAccount(rankingId: string, internalId: string) {
    const k = keys.account(rankingId, internalId);
    if (!this.get(k)) return false;
    this.items.delete(this.id(k));
    this.items.delete(this.id(keys.majsoulRanking(internalId, rankingId)));
    if ((await this.listRankingIdsForMajsoul(internalId)).length === 0) {
      this.items.delete(this.id(keys.majsoulListEntry(internalId)));
    }
    return true;
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

  async updatePublicId(rankingId: string, publicId: string) {
    const meta = this.get(keys.ranking(rankingId));
    if (!meta) throw new Error('ConditionalCheckFailed');
    meta.publicId = publicId;
  }

  async getMajsoul(internalId: string) {
    const item = this.get(keys.majsoul(internalId));
    return item ? { ...strip<any>(structuredClone(item)), internalId } : undefined;
  }

  async listMajsouls() {
    return this.query('MAJSOULS', 'MAJSOUL#').map((i) => String(i.sk).slice('MAJSOUL#'.length));
  }

  async listRankingIdsForMajsoul(internalId: string) {
    return this.query(`MAJSOUL#${internalId}`, 'RANKING#').map((i) => String(i.sk).slice('RANKING#'.length));
  }

  async reserveRefresh(internalId: string, now: Date, minIntervalMs: number) {
    const k = keys.majsoul(internalId);
    const item = this.get(k) ?? {};
    const cutoff = new Date(now.getTime() - minIntervalMs).toISOString();
    if (item.lastRequestedAt !== undefined && item.lastRequestedAt > cutoff) return false;
    this.put(k, { ...strip(item), lastRequestedAt: now.toISOString() });
    return true;
  }

  async reservePendingRefresh(rankingId: string, pendingId: string, now: Date, minIntervalMs: number) {
    const item = this.get(keys.pendingAccount(rankingId, pendingId));
    if (!item) return true;
    const cutoff = new Date(now.getTime() - minIntervalMs).toISOString();
    if (item.lastRequestedAt !== undefined && item.lastRequestedAt > cutoff) return false;
    item.lastRequestedAt = now.toISOString();
    return true;
  }

  async markRefreshed(internalId: string, at: string, name?: string) {
    const k = keys.majsoul(internalId);
    const item = this.get(k) ?? {};
    this.put(k, { ...strip(item), lastRefreshedAt: at, ...(name !== undefined ? { name } : {}) });
  }

  async putCandidates(internalId: string, games: CandidateGame[]) {
    for (const g of games) this.put(keys.candidate(internalId, g.uuid), g);
  }

  async listCandidates(internalId: string) {
    return this.query(`MAJSOUL#${internalId}`, 'GAME#').map((i) => strip<CandidateGame>(structuredClone(i)));
  }

  async listGameStates(rankingId: string) {
    return this.query(`RANKING#${rankingId}`, 'GAME#').map((i) => strip<GameState>(structuredClone(i)));
  }

  async getGameState(rankingId: string, uuid: string) {
    const item = this.get(keys.gameState(rankingId, uuid));
    return item ? strip<GameState>(structuredClone(item)) : undefined;
  }

  async putGameState(rankingId: string, state: GameState) {
    this.put(keys.gameState(rankingId, state.uuid), state);
  }

  async deleteGameState(rankingId: string, uuid: string) {
    this.items.delete(this.id(keys.gameState(rankingId, uuid)));
  }

  async createJob(job: Job) {
    if (this.get(keys.job(job.id))) throw new Error('ConditionalCheckFailed');
    this.put(keys.job(job.id), job);
  }

  async getJob(id: string) {
    const item = this.get(keys.job(id));
    return item ? strip<Job>(structuredClone(item)) : undefined;
  }

  async updateJob(id: string, changes: Partial<Omit<Job, 'id'>>) {
    const item = this.get(keys.job(id));
    if (!item) throw new Error('ConditionalCheckFailed');
    for (const [k, v] of Object.entries(changes)) if (v !== undefined) item[k] = structuredClone(v);
  }

  async transitionJob(id: string, from: JobStatus, to: JobStatus, at: string) {
    const item = this.get(keys.job(id));
    if (!item || item.status !== from) return false;
    item.status = to;
    item.updatedAt = at;
    return true;
  }

  async acquireLock(owner: string, nowMs: number, ttlMs: number) {
    const item = this.get(keys.lock());
    if (item && !(item.expiresAt < nowMs)) return false;
    this.put(keys.lock(), { owner, expiresAt: nowMs + ttlMs });
    return true;
  }

  async releaseLock(owner: string) {
    if (this.get(keys.lock())?.owner === owner) this.items.delete(this.id(keys.lock()));
  }
}
