// ログイン済みの接続を開く。雀魂のバージョンと liqi の定義は保存済みのものを使い、
// `oauth2Auth` が `err=151` のときだけ作り直して、ログインを1回だけやり直す（docs/decisions.md 2026-11-19 タスク 016・017）。
import { isDeepStrictEqual } from 'node:util';
import type protobuf from 'protobufjs';
import { connect as wsConnect, GATEWAY_URL, MajsoulError, type Conn, type Connect, type Log } from './connection.ts';
import { buildLiqi, diffUsedTypes, loadRoot, type LuaToJsonResult } from './liqi.ts';
import { login, type Credentials } from './login.ts';
import { createPacer, defaultSleep, DEFAULT_INTERVAL_MS, type Sleep } from './pacer.ts';
import { StaticClient, type ClientVersion, type Get } from './static.ts';
import type { BundleInfo } from './unityfs.ts';

/** 雀魂のバージョンと定義の置き場所（Lambda では S3、CLI ではファイル）。値は JSON の文字列 */
export interface StateStore {
  get(key: StateKey): Promise<string | null>;
  put(key: StateKey, value: string): Promise<void>;
}
export type StateKey = 'client-version' | 'liqi';

/** 呼び出し側が渡すもの */
export interface CollectorDeps {
  store: StateStore;
  /** 運営アカウントの認証情報（Lambda では SSM、CLI では秘密ファイル） */
  credentials: () => Promise<Credentials>;
  /** 定義の Lua の鍵（公開リポジトリに置かない） */
  luaKey: () => Promise<Uint8Array>;
  /** 運営に知らせること（定義が変わった、ログインに失敗した など） */
  notify: (msg: string) => void | Promise<void>;
  log?: Log;
  /** 以下はテスト用の差し替え */
  connect?: Connect;
  statics?: StaticSource;
  get?: Get;
  sleep?: Sleep;
  intervalMs?: number;
}

/** 静的ファイルから得るもの。テストでは偽物に差し替える */
export interface StaticSource {
  bundleInfo(): Promise<BundleInfo>;
  clientVersion(info: BundleInfo): Promise<ClientVersion>;
  liqi(info: BundleInfo, key: Uint8Array): Promise<LuaToJsonResult>;
}

/** ログイン済みの接続。Lobby の要求は間隔を空けて送る */
export interface Session {
  call(method: string, body: Record<string, unknown>): Promise<any>;
  close(): void;
  /** この実行で作り直したもの */
  refreshed: { clientVersion: boolean; liqi: boolean };
}

const ERR_VERSION = 151;

/** 保存済みの雀魂のバージョンと定義。作り直すと書き換わる */
export interface SessionState {
  version: ClientVersion | null;
  liqiJson: unknown;
  refreshed: { clientVersion: boolean; liqi: boolean };
}

export async function loadState(store: StateStore): Promise<SessionState> {
  return {
    version: parse<ClientVersion>(await store.get('client-version')),
    liqiJson: parse<unknown>(await store.get('liqi')),
    refreshed: { clientVersion: false, liqi: false },
  };
}

/**
 * 雀魂のバージョンと定義を、静的ファイルから作り直す（要求は合計5回。ログインしない）。
 * 定義は、使っている型が変わっていたら採用せずに通知する。作れなかったときは、前回の定義があれば通知して続ける
 */
export async function refreshState(deps: CollectorDeps, state: SessionState, statics = staticSource(deps)): Promise<void> {
  const log = deps.log ?? (() => {});
  const info = await statics.bundleInfo();
  const v = await statics.clientVersion(info);
  const old = state.version;
  if (!old || v.clientVersionString !== old.clientVersionString || v.package !== old.package) {
    log(`雀魂のバージョン: ${old?.clientVersionString ?? 'なし'} → ${v.clientVersionString}（package ${v.package}）`);
    state.version = v;
    state.refreshed.clientVersion = true;
    await deps.store.put('client-version', JSON.stringify(v));
  } else {
    log(`雀魂のバージョンは変わっていない（${v.clientVersionString}）`);
  }
  try {
    const built = await statics.liqi(info, await deps.luaKey());
    if (state.liqiJson) {
      const changes = diffUsedTypes(state.liqiJson, built.json);
      if (changes.length) {
        await deps.notify(`liqi の定義で、使っている型が変わった。新しい定義は採用せず、前回の定義を使う:\n${changes.slice(0, 20).join('\n')}`);
        return;
      }
      if (isDeepStrictEqual(state.liqiJson, built.json)) {
        log('liqi の定義は変わっていない');
        return;
      }
    }
    state.liqiJson = built.json;
    state.refreshed.liqi = true;
    await deps.store.put('liqi', JSON.stringify(built.json));
    log(`liqi の定義を作り直した（型 ${built.messages}、メソッド ${built.methods}）`);
  } catch (e) {
    if (!state.liqiJson) throw e;
    await deps.notify(`liqi の定義を作り直せなかった。前回の定義を使う: ${(e as Error).message}`);
  }
}

function staticSource(deps: CollectorDeps): StaticSource {
  if (deps.statics) return deps.statics;
  const c = new StaticClient({ get: deps.get, sleep: deps.sleep ?? defaultSleep, intervalMs: deps.intervalMs });
  return {
    bundleInfo: () => c.bundleInfo(),
    clientVersion: (info) => c.clientVersion(info),
    liqi: async (info, key) => buildLiqi(await c.liqiBundles(info), key),
  };
}

export async function openSession(deps: CollectorDeps): Promise<Session> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const connect = deps.connect ?? wsConnect;
  const statics = staticSource(deps);
  const state = await loadState(deps.store);
  const { refreshed } = state;
  const refresh = () => refreshState(deps, state, statics);

  if (!state.version || !state.liqiJson) await refresh();
  const cred = await deps.credentials();

  const tryLogin = async (): Promise<{ conn: Conn; root: protobuf.Root }> => {
    const root = loadRoot(state.liqiJson);
    const conn = await connect(GATEWAY_URL, root, log);
    try {
      await login(conn, cred, state.version!, sleep);
      return { conn, root };
    } catch (e) {
      conn.close();
      throw e;
    }
  };

  let conn: Conn;
  try {
    ({ conn } = await tryLogin());
  } catch (e) {
    const isVersion = e instanceof MajsoulError && e.method === 'Lobby.oauth2Auth' && e.code === ERR_VERSION;
    if (!isVersion || refreshed.clientVersion || refreshed.liqi) {
      await deps.notify(`ログインに失敗した: ${(e as Error).message}`);
      throw e;
    }
    log('oauth2Auth が err=151。雀魂のバージョンと定義を取り直して、ログインを1回だけやり直す');
    const before = state.version!.clientVersionString;
    await refresh();
    if (!refreshed.clientVersion && !refreshed.liqi) {
      await deps.notify(`ログインに失敗した（err=151）。雀魂のバージョン（${before}）も定義も変わっていないので、やり直さない`);
      throw e;
    }
    try {
      ({ conn } = await tryLogin());
    } catch (e2) {
      await deps.notify(`作り直した後もログインに失敗した: ${(e2 as Error).message}`);
      throw e2;
    }
  }
  log('ログインした');

  const pace = createPacer(deps.intervalMs ?? DEFAULT_INTERVAL_MS, sleep);
  await pace(); // ログイン直後の要求の前にも間を空ける
  return {
    async call(method, body) {
      await pace();
      return conn.call(method, body);
    },
    close: () => conn.close(),
    refreshed,
  };
}

function parse<T>(s: string | null): T | null {
  return s ? (JSON.parse(s) as T) : null;
}
