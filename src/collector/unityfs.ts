// 雀魂の WebGL 版の静的ファイル（Unity の AssetBundle、UnityFS 形式）を読む。
// 対応するのは、雀魂の静的ファイルで使われている形（LZ4 圧縮、ブロック情報が先頭にある）だけ。

/** LZ4 のブロックを展開する（フレーム形式ではない） */
export function lz4Block(src: Uint8Array, size: number): Buffer {
  const dst = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const tok = src[i++];
    let lit = tok >> 4;
    if (lit === 15) {
      let b;
      do { b = src[i++]; lit += b; } while (b === 255);
    }
    dst.set(src.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    if (off === 0 || off > o) throw new Error(`lz4: bad offset ${off} at ${o}`);
    let ml = tok & 15;
    if (ml === 15) {
      let b;
      do { b = src[i++]; ml += b; } while (b === 255);
    }
    ml += 4;
    if (o + ml > size) throw new Error('lz4: output overflow');
    for (let k = 0; k < ml; k++, o++) dst[o] = dst[o - off];
  }
  if (o !== size) throw new Error(`lz4: size mismatch ${o} != ${size}`);
  return dst;
}

function decompress(buf: Buffer, size: number, kind: number): Buffer {
  if (kind === 0) return buf;
  if (kind === 2 || kind === 3) return lz4Block(buf, size);
  throw new Error(`UnityFS: compression ${kind} not supported`);
}

/** UnityFS を展開し、全ブロックをつないだ中身を返す */
export function unityfs(b: Buffer): Buffer {
  let p = 0;
  const cstr = () => {
    const e = b.indexOf(0, p);
    if (e < 0) throw new Error('UnityFS: bad header');
    const s = b.toString('latin1', p, e);
    p = e + 1;
    return s;
  };
  if (cstr() !== 'UnityFS') throw new Error('not UnityFS');
  const ver = b.readUInt32BE(p);
  p += 4;
  cstr(); // 再生側のバージョン
  cstr(); // エンジンのバージョン
  p += 8; // 全体の大きさ
  const csize = b.readUInt32BE(p);
  const usize = b.readUInt32BE(p + 4);
  const flags = b.readUInt32BE(p + 8);
  p += 12;
  if (flags & 0x80) throw new Error('UnityFS: blocks info at end: not supported');
  if (ver >= 7) p = (p + 15) & ~15;
  const info = decompress(b.subarray(p, p + csize), usize, flags & 0x3f);
  p += csize;
  if (flags & 0x200) p = (p + 15) & ~15;
  let q = 16; // 先頭16バイトはハッシュ
  const n = info.readInt32BE(q);
  q += 4;
  const out: Buffer[] = [];
  for (let k = 0; k < n; k++, q += 10) {
    const u = info.readUInt32BE(q);
    const c = info.readUInt32BE(q + 4);
    const f = info.readUInt16BE(q + 8);
    out.push(decompress(b.subarray(p, p + c), u, f & 0x3f));
    p += c;
  }
  return Buffer.concat(out);
}

/** 長さ付きの文字列（int32 LE + 本体、4バイト境界にそろえる）を探す時の鍵 */
function lengthPrefixed(name: string): Buffer {
  const key = Buffer.alloc(4 + Buffer.byteLength(name, 'latin1'));
  key.writeInt32LE(key.length - 4);
  key.write(name, 4, 'latin1');
  return key;
}

/** 展開済みのバンドルから、TextAsset の中身を名前で切り出す。無ければ例外 */
export function readTextAsset(raw: Buffer, name: string): Buffer {
  const key = lengthPrefixed(name);
  const at = raw.indexOf(key);
  if (at < 0) throw new Error(`TextAsset not found: ${name}`);
  const p = (at + key.length + 3) & ~3;
  const n = raw.readInt32LE(p);
  if (n < 0 || p + 4 + n > raw.length) throw new Error(`TextAsset: bad length for ${name}`);
  return raw.subarray(p + 4, p + 4 + n);
}

export interface BundleInfo {
  /** バンドル名（番号順） */
  bundles: string[];
  /** 資産のパス → バンドルの番号 */
  assets: Map<string, number>;
}

/**
 * `bundle_info_so.majset` を展開したもの（Unity の直列化）を読む。
 * `BundleInfoSO` という名前の後に、「バンドル名 + int32」の配列、「資産のパス + バンドルの番号」の配列が続く。
 */
export function readBundleInfo(raw: Buffer): BundleInfo {
  // 同じ名前が型の情報などにも現れるので、最後まで正しく読めた位置を使う
  const marker = lengthPrefixed('BundleInfoSO');
  let lastError: unknown = new Error('bundle_info: BundleInfoSO not found');
  for (let at = raw.indexOf(marker); at >= 0; at = raw.indexOf(marker, at + 1)) {
    try {
      return readBundleInfoAt(raw, (at + marker.length + 3) & ~3);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function readBundleInfoAt(raw: Buffer, start: number): BundleInfo {
  let p = start;
  const int = () => {
    if (p + 4 > raw.length) throw new Error('bundle_info: unexpected end');
    const v = raw.readInt32LE(p);
    p += 4;
    return v;
  };
  const str = () => {
    const l = int();
    if (l < 0 || p + l > raw.length) throw new Error('bundle_info: bad string');
    const s = raw.toString('latin1', p, p + l);
    p = (p + l + 3) & ~3;
    return s;
  };
  const nb = int();
  if (nb <= 0 || nb * 8 > raw.length) throw new Error('bundle_info: bad bundle count');
  const bundles: string[] = [];
  for (let i = 0; i < nb; i++) {
    bundles.push(str());
    int(); // 大きさとみられる値（使わない）
  }
  const na = int();
  if (na <= 0 || na * 8 > raw.length) throw new Error('bundle_info: bad asset count');
  const assets = new Map<string, number>();
  for (let i = 0; i < na; i++) {
    const path = str();
    const idx = int();
    if (idx < 0 || idx >= nb) throw new Error(`bundle_info: bad bundle index ${idx}`);
    assets.set(path, idx);
  }
  return { bundles, assets };
}

/** 資産のパスから、それが入っているバンドル名を返す。無ければ例外 */
export function bundleOf(info: BundleInfo, assetPath: string): string {
  const idx = info.assets.get(assetPath);
  if (idx === undefined) throw new Error(`bundle_info: asset not found: ${assetPath}`);
  return info.bundles[idx];
}
