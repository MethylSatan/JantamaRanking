// 雀魂（静的ファイル・ゲームサーバー）への要求の間隔を空ける。CLAUDE.md の規約「繰り返しアクセスするコードは間隔を空ける」

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要求の間の既定の間隔（検証と同じ2秒。`docs/architecture.md` の「1秒以上」を満たす） */
export const DEFAULT_INTERVAL_MS = 2000;

/** 呼ぶたびに、前回から `intervalMs` 経つまで待つ関数を返す。初回は待たない */
export function createPacer(intervalMs: number, sleep: Sleep = defaultSleep, now: () => number = Date.now): () => Promise<void> {
  let last = -Infinity;
  return async () => {
    const wait = last + intervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
  };
}
