// 牌譜回収を手元から試す CLI（タスク 006）。手順は docs/collector.md。
// 状態はすべて local/collector/（gitignore 済み）に置く。場所は環境変数 COLLECTOR_DIR で変えられる。
import fs from 'node:fs';
import path from 'node:path';
import { fromRecordGame, type RecordGameHead } from '../ranking/index.ts';
import { fetchHeads, gameLength, listCandidates, type Candidate, type Host } from './collect.ts';
import type { Credentials } from './login.ts';
import { loadState, openSession, refreshState, type CollectorDeps, type StateKey } from './session.ts';

const DIR = path.resolve(process.env.COLLECTOR_DIR ?? path.join(import.meta.dirname, '../../local/collector'));
const file = (name: string) => path.join(DIR, name);
const STATE_FILES: Record<StateKey, string> = { 'client-version': 'client-version.json', liqi: 'liqi.json' };

const USAGE = `使い方: node src/collector/cli.ts <コマンド>
  update-static            雀魂のバージョンと定義を作り直す（ログインしない）
  candidates [表示用ID]    主催者の友人戦の候補を出す。ID を省くと host.json の内部 ID を使う
  fetch <番号|uuid>...     候補の牌譜を取り、out/ に保存して取り込み済みにする（--chunk N で、まとめる件数）
  exclude <番号|uuid>...   対象外にする（雀魂には接続しない）
番号は、直前の candidates の表示の番号。状態の置き場所: ${DIR}`;

interface Records {
  /** uuid → 記録した時刻 */
  imported: Record<string, string>;
  excluded: Record<string, string>;
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}
function writeJson(name: string, value: unknown, mode = 0o600) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', { mode });
}

function deps(): CollectorDeps {
  return {
    store: {
      get: async (key) => (fs.existsSync(file(STATE_FILES[key])) ? fs.readFileSync(file(STATE_FILES[key]), 'utf8') : null),
      put: async (key, value) => writeJson(STATE_FILES[key], JSON.parse(value)),
    },
    credentials: async () => {
      const s = readJson<Partial<Credentials> | null>('secret.json', null);
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

/** 同時に実行しない */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(DIR, { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(file('run.lock'), 'wx');
  } catch {
    throw new Error(`別の実行中か、前回の実行が途中で止まった。止まっていたなら ${file('run.lock')} を消す`);
  }
  fs.closeSync(fd);
  return fn().finally(() => fs.rmSync(file('run.lock'), { force: true }));
}

const jst = (ms: number) =>
  new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

function printCandidates(list: Candidate[]) {
  list.forEach((c, i) => {
    const names = [...c.players].sort((a, b) => a.rank - b.rank).map((p) => p.nickname).join(' / ');
    const len = gameLength(c.subTag) ?? `mode=${c.subTag}`;
    console.log(`${String(i + 1).padStart(3)}  ${jst(c.endTime)}  ${c.mode === '4p' ? '四麻' : '三麻'}${len}  ${names}  ${c.uuid}`);
  });
}

/** 番号（直前の candidates の表示）か uuid を、uuid にする */
function resolveTargets(args: string[]): string[] {
  const last = readJson<Candidate[]>('candidates.json', []);
  return args.map((a) => {
    if (/^\d+$/.test(a)) {
      const c = last[Number(a) - 1];
      if (!c) throw new Error(`番号 ${a} の候補がない（先に candidates を実行する）`);
      return c.uuid;
    }
    return a;
  });
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const records = readJson<Records>('records.json', { imported: {}, excluded: {} });
  const now = new Date().toISOString();

  if (cmd === 'update-static') {
    await withLock(async () => {
      const d = deps();
      const state = await loadState(d.store);
      await refreshState(d, state);
    });
  } else if (cmd === 'candidates' && rest.length <= 1 && rest.every((a) => /^\d+$/.test(a))) {
    let host: Host;
    if (rest.length) host = { eid: Number(rest[0]) };
    else {
      const h = readJson<{ accountId?: number } | null>('host.json', null);
      if (!h?.accountId) throw new Error(`表示用 ID を指定するか、${file('host.json')} に accountId を書く（docs/collector.md）`);
      host = { accountId: h.accountId };
    }
    await withLock(async () => {
      const session = await openSession(deps());
      try {
        const isKnown = (u: string) => u in records.imported || u in records.excluded;
        const r = await listCandidates(session, host, isKnown);
        writeJson('candidates.json', r.candidates);
        console.log(`雀魂が返した件数: 四麻 ${r.returned['4p']}、三麻 ${r.returned['3p']}。未処理の候補: ${r.candidates.length}件`);
        for (const w of r.warnings) console.log(`[警告] ${w}`);
        printCandidates(r.candidates);
      } finally {
        session.close();
      }
    });
  } else if (cmd === 'fetch' && rest.length) {
    const chunkAt = rest.indexOf('--chunk');
    const chunkSize = chunkAt >= 0 ? Number(rest.splice(chunkAt, 2)[1]) : undefined;
    const uuids = resolveTargets(rest);
    await withLock(async () => {
      const session = await openSession(deps());
      try {
        const r = await fetchHeads(session, uuids, { chunkSize });
        for (const h of r.heads) {
          const uuid = String(h.uuid);
          const g = fromRecordGame(h as unknown as RecordGameHead); // 読めることを確かめる
          writeJson(path.join('out', `${uuid}.json`), h);
          records.imported[uuid] = now;
          const line = g.players.map((p) => `${p.rank}位 ${p.name} ${p.pt}`).join(' / ');
          console.log(`${jst(g.endTime)}  ${g.mode === '4p' ? '四麻' : '三麻'}  ${line}`);
        }
        writeJson('records.json', records);
        console.log(`取得: ${r.heads.length}件 → ${file('out')}`);
        if (r.missing.length) console.log(`[警告] 返らなかった: ${r.missing.join(' ')}`);
      } finally {
        session.close();
      }
    });
  } else if (cmd === 'exclude' && rest.length) {
    for (const u of resolveTargets(rest)) records.excluded[u] = now;
    writeJson('records.json', records);
    console.log(`対象外にした: ${rest.length}件`);
  } else {
    console.log(USAGE);
    process.exitCode = cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`失敗: ${(e as Error).message}`);
  process.exitCode = 1;
});
