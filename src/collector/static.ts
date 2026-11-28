// 雀魂の WebGL 版の公開の静的ファイルを取る（ログインしない）。
// 雀魂のバージョンと、liqi の定義の元になるバンドル。手順は docs/architecture.md「雀魂の WebGL 版の通信」。
import { randomBytes } from 'node:crypto';
import { createPacer, defaultSleep, DEFAULT_INTERVAL_MS, type Sleep } from './pacer.ts';
import { bundleOf, readBundleInfo, unityfs, type BundleInfo } from './unityfs.ts';

export const GAME_URL = 'https://game.mahjongsoul.com/';
export const STATIC_BASE = 'https://appstatic.mahjongsoul.com/v4/jp/resources/ab/WebGL/ASTC/';
const VERSION_BUNDLE_PREFIX = 'u6v_td1bd8bb002s_';
export const PROTO_CONFIG_ASSET = 'MyAssets/docs/proto_config.bytes';
export const PB_LUA_NAMES = [
  'client_pb', 'config_pb', 'com_const_pb', 'cli_route_pb', 'cli_game_pb', 'notify_lobby_pb',
  'liqi_struct_pb', 'amulet_struct_pb', 'com_struct_pb', 'excel_pb', 'cli_lobby_pb',
] as const;
export const pbLuaAsset = (name: string) => `LuaByte/Lua/Protol/${name}.lua.bytes`;

/** ログインで送る雀魂のバージョン */
export interface ClientVersion {
  /** `WebGL_2022-0.16.287` の形 */
  clientVersionString: string;
  /** `client_version.resource`（`0.16.287`） */
  resource: string;
  /** `client_version.package`（`window.__webglProductVersion`） */
  package: string;
}

export type Get = (url: string) => Promise<Buffer>;

export const defaultGet: Get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/\?.*$/, '')}`);
  return Buffer.from(await res.arrayBuffer());
};

export interface StaticOptions {
  get?: Get;
  sleep?: Sleep;
  intervalMs?: number;
}

/** 静的ファイルの取得。要求の間を空け、ゲームと同じように `randv` を付ける */
export class StaticClient {
  #get: Get;
  #pace: () => Promise<void>;
  /** これまでの要求の数 */
  requests = 0;

  constructor(opts: StaticOptions = {}) {
    this.#get = opts.get ?? defaultGet;
    this.#pace = createPacer(opts.intervalMs ?? DEFAULT_INTERVAL_MS, opts.sleep ?? defaultSleep);
  }

  async fetch(url: string, randv = true): Promise<Buffer> {
    await this.#pace();
    this.requests++;
    return this.#get(randv ? `${url}?randv=${randomBytes(16).toString('hex')}` : url);
  }

  /** `bundle_info_so.majset` を取って読む（要求1回） */
  async bundleInfo(): Promise<BundleInfo> {
    return readBundleInfo(unityfs(await this.fetch(STATIC_BASE + 'bundle_info_so.majset')));
  }

  /** 雀魂のバージョン（要求2回。`bundle_info` は別に渡す） */
  async clientVersion(info: BundleInfo): Promise<ClientVersion> {
    const html = (await this.fetch(GAME_URL, false)).toString('utf8');
    const pkg = /__webglProductVersion\s*=\s*"([^"]+)"/.exec(html)?.[1];
    if (!pkg) throw new Error('__webglProductVersion not found');
    const names = info.bundles.filter((n) => n.startsWith(VERSION_BUNDLE_PREFIX));
    if (names.length !== 1) throw new Error(`${VERSION_BUNDLE_PREFIX}*: found ${names.length}`);
    const text = unityfs(await this.fetch(STATIC_BASE + names[0])).toString('latin1');
    const m = /\{"version":"([^"]+)","platform":"WebGL"\}/.exec(text);
    if (!m) throw new Error('version not found in version bundle');
    return { clientVersionString: `WebGL_2022-${m[1]}`, resource: m[1], package: pkg };
  }

  /** liqi の定義の元になるバンドル2つ（要求2回）。中身は展開済み */
  async liqiBundles(info: BundleInfo): Promise<{ protoConfigBundle: Buffer; luaBundle: Buffer }> {
    const luaBundles = new Set(PB_LUA_NAMES.map((n) => bundleOf(info, pbLuaAsset(n))));
    if (luaBundles.size !== 1) throw new Error(`*_pb.lua are in ${luaBundles.size} bundles`);
    const protoConfigBundle = unityfs(await this.fetch(STATIC_BASE + bundleOf(info, PROTO_CONFIG_ASSET)));
    const luaBundle = unityfs(await this.fetch(STATIC_BASE + [...luaBundles][0]));
    return { protoConfigBundle, luaBundle };
  }
}
