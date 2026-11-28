// 旧方式（Drive → GAS → スプレッドシート）の牌譜を Web サービスに移す。
// 旧方式の牌譜（mjlog 形式）にはアカウント ID が無いので、`ref`（牌譜 uuid）で雀魂から head を取り直し、
// 新方式と同じ形（data バケットの records/<uuid>.json と、ランキングの「取り込み済み」）で入れる。
// 入出力は local/legacy/（gitignore 済み）。手順と結果の要旨は docs/tasks/015-legacy-data-migration.md。
//
//   node src/migrate/legacy.ts fetch     旧方式の牌譜の uuid で head を取り、heads/ に置く（ログイン1回。手元にある分は取らない）
//   node src/migrate/legacy.ts compare   旧方式の牌譜と head を突き合わせ、out/compare.txt に書く（雀魂・AWS には接続しない）
//   node src/migrate/legacy.ts upload --ranking <ID> --table <名前> --data-bucket <名前> --site-bucket <名前> --sub <Admin の sub>
//                                        head を S3 に置き、ランキングで「取り込み済み」にする（取り込み済みの対局は変えない）
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchHeads } from '../collector/collect.ts';
import { localCollectorDeps, writeJsonFile } from '../collector/local.ts';
import { openSession } from '../collector/session.ts';
import { aggregate, fromMjlog, fromRecordGame, type GameResult, type Mjlog, type Mode, type RecordGameHead } from '../ranking/index.ts';

const DIR = path.resolve(process.env.LEGACY_DIR ?? path.join(import.meta.dirname, '../../local/legacy'));
const PAIFU_DIRS: Record<Mode, string> = { '4p': 'paifu/4p', '3p': 'paifu/3p' };
const HEADS_DIR = path.join(DIR, 'heads');
const headFile = (uuid: string) => path.join(HEADS_DIR, `${uuid}.json`);

interface Legacy {
  file: string;
  /** 置いてあったフォルダ（旧方式はフォルダで四麻・三麻を分けていた） */
  folder: Mode;
  json: Mjlog;
}

function readLegacy(): Legacy[] {
  const out: Legacy[] = [];
  for (const folder of ['4p', '3p'] as Mode[]) {
    const dir = path.join(DIR, PAIFU_DIRS[folder]);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      out.push({ file: path.join(PAIFU_DIRS[folder], f), folder, json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) });
    }
  }
  return out;
}

function readHead(uuid: string): RecordGameHead | undefined {
  return fs.existsSync(headFile(uuid)) ? (JSON.parse(fs.readFileSync(headFile(uuid), 'utf8')) as RecordGameHead) : undefined;
}

/** 旧方式で、牌譜を手で作って入れた対局（uuid がすべて0）。雀魂には無いので取り直せない */
const isManual = (uuid: string) => /^[0-]+$/.test(uuid);

/** 四麻・三麻の席の数 */
const SEATS: Record<Mode, number> = { '4p': 4, '3p': 3 };

/**
 * 手で作った対局の head を、旧方式の牌譜（点数・pt・名前・日時）と、取り直した head にある名前と ID の対応から作る。
 * 名前が1つの ID にだけ結び付く場合に限る（結び付かない・複数の ID があるなら作らない）
 */
function manualHead(l: Legacy, idsByName: Map<string, Set<number>>): Record<string, unknown> {
  const g = fromMjlog(l.json);
  const accounts = g.players.map((p) => {
    const ids = idsByName.get(p.name);
    if (!ids || ids.size !== 1) throw new Error(`${l.file}: 名前「${p.name}」の ID が1つに決まらない（${ids ? [...ids].join(' / ') : '無い'}）`);
    return { seat: p.seat, account_id: [...ids][0], nickname: p.name };
  });
  if (accounts.length !== SEATS[g.mode]) throw new Error(`${l.file}: 席の数が違う`);
  return {
    uuid: g.uuid,
    end_time: g.endTime / 1000,
    accounts,
    result: { players: g.players.map((p) => ({ seat: p.seat, part_point_1: p.score, total_point: Math.round(p.pt * 1000) })) },
    // 雀魂から取った head には無い項目。旧方式で手で作った対局だったことを残す
    legacyManual: { source: l.file, note: '旧方式で牌譜を手で作った対局。ID はほかの対局の名前から引いた（タスク 015）' },
  };
}

async function fetchAll() {
  const legacy = readLegacy();
  const uuids = [...new Set(legacy.map((l) => l.json.ref))];
  const need = uuids.filter((u) => !isManual(u) && !fs.existsSync(headFile(u)));
  console.log(`旧方式の牌譜: ${legacy.length}件（uuid ${uuids.length}種類）。手元に無い head: ${need.length}件`);
  if (need.length) {
    const session = await openSession(localCollectorDeps());
    try {
      // 1回だけの作業なので、ログイン1回で全件を取る（50件ずつ。要求の間隔は session が空ける）
      const r = await fetchHeads(session, need, { maxRecords: need.length });
      for (const h of r.heads) writeJsonFile(headFile(String(h.uuid)), h);
      console.log(`取得: ${r.heads.length}件 → ${HEADS_DIR}`);
      if (r.missing.length) console.log(`[警告] 返らなかった ${r.missing.length}件: ${r.missing.join(' ')}`);
    } finally {
      session.close();
    }
  }

  // 手で作った対局は、取り直した head の名前と ID の対応から作る（雀魂には接続しない）
  const manual = legacy.filter((l) => isManual(l.json.ref) && !fs.existsSync(headFile(l.json.ref)));
  if (manual.length) {
    if (new Set(manual.map((l) => l.json.ref)).size !== manual.length) throw new Error('手で作った対局の uuid が重なっている');
    const idsByName = new Map<string, Set<number>>();
    for (const l of legacy) {
      const h = readHead(l.json.ref);
      for (const a of h?.accounts ?? []) {
        if (a.account_id === undefined || a.nickname === undefined) continue;
        (idsByName.get(a.nickname) ?? idsByName.set(a.nickname, new Set()).get(a.nickname)!).add(a.account_id);
      }
    }
    for (const l of manual) writeJsonFile(headFile(l.json.ref), manualHead(l, idsByName));
    console.log(`手で作った対局: ${manual.length}件の head を作った`);
  }
}

/** 旧方式の牌譜と head の突き合わせ。名前と ID の対応、名前でまとめたランキングと ID でまとめたランキングの違いも出す */
function compare() {
  const legacy = readLegacy();
  const lines: string[] = [];
  const problems: string[] = [];
  const oldResults: GameResult[] = [];
  const newResults: GameResult[] = [];
  const seen = new Set<string>();
  let missing = 0;

  for (const l of legacy) {
    const old = fromMjlog(l.json);
    if (seen.has(old.uuid)) problems.push(`重複: ${old.uuid} (${l.file})`);
    seen.add(old.uuid);
    if (old.mode !== l.folder) problems.push(`フォルダと ratingc が違う: ${l.file}`);
    oldResults.push(old);
    const head = readHead(old.uuid);
    if (!head) {
      missing++;
      problems.push(`head が無い: ${old.uuid} (${l.file})`);
      continue;
    }
    const neu = fromRecordGame(head);
    newResults.push(neu);
    const diff: string[] = [];
    if (neu.mode !== old.mode) diff.push(`四麻/三麻 ${old.mode} → ${neu.mode}`);
    if (neu.endTime !== old.endTime) diff.push(`終了時刻 ${old.endTime} → ${neu.endTime}`);
    for (const o of old.players) {
      const n = neu.players.find((p) => p.seat === o.seat);
      if (!n) {
        diff.push(`席${o.seat} が head に無い`);
        continue;
      }
      if (n.name !== o.name) diff.push(`席${o.seat} 名前 ${o.name} → ${n.name}`);
      if (n.score !== o.score) diff.push(`席${o.seat} 点数 ${o.score} → ${n.score}`);
      if (n.pt !== o.pt) diff.push(`席${o.seat} pt ${o.pt} → ${n.pt}`);
      if (n.rank !== o.rank) diff.push(`席${o.seat} 順位 ${o.rank} → ${n.rank}`);
      // accounts に無い席は AI（`fromRecordGame`）。AI 以外で ID が無いのは食い違い
      if (n.accountId === undefined && !(n.name === 'AI' && o.name === 'AI')) diff.push(`席${o.seat} アカウント ID が無い（${n.name}）`);
    }
    if (diff.length) problems.push(`${old.uuid} (${l.file}): ${diff.join(' / ')}`);
  }

  const manual = legacy.filter((l) => isManual(l.json.ref)).map((l) => l.json.ref);
  lines.push(`旧方式の牌譜: ${legacy.length}件、head あり: ${newResults.length}件、head なし: ${missing}件、うち手で作った対局: ${manual.length}件（${manual.join(' ')}）`);
  lines.push(`食い違い: ${problems.length}件`, ...problems.map((p) => `  ${p}`), '');

  // 名前と ID の対応（四麻・三麻をまとめて）
  const namesById = new Map<number, Set<string>>();
  const idsByName = new Map<string, Set<number>>();
  for (const g of newResults) {
    for (const p of g.players) {
      if (p.accountId === undefined) continue;
      (namesById.get(p.accountId) ?? namesById.set(p.accountId, new Set()).get(p.accountId)!).add(p.name);
      (idsByName.get(p.name) ?? idsByName.set(p.name, new Set()).get(p.name)!).add(p.accountId);
    }
  }
  const renamed = [...namesById].filter(([, n]) => n.size > 1);
  const shared = [...idsByName].filter(([, i]) => i.size > 1);
  lines.push(`参加者: ID ${namesById.size}人、名前 ${idsByName.size}種類`);
  lines.push(`1つの ID に複数の名前（改名。名前でまとめると別人になっていた）: ${renamed.length}人`);
  for (const [id, n] of renamed) lines.push(`  ${id}: ${[...n].join(' / ')}`);
  lines.push(`1つの名前に複数の ID（同名の別人。名前でまとめると1人になっていた）: ${shared.length}件`);
  for (const [name, i] of shared) lines.push(`  ${name}: ${[...i].join(' / ')}`);
  lines.push('');

  // ランキング（全期間）: 名前でまとめたもの（旧シートと同じ）と ID でまとめたもの
  for (const mode of ['4p', '3p'] as Mode[]) {
    const byName = aggregate(oldResults, mode);
    const byId = aggregate(newResults, mode);
    lines.push(`${mode === '4p' ? '四麻' : '三麻'} 全期間: 名前でまとめると ${byName.length}人、ID でまとめると ${byId.length}人`);
    // ID の行ごとに、その ID の名前たちの行を足したものと一致するか
    const nameRow = new Map(byName.map((r) => [r.name, r]));
    for (const r of byId) {
      const names = r.accountId === undefined ? [r.name] : [...(namesById.get(r.accountId) ?? [])];
      const rows = names.map((n) => nameRow.get(n)).filter((x) => x !== undefined);
      const sumTenths = rows.reduce((s, x) => s + Math.round(x.totalPt * 10), 0);
      const sumGames = rows.reduce((s, x) => s + x.games, 0);
      const sumTops = rows.reduce((s, x) => s + x.tops, 0);
      const sharedName = names.some((n) => (idsByName.get(n)?.size ?? 0) > 1);
      if (rows.length > 1 || sharedName || sumTenths !== Math.round(r.totalPt * 10) || sumGames !== r.games || sumTops !== r.tops) {
        lines.push(
          `  ${r.key}（${r.name}）: ID で ${r.totalPt}pt ${r.games}局 トップ${r.tops} ／ 名前で ${rows.map((x) => `${x.name} ${x.totalPt}pt ${x.games}局`).join(' + ')}` +
            (sharedName ? '（同名の別人あり）' : ''),
        );
      }
    }
  }

  const out = path.join(DIR, 'out', 'compare.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`旧方式の牌譜 ${legacy.length}件、head あり ${newResults.length}件、食い違い ${problems.length}件、改名 ${renamed.length}人、同名の別人 ${shared.length}件`);
  console.log(`具体: ${out}`);
  if (problems.length) process.exitCode = 1;
}

async function upload(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ranking: { type: 'string' },
      table: { type: 'string' },
      'data-bucket': { type: 'string' },
      'site-bucket': { type: 'string' },
      sub: { type: 'string' },
    },
    strict: true,
  });
  const { ranking: rankingId, table, sub } = values;
  const dataBucket = values['data-bucket'];
  const siteBucket = values['site-bucket'];
  if (!rankingId || !table || !dataBucket || !siteBucket || !sub) throw new Error('--ranking --table --data-bucket --site-bucket --sub が要る');

  // AWS の SDK は upload だけで使う（fetch・compare は AWS に接続しない）
  const { DynamoStore } = await import('../api/store.ts');
  const { S3Blobs } = await import('../api/aws.ts');
  const { publishRanking } = await import('../api/games.ts');
  const store = new DynamoStore(table);
  const blobs = new S3Blobs(dataBucket, siteBucket);
  const ranking = await store.getRanking(rankingId);
  if (!ranking) throw new Error(`ランキング ${rankingId} が無い`);

  const legacy = readLegacy();
  const at = new Date().toISOString();
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const [i, l] of legacy.entries()) {
    const uuid = l.json.ref;
    const head = readHead(uuid);
    if (!head) throw new Error(`head が無い: ${uuid}（先に fetch と compare）`);
    if (await store.getGameState(rankingId, uuid)) {
      skipped.push(uuid);
      continue;
    }
    // 牌譜はランキングをまたいで1つ。既にあれば置き直さない
    if (!(await blobs.getRecord(uuid))) await blobs.putRecord(uuid, head as unknown as Record<string, unknown>);
    await store.putGameState(rankingId, { uuid, state: 'imported', result: fromRecordGame(head), changedBy: sub, changedAt: at });
    imported.push(uuid);
    if ((i + 1) % 100 === 0) console.log(`${i + 1} / ${legacy.length}`);
  }
  await store.appendLog(
    rankingId,
    { at: new Date().toISOString(), sub, via: 'admin', op: 'importLegacy', detail: { imported: imported.length, skipped: skipped.length } },
    Math.random().toString(36).slice(2, 10),
  );
  await publishRanking({ store, blobs, now: () => new Date() }, ranking);
  console.log(`取り込み: ${imported.length}件、取り込み済みだったので変えていない: ${skipped.length}件。ランキングの JSON を作り直した`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = cmd === 'fetch' ? fetchAll() : cmd === 'compare' ? Promise.resolve(compare()) : cmd === 'upload' ? upload(rest) : undefined;
if (!run) {
  console.log('使い方: node src/migrate/legacy.ts fetch | compare | upload --ranking <ID> --table <名前> --data-bucket <名前> --site-bucket <名前> --sub <sub>');
  process.exitCode = cmd ? 1 : 0;
} else {
  run.catch((e) => {
    console.error(`失敗: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
