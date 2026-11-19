// 牌譜回収の部品（タスク 006）。Web サービスの Lambda から呼ぶ（組み込みはタスク 013）。
export {
  openSession, refreshState, loadState,
  type CollectorDeps, type Session, type SessionState, type StateStore, type StateKey, type StaticSource,
} from './session.ts';
export {
  listCandidates, fetchHeads, trimHead, gameLength,
  LIST_LIMIT, MAX_RECORDS_PER_RUN, DEFAULT_CHUNK_SIZE, COSMETIC_ACCOUNT_FIELDS,
  type Host, type Candidate, type CandidatePlayer, type CandidateList, type FetchResult,
} from './collect.ts';
export { MajsoulError, DecodeError } from './connection.ts';
export type { Credentials } from './login.ts';
export type { ClientVersion } from './static.ts';
