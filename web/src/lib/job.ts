// 処理（ジョブ）の終わりを待つ。GET /api/jobs/{id} を数秒おきに見る（docs/architecture.md「非同期の処理」）。

import type { Job } from './api.ts';

export const POLL_INTERVAL_MS = 3000;

export const isFinished = (job: Pick<Job, 'status'>): boolean => job.status === 'done' || job.status === 'failed';

/** 終わるまで見て、終わったジョブを返す。途中の状態は onUpdate に渡す。signal で止める */
export async function waitJob(
  job: Job,
  fetchJob: (id: string) => Promise<Job>,
  onUpdate: (job: Job) => void,
  options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Job> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let current = job;
  onUpdate(current);
  while (!isFinished(current)) {
    await sleep(POLL_INTERVAL_MS);
    if (options.signal?.aborted) return current;
    current = await fetchJob(current.id);
    onUpdate(current);
  }
  return current;
}
