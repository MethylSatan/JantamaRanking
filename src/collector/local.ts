// 手元から雀魂に接続するときの依存（手元で試す CLI と、旧方式の牌譜の移行のスクリプト）。
// 雀魂のバージョン・定義・認証情報・定義の鍵は、すべて dir（既定は local/collector/。gitignore 済み）に置く。手順は docs/collector.md。
import fs from 'node:fs';
import path from 'node:path';
import type { Credentials } from './login.ts';
import type { CollectorDeps, StateKey } from './session.ts';

export const DEFAULT_COLLECTOR_DIR = path.resolve(process.env.COLLECTOR_DIR ?? path.join(import.meta.dirname, '../../local/collector'));

const STATE_FILES: Record<StateKey, string> = { 'client-version': 'client-version.json', liqi: 'liqi.json' };

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

export function writeJsonFile(file: string, value: unknown, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode });
}

export function localCollectorDeps(dir = DEFAULT_COLLECTOR_DIR): CollectorDeps {
  const file = (name: string) => path.join(dir, name);
  return {
    store: {
      get: async (key) => (fs.existsSync(file(STATE_FILES[key])) ? fs.readFileSync(file(STATE_FILES[key]), 'utf8') : null),
      put: async (key, value) => writeJsonFile(file(STATE_FILES[key]), JSON.parse(value)),
    },
    credentials: async () => {
      const s = readJsonFile<Partial<Credentials> | null>(file('secret.json'), null);
      if (!s?.code || !s.uid || !s.type) throw new Error(`${file('secret.json')} に type / code / uid がない（docs/collector.md）`);
      return { type: s.type, code: s.code, uid: s.uid };
    },
    luaKey: async () => {
      if (!fs.existsSync(file('lua-key.txt'))) throw new Error(`${file('lua-key.txt')} がない（docs/collector.md）`);
      return Buffer.from(fs.readFileSync(file('lua-key.txt'), 'latin1').trim(), 'latin1');
    },
    notify: (msg) => console.error(`[通知] ${msg}`),
    log: (msg) => console.error(`${new Date().toTimeString().slice(0, 8)} ${msg}`),
  };
}
