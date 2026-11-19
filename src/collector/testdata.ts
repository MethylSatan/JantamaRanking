// テスト用の合成データ。雀魂の実物（定義・鍵・牌譜）は使わない。
import { USED_METHODS } from './liqi.ts';

/** 長さ付き文字列（int32 LE + 本体 + 4バイト境界までの0） */
export function lpString(s: string): Buffer {
  const body = Buffer.from(s, 'latin1');
  const pad = (4 - (body.length % 4)) % 4;
  return Buffer.concat([int32(body.length), body, Buffer.alloc(pad)]);
}
export function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

/** TextAsset が並んだ「展開済みバンドル」もどき（名前 + 長さ + 中身） */
export function textAssets(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [Buffer.from('header\0\0')]; // 読む側は先頭からの位置で4バイト境界にそろえる
  for (const [name, data] of entries) {
    const pad = (4 - (data.length % 4)) % 4;
    parts.push(lpString(name), int32(data.length), data, Buffer.alloc(pad));
  }
  return Buffer.concat(parts);
}

/** `bundle_info` を展開したものもどき。前に偽の `BundleInfoSO` を置く（本物の位置を探せるかを試す） */
export function bundleInfoRaw(bundles: string[], assets: [string, number][]): Buffer {
  return Buffer.concat([
    Buffer.alloc(8),
    lpString('BundleInfoSO'), int32(-1), // 偽物（型の情報などに現れる同じ名前）
    Buffer.alloc(12),
    lpString('BundleInfoSO'),
    int32(bundles.length), ...bundles.flatMap((n) => [lpString(n), int32(1234)]),
    int32(assets.length), ...assets.flatMap(([p, i]) => [lpString(p), int32(i)]),
    Buffer.alloc(16),
  ]);
}

/** UnityFS（バージョン6、ブロック情報は非圧縮）。blocks は [展開後, 格納する形, 圧縮の種類] */
export function makeUnityFS(blocks: [Buffer, Buffer, number][]): Buffer {
  const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const be16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const info = Buffer.concat([
    Buffer.alloc(16), // ハッシュ
    be32(blocks.length),
    ...blocks.flatMap(([u, c, kind]) => [be32(u.length), be32(c.length), be16(kind)]),
    Buffer.from('dir'), // ディレクトリ情報（読まない）
  ]);
  return Buffer.concat([
    Buffer.from('UnityFS\0'), be32(6), Buffer.from('5.x.x\0'), Buffer.from('2022.3.0f1\0'),
    Buffer.alloc(8), be32(info.length), be32(info.length), be32(0),
    info,
    ...blocks.map(([, c]) => c),
  ]);
}

type Fields = Record<string, { type: string; id: number; rule?: string }>;
type Json = { nested: { lq: { options: Record<string, unknown>; nested: Record<string, any> } } };

/** USED_METHODS と Wrapper・Record* だけの小さな定義（protobufjs の JSON） */
export function miniLiqi(): Json {
  const err: Fields = { error: { type: 'Error', id: 1 } };
  const nested: Record<string, any> = {
    Error: { fields: { code: { type: 'uint32', id: 1 } } },
    Wrapper: { fields: { name: { type: 'string', id: 1 }, data: { type: 'bytes', id: 2 } } },
    RecordGame: {
      fields: {
        uuid: { type: 'string', id: 1 },
        end_time: { type: 'uint32', id: 3 },
        accounts: { rule: 'repeated', type: 'AccountInfo', id: 11 },
      },
      nested: { AccountInfo: { fields: { account_id: { type: 'uint32', id: 1 }, seat: { type: 'uint32', id: 2 } } } },
    },
    GamePhase: { values: { a: 0, b: 1 } },
    Route: { methods: {} },
    Lobby: { methods: {} },
  };
  for (const m of USED_METHODS) {
    const [svc, name] = m.split('.');
    const cap = name[0].toUpperCase() + name.slice(1);
    nested[`Req${cap}`] = { fields: { x: { type: 'uint32', id: 1 } } };
    nested[`Res${cap}`] = { fields: { ...err, phase: { type: 'GamePhase', id: 2 } } };
    nested[svc].methods[name] = { requestType: `Req${cap}`, responseType: `Res${cap}` };
  }
  return { nested: { lq: { options: {}, nested } } };
}
