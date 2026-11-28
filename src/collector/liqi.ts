// liqi（雀魂の protobuf）の定義を、WebGL 版の静的ファイルから作る（docs/decisions.md 2026-11-19「liqi の定義への追従」）。
// 定義の Lua（protoc-gen-lua の生成物）は暗号化されている。鍵は公開リポジトリに置かず、呼び出し側から受け取る。
import protobuf from 'protobufjs';
import { PB_LUA_NAMES } from './static.ts';
import { readTextAsset } from './unityfs.ts';

/** protobufjs の JSON（旧来の liqi.json と同じ形） */
export type LiqiJson = { nested: { lq: { options: Record<string, unknown>; nested: Record<string, unknown> } } };

/** proto_config.bytes（平文の JSON）。`service` だけ使う */
export interface ProtoConfig {
  service: Record<string, Record<string, { request: string; response: string }>>;
}

/** 繰り返し XOR を解く */
export function xorDecrypt(enc: Uint8Array, key: Uint8Array): Buffer {
  if (key.length === 0) throw new Error('empty key');
  const out = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ key[i % key.length];
  return out;
}

/** 展開済みの Lua のバンドルから、定義の Lua を全部取り出して復号する（名前 → Lua のソース） */
export function decryptPbLua(luaBundle: Buffer, key: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of PB_LUA_NAMES) {
    out.set(name, xorDecrypt(readTextAsset(luaBundle, `${name}.lua`), key).toString('latin1'));
  }
  return out;
}

// protobuf の FieldDescriptorProto.Type
const TYPES: Record<number, string> = {
  1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool',
  9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64',
};
const TYPE_MESSAGE = 11;
const TYPE_ENUM = 14;
const LABEL_REPEATED = 3;

type LuaValue = string | number | boolean | string[];
interface LuaVar { file: string; name: string; props: Record<string, LuaValue> }

export interface LuaToJsonResult {
  json: LiqiJson;
  messages: number;
  enums: number;
  methods: number;
  /** 定義の無い型を使うので外したメソッド（デバッグ用など） */
  skipped: string[];
}

/** 復号した Lua（protoc-gen-lua の生成物）と proto_config から、protobufjs の JSON を作る */
export function luaToProtobufJson(lua: Map<string, string>, config: ProtoConfig): LuaToJsonResult {
  // `VAR.prop=value` を全部拾う。値は文字列・数・真偽・{A,B}・参照（b.X / X）
  const vars = new Map<string, LuaVar>();
  const varOf = (file: string, name: string) => {
    const k = `${file}:${name}`;
    let v = vars.get(k);
    if (!v) vars.set(k, (v = { file, name, props: {} }));
    return v;
  };
  const re = /([A-Z0-9_]+)\.([a-z_]+)=("(?:[^"\\]|\\.)*"|\{[^}]*\}|[A-Za-z0-9_.\-]+)/g;
  for (const [file, src] of lua) {
    for (const m of src.matchAll(re)) {
      const [, v, prop, raw] = m;
      let val: LuaValue = raw;
      if (raw.startsWith('"')) val = JSON.parse(raw) as string;
      else if (raw.startsWith('{')) val = raw.slice(1, -1).split(',').filter(Boolean);
      else if (/^-?\d+$/.test(raw)) val = Number(raw);
      else if (raw === 'true' || raw === 'false') val = raw === 'true';
      varOf(file, v).props[prop] = val;
    }
  }

  // 参照を変数に解決する。`b.X` は別のファイルなので、全体から名前で探す
  const byName = new Map<string, LuaVar[]>();
  for (const x of vars.values()) {
    const list = byName.get(x.name) ?? [];
    list.push(x);
    byName.set(x.name, list);
  }
  const resolve = (file: string, ref: string): LuaVar => {
    const qualified = /^[a-z]\./.test(ref);
    const name = ref.replace(/^[a-z]\./, '');
    const local = vars.get(`${file}:${name}`);
    if (local && !qualified) return local;
    const c = (byName.get(name) ?? []).filter((x) => x.props.full_name);
    if (c.length !== 1) throw new Error(`cannot resolve ${ref} in ${file} (${c.length})`);
    return c[0];
  };
  const typeName = (v: LuaVar) => String(v.props.full_name).replace(/^\.lq\./, '');

  const lq: Record<string, any> = {};
  const place = (fullName: string): [Record<string, any>, string] => {
    const parts = fullName.replace(/^\.lq\./, '').split('.');
    let cur = lq;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] ??= {};
      cur = cur[parts[i]].nested ??= {};
    }
    return [cur, parts[parts.length - 1]];
  };

  let messages = 0;
  let enums = 0;
  for (const x of vars.values()) {
    const p = x.props;
    if (!p.full_name) continue;
    if (Array.isArray(p.fields)) {
      const [parent, key] = place(String(p.full_name));
      const obj = (parent[key] ??= {});
      obj.fields = {};
      for (const fv of p.fields) {
        const fp = vars.get(`${x.file}:${fv}`)?.props;
        if (!fp) throw new Error(`field ${fv} not found in ${x.file}`);
        let type = TYPES[fp.type as number];
        if (fp.type === TYPE_MESSAGE) type = typeName(resolve(x.file, String(fp.message_type)));
        else if (fp.type === TYPE_ENUM) type = fp.enum_type ? typeName(resolve(x.file, String(fp.enum_type))) : 'uint32';
        if (!type) throw new Error(`unknown type ${fp.type} at ${fp.full_name}`);
        const d: Record<string, unknown> = {};
        if (fp.label === LABEL_REPEATED) d.rule = 'repeated';
        d.type = type;
        d.id = fp.number;
        // ゲームは repeated の数値を packed にせず送る（proto2 の書き方）。protobufjs の既定は packed なので揃える
        if (fp.label === LABEL_REPEATED && fp.type !== 9 && fp.type !== TYPE_MESSAGE && fp.type !== 12) d.options = { packed: false };
        obj.fields[String(fp.name)] = d;
      }
      messages++;
    } else if (Array.isArray(p.values)) {
      const [parent, key] = place(String(p.full_name));
      const obj = (parent[key] ??= {});
      obj.values = {};
      for (const vv of p.values) {
        const vp = vars.get(`${x.file}:${vv}`)?.props;
        if (!vp) throw new Error(`enum value ${vv} not found in ${x.file}`);
        obj.values[String(vp.name)] = vp.number;
      }
      enums++;
    }
  }

  // サービスは proto_config から。定義の無い型を使うメソッドは外す
  const skipped: string[] = [];
  let methods = 0;
  for (const [svc, ms] of Object.entries(config.service)) {
    lq[svc] = { methods: {} };
    for (const [m, rr] of Object.entries(ms)) {
      if (!lq[rr.request]?.fields || !lq[rr.response]?.fields) {
        skipped.push(`${svc}.${m}`);
        continue;
      }
      lq[svc].methods[m] = { requestType: rr.request, responseType: rr.response };
      methods++;
    }
  }
  return { json: { nested: { lq: { options: {}, nested: lq } } }, messages, enums, methods, skipped };
}

/** 2つの展開済みバンドルと鍵から、定義を作る */
export function buildLiqi(bundles: { protoConfigBundle: Buffer; luaBundle: Buffer }, key: Uint8Array): LuaToJsonResult {
  const config = JSON.parse(readTextAsset(bundles.protoConfigBundle, 'proto_config').toString('utf8')) as ProtoConfig;
  return luaToProtobufJson(decryptPbLua(bundles.luaBundle, key), config);
}

/** この部品が使うメソッド（`サービス.メソッド`） */
export const USED_METHODS = [
  'Route.requestConnection', 'Route.heartbeat',
  'Lobby.oauth2Auth', 'Lobby.oauth2Check', 'Lobby.oauth2Login',
  'Lobby.searchAccountByEid', 'Lobby.fetchAccountInfoExtra', 'Lobby.fetchGameRecordsDetail',
];

export function loadRoot(json: unknown): protobuf.Root {
  const root = protobuf.Root.fromJSON(json as protobuf.INamespace);
  root.resolveAll();
  return root;
}

/** 使っている型: USED_METHODS の要求・応答、`Wrapper`、`Record*`、それらから辿れる型 */
function usedTypes(root: protobuf.Root): Map<string, protobuf.Type | protobuf.Enum> {
  const out = new Map<string, protobuf.Type | protobuf.Enum>();
  const visit = (t: protobuf.ReflectionObject | null) => {
    if (!t || out.has(t.fullName)) return;
    if (t instanceof protobuf.Enum) {
      out.set(t.fullName, t);
    } else if (t instanceof protobuf.Type) {
      out.set(t.fullName, t);
      for (const f of t.fieldsArray) visit(f.resolvedType);
    }
  };
  const lq = root.lookup('lq') as protobuf.Namespace;
  for (const m of USED_METHODS) {
    const method = root.lookup(`lq.${m}`);
    if (!(method instanceof protobuf.Method)) throw new Error(`method not found: ${m}`);
    visit(method.resolvedRequestType);
    visit(method.resolvedResponseType);
  }
  visit(root.lookup('lq.Wrapper'));
  for (const t of lq.nestedArray) if (t.name.startsWith('Record')) visit(t);
  return out;
}

/** 項目の型。メッセージと enum は、書き方（相対名）によらず、解決後の完全な名前で比べる */
const fieldType = (f: protobuf.Field) => f.resolvedType?.fullName ?? f.type;

/**
 * 前回の定義で使っている型について、新しい定義で項目番号・型・repeated かどうかが変わったもの、
 * 消えたものを列挙する。項目が増えただけなら空（protobuf は知らない項目を読み飛ばせる）
 */
export function diffUsedTypes(oldJson: unknown, newJson: unknown): string[] {
  const oldRoot = loadRoot(oldJson);
  const newRoot = loadRoot(newJson);
  const changes: string[] = [];
  for (const m of USED_METHODS) {
    const a = oldRoot.lookup(`lq.${m}`) as protobuf.Method;
    const b = newRoot.lookup(`lq.${m}`);
    if (!(b instanceof protobuf.Method)) changes.push(`${m}: メソッドが無い`);
    else if (a.requestType !== b.requestType || a.responseType !== b.responseType) changes.push(`${m}: 要求・応答の型名が変わった`);
  }
  for (const [name, a] of usedTypes(oldRoot)) {
    let b: protobuf.ReflectionObject | null = null;
    try { b = newRoot.lookup(name); } catch { /* 無い */ }
    if (a instanceof protobuf.Type) {
      if (!(b instanceof protobuf.Type)) { changes.push(`${name}: 型が無い`); continue; }
      for (const fa of a.fieldsArray) {
        const fb = b.fields[fa.name];
        if (!fb) changes.push(`${name}.${fa.name}: 項目が無い`);
        else if (fa.id !== fb.id || fieldType(fa) !== fieldType(fb) || fa.repeated !== fb.repeated) {
          changes.push(`${name}.${fa.name}: ${fa.id}/${fieldType(fa)}${fa.repeated ? '[]' : ''} → ${fb.id}/${fieldType(fb)}${fb.repeated ? '[]' : ''}`);
        }
      }
    } else {
      if (!(b instanceof protobuf.Enum)) { changes.push(`${name}: enum が無い`); continue; }
      for (const [k, v] of Object.entries(a.values)) {
        if (b.values[k] !== v) changes.push(`${name}.${k}: ${v} → ${b.values[k] ?? '無い'}`);
      }
    }
  }
  return changes;
}
