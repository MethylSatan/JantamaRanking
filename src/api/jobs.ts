// 雀魂への要求を含む長い処理（ジョブ）。docs/architecture.md「非同期の処理」「雀魂に負荷をかけない運用」。
// API がジョブの項目を作って自分の Lambda を非同期で起動し、起動された側が runJob で処理する。

import { isDeepStrictEqual } from 'node:util';
import { fetchHeads, listCandidates, listWarnings, type CandidateList, type Host, type Session } from '../collector/index.ts';
import { fromRecordGame, type RecordGameHead } from '../ranking/index.ts';
import type { Blobs } from './blobs.ts';
import { publishRanking } from './games.ts';
import type { Job, JobKind, Store } from './store.ts';

/** ログイン済みの雀魂の接続を開く。notify は Admin に知らせること（定義が変わった など） */
export type OpenMajsoul = (notify: (msg: string) => void) => Promise<Session>;

export interface JobDeps {
  store: Store;
  blobs: Blobs;
  now: () => Date;
  newLogSuffix: () => string;
  openMajsoul: OpenMajsoul;
  sleep: (ms: number) => Promise<void>;
}

/** ロックの期限。Lambda の timeout（300秒）より長くする */
export const LOCK_TTL_MS = 360_000;
/** ロックが使われているとき、空くのを待つ長さと、見に行く間隔 */
export const LOCK_WAIT_MS = 60_000;
export const LOCK_POLL_MS = 5_000;
/** 雀魂アカウントごとの、手動の候補の更新の最短の間隔（ユーザーの判断で数秒） */
export const MIN_REFRESH_INTERVAL_MS = 5_000;

/** ジョブの項目を作る（起動は呼び出し側） */
export function newJob(
  id: string,
  kind: JobKind,
  by: { sub: string; via: Job['via'] },
  now: Date,
  extra: { rankingId?: string; uuids?: string[] } = {},
): Job {
  const at = now.toISOString();
  return {
    id,
    kind,
    ...(extra.rankingId ? { rankingId: extra.rankingId } : {}),
    ...(extra.uuids ? { uuids: extra.uuids } : {}),
    status: 'queued',
    createdBy: by.sub,
    via: by.via,
    createdAt: at,
    updatedAt: at,
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** ジョブを1つ処理する。待ちでないジョブ（2回起動された など）は何もしない */
export async function runJob(deps: JobDeps, jobId: string): Promise<void> {
  const { store } = deps;
  const job = await store.getJob(jobId);
  if (!job) throw new Error(`ジョブ ${jobId} が無い`);
  if (!(await store.transitionJob(jobId, 'queued', 'running', deps.now().toISOString()))) return;

  const notices: string[] = [];
  const notify = (msg: string) => {
    console.error(`[通知] ${msg}`);
    notices.push(msg);
  };
  let session: Session | undefined;
  const getSession = async () => (session ??= await deps.openMajsoul(notify));
  const progress = (p: string) => store.updateJob(jobId, { progress: p, updatedAt: deps.now().toISOString() });

  let locked = false;
  try {
    await progress('ほかの処理が終わるのを待っています');
    locked = await waitLock(deps, jobId);
    if (!locked) throw new Error('ほかの処理が続いているため、始められませんでした。しばらくしてからやり直してください');

    let result: Record<string, unknown>;
    if (job.kind === 'refresh') {
      result = job.rankingId ? await refreshRanking(deps, job.rankingId, getSession, progress) : await refreshAll(deps, getSession, progress);
    } else if (job.kind === 'import') {
      result = await importGames(deps, job, getSession, progress);
    } else {
      result = await rebuild(deps, job, progress);
    }
    if (notices.length) result.notices = notices;
    await store.updateJob(jobId, { status: 'done', result, progress: '完了', updatedAt: deps.now().toISOString() });
    await logJob(deps, job, result);
  } catch (e) {
    console.error(`job ${jobId} (${job.kind})`, e);
    await store.updateJob(jobId, {
      status: 'failed',
      error: message(e),
      ...(notices.length ? { result: { notices } } : {}),
      progress: '失敗',
      updatedAt: deps.now().toISOString(),
    });
    await logJob(deps, job, { error: message(e) });
  } finally {
    session?.close();
    if (locked) await store.releaseLock(jobId);
  }
}

async function waitLock(deps: JobDeps, owner: string): Promise<boolean> {
  const deadline = deps.now().getTime() + LOCK_WAIT_MS;
  for (;;) {
    if (await deps.store.acquireLock(owner, deps.now().getTime(), LOCK_TTL_MS)) return true;
    if (deps.now().getTime() + LOCK_POLL_MS > deadline) return false;
    await deps.sleep(LOCK_POLL_MS);
  }
}

/** 操作ログ。定期取得のジョブはランキングに付かないので書かない（CloudWatch Logs に出る） */
async function logJob(deps: JobDeps, job: Job, detail: Record<string, unknown>) {
  if (!job.rankingId || job.via === 'scheduler') return;
  const at = deps.now().toISOString();
  await deps.store.appendLog(
    job.rankingId,
    { at, sub: job.createdBy, via: job.via, op: job.kind, target: job.id, detail },
    deps.newLogSuffix(),
  );
}

/** 一覧に出ていた、その雀魂アカウント自身のニックネーム（`all` は新しい順なので、新しい対局のもの） */
const selfName = (list: CandidateList): string | undefined =>
  list.all.flatMap((g) => g.players).find((p) => p.accountId === list.accountId)?.nickname;

/**
 * 一覧を保存し、取りこぼしの警告を返す。候補は処理済みも含めて全件を書く（ランキングごとの状態は別に持つ）。
 * 警告は、保存してある前回までの一覧と比べて出す（`listWarnings`）ので、書く前に読む
 */
async function saveList(deps: JobDeps, list: CandidateList): Promise<string[]> {
  const internalId = String(list.accountId);
  const warnings = listWarnings(await deps.store.listCandidates(internalId), list.all);
  await deps.store.putCandidates(internalId, list.all);
  await deps.store.markRefreshed(internalId, deps.now().toISOString(), selfName(list));
  return warnings;
}

const summarize = (list: CandidateList, warnings: string[]) => ({
  internalId: String(list.accountId),
  returned: list.returned,
  newCandidates: list.candidates.length,
  warnings,
});

async function refreshRanking(
  deps: JobDeps,
  rankingId: string,
  getSession: () => Promise<Session>,
  progress: (p: string) => Promise<void>,
) {
  const { store } = deps;
  const accounts = await store.listAccounts(rankingId);
  const known = new Set((await store.listGameStates(rankingId)).map((s) => s.uuid));
  const results: Record<string, unknown>[] = [];
  if (accounts.length) {
    await progress('雀魂にログインしています');
    await getSession();
  }
  for (const a of accounts) {
    // 表示用 ID は、内部 ID を引くためだけに使う。進み具合・結果・操作ログには出さない（タスク 031）
    const label = a.name ?? (a.internalId ? `ID ${a.internalId}` : '表示用 ID で指定したアカウント');
    await progress(`雀魂アカウント ${label} の一覧を取っています`);
    const host: Host = a.internalId ? { accountId: Number(a.internalId) } : { eid: Number(a.displayId) };
    const ref = a.internalId ? { internalId: a.internalId } : { pendingId: a.pendingId };
    try {
      const list = await listCandidates(await getSession(), host, (u) => known.has(u));
      const name = selfName(list);
      if (a.pendingId) await store.resolvePendingAccount(rankingId, a.pendingId, String(list.accountId), name);
      const summary = summarize(list, await saveList(deps, list));
      results.push({ ...ref, ...summary, ...(name !== undefined ? { name } : {}) });
    } catch (e) {
      // 1つのアカウントの失敗（表示用 ID が見つからない など）で、ほかのアカウントを止めない
      const msg = a.displayId ? message(e).split(a.displayId).join('（表示用 ID）') : message(e);
      results.push({ ...ref, ...(a.name !== undefined ? { name: a.name } : {}), error: msg });
    }
  }
  return { accounts: results };
}

/** 定期取得: 登録されているすべての雀魂アカウントの候補を更新する */
async function refreshAll(deps: JobDeps, getSession: () => Promise<Session>, progress: (p: string) => Promise<void>) {
  const { store } = deps;
  const ids = await store.listMajsouls();
  const results: Record<string, unknown>[] = [];
  if (ids.length) {
    await progress('雀魂にログインしています');
    await getSession();
  }
  for (const internalId of ids) {
    await progress(`雀魂アカウント ${internalId} の一覧を取っています`);
    try {
      // 新しい候補の数を数えるため、指しているランキングのどれかで処理済みなら既知とする
      const known = new Set<string>();
      for (const rid of await store.listRankingIdsForMajsoul(internalId)) {
        for (const s of await store.listGameStates(rid)) known.add(s.uuid);
      }
      const list = await listCandidates(await getSession(), { accountId: Number(internalId) }, (u) => known.has(u));
      const summary = summarize(list, await saveList(deps, list));
      if (summary.warnings.length) console.error(`[通知] 雀魂アカウント ${internalId}: ${summary.warnings.join(' / ')}`);
      results.push(summary);
    } catch (e) {
      results.push({ internalId, error: message(e) });
    }
  }
  return { accounts: results };
}

async function importGames(
  deps: JobDeps,
  job: Job,
  getSession: () => Promise<Session>,
  progress: (p: string) => Promise<void>,
) {
  const { store, blobs } = deps;
  const rankingId = job.rankingId!;
  const uuids = job.uuids ?? [];
  const heads = new Map<string, RecordGameHead>();
  const skipped: string[] = [];
  const targets: string[] = [];
  for (const u of uuids) {
    // 起動を待つ間に取り込み・対象外にされた対局は触らない
    if (await store.getGameState(rankingId, u)) skipped.push(u);
    else targets.push(u);
  }
  // 牌譜はランキングをまたいで1つ。S3 にあれば雀魂に要求しない
  for (const u of targets) {
    const h = await blobs.getRecord(u);
    if (h) heads.set(u, h);
  }
  const need = targets.filter((u) => !heads.has(u));
  let missing: string[] = [];
  if (need.length) {
    await progress('雀魂にログインしています');
    const session = await getSession();
    await progress(`牌譜を${need.length}件取っています`);
    const fetched = await fetchHeads(session, need);
    for (const h of fetched.heads) {
      const uuid = String(h.uuid);
      await blobs.putRecord(uuid, h);
      heads.set(uuid, h as unknown as RecordGameHead);
    }
    missing = fetched.missing;
  }

  await progress('ランキングに反映しています');
  const imported: string[] = [];
  const failed: { uuid: string; error: string }[] = [];
  const at = deps.now().toISOString();
  for (const u of targets) {
    const h = heads.get(u);
    if (!h) continue;
    try {
      const result = fromRecordGame(h);
      await store.putGameState(rankingId, { uuid: u, state: 'imported', result, changedBy: job.createdBy, changedAt: at });
      imported.push(u);
    } catch (e) {
      failed.push({ uuid: u, error: message(e) });
    }
  }
  const ranking = await store.getRanking(rankingId);
  if (ranking) await publishRanking(deps, ranking);
  return { imported, skipped, missing, failed };
}

/** 牌譜からの作り直し。結果を持つ対局（取り込み済み・取り込み後に対象外）ごとに、S3 の牌譜から作り直す */
async function rebuild(deps: JobDeps, job: Job, progress: (p: string) => Promise<void>) {
  const { store, blobs } = deps;
  const rankingId = job.rankingId!;
  const states = (await store.listGameStates(rankingId)).filter((s) => s.result !== undefined);
  await progress(`${states.length}件の対局を作り直しています`);
  let changed = 0;
  const failed: { uuid: string; error: string }[] = [];
  for (const s of states) {
    try {
      const head = await blobs.getRecord(s.uuid);
      if (!head) throw new Error('牌譜が無い');
      const result = fromRecordGame(head);
      if (!isDeepStrictEqual(result, s.result)) {
        changed++;
        await store.putGameState(rankingId, { ...s, result });
      }
    } catch (e) {
      failed.push({ uuid: s.uuid, error: message(e) });
    }
  }
  const ranking = await store.getRanking(rankingId);
  if (ranking) await publishRanking(deps, ranking);
  return { games: states.length, changed, failed };
}
