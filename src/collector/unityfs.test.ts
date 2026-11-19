import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleOf, lz4Block, readBundleInfo, readTextAsset, unityfs } from './unityfs.ts';
import { bundleInfoRaw, makeUnityFS, textAssets } from './testdata.ts';

// "abcd" の後に「4つ前から8バイト」の繰り返し → "abcdabcdabcd"
const LZ4_SAMPLE = Buffer.from([0x44, ...Buffer.from('abcd'), 0x04, 0x00]);

test('LZ4 のブロックを展開する', () => {
  assert.equal(lz4Block(LZ4_SAMPLE, 12).toString(), 'abcdabcdabcd');
  // 末尾がリテラルだけのブロック
  assert.equal(lz4Block(Buffer.from([0x30, ...Buffer.from('xyz')]), 3).toString(), 'xyz');
  assert.throws(() => lz4Block(LZ4_SAMPLE, 11));
  assert.throws(() => lz4Block(Buffer.from([0x14, 0x61, 0x05, 0x00]), 9), /offset/);
});

test('UnityFS の各ブロックを展開してつなぐ（非圧縮と LZ4）', () => {
  const plain = Buffer.from('hello ');
  const fs = makeUnityFS([[plain, plain, 0], [Buffer.from('abcdabcdabcd'), LZ4_SAMPLE, 2]]);
  assert.equal(unityfs(fs).toString(), 'hello abcdabcdabcd');
  assert.throws(() => unityfs(Buffer.from('NotUnity\0')), /not UnityFS/);
});

test('TextAsset を名前で切り出す。似た名前に惑わされない', () => {
  const raw = textAssets([
    ['luabyte/lua/protol/a_pb.lua.bytes', Buffer.from('path')],
    ['a_pb.lua', Buffer.from('A!')],
    ['b_pb.lua', Buffer.from('BBBBB')],
  ]);
  assert.equal(readTextAsset(raw, 'a_pb.lua').toString(), 'A!');
  assert.equal(readTextAsset(raw, 'b_pb.lua').toString(), 'BBBBB');
  assert.throws(() => readTextAsset(raw, 'c_pb.lua'), /not found/);
});

test('bundle_info から、資産のパスが入っているバンドル名を引く', () => {
  const raw = bundleInfoRaw(['shaders_x', 'u6v_ssuk_y', 'lua_z'], [
    ['MyAssets/docs/proto_config.bytes', 1],
    ['LuaByte/Lua/Protol/a_pb.lua.bytes', 2],
  ]);
  const info = readBundleInfo(raw);
  assert.deepEqual(info.bundles, ['shaders_x', 'u6v_ssuk_y', 'lua_z']);
  assert.equal(bundleOf(info, 'MyAssets/docs/proto_config.bytes'), 'u6v_ssuk_y');
  assert.equal(bundleOf(info, 'LuaByte/Lua/Protol/a_pb.lua.bytes'), 'lua_z');
  assert.throws(() => bundleOf(info, 'nope'), /not found/);
  assert.throws(() => readBundleInfo(Buffer.alloc(64)), /BundleInfoSO not found/);
});
