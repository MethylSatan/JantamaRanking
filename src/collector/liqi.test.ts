import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiqi, decryptPbLua, diffUsedTypes, loadRoot, luaToProtobufJson, xorDecrypt } from './liqi.ts';
import { PB_LUA_NAMES } from './static.ts';
import { miniLiqi, textAssets } from './testdata.ts';

// protoc-gen-lua の生成物と同じ書き方の、小さな定義。別ファイルの型は `b.X` で参照する
const STRUCT_LUA = `local a=require"protobuf.protobuf"module('Protol.com_struct_pb')
COLOR=a.EnumDescriptor()COLOR_RED_ENUM=a.EnumValueDescriptor()COLOR_BLUE_ENUM=a.EnumValueDescriptor()
COLOR_RED_ENUM.name="RED"COLOR_RED_ENUM.index=0;COLOR_RED_ENUM.number=0;
COLOR_BLUE_ENUM.name="BLUE"COLOR_BLUE_ENUM.index=1;COLOR_BLUE_ENUM.number=3;
COLOR.name="Color"COLOR.full_name=".lq.Color"COLOR.values={COLOR_RED_ENUM,COLOR_BLUE_ENUM}
POINT=a.Descriptor()POINT_X_FIELD=a.FieldDescriptor()
POINT_X_FIELD.name="x"POINT_X_FIELD.full_name=".lq.Point.x"POINT_X_FIELD.number=1;POINT_X_FIELD.label=1;POINT_X_FIELD.type=5;
POINT.name="Point"POINT.full_name=".lq.Point"POINT.fields={POINT_X_FIELD}`;
const LOBBY_LUA = `local a=require"protobuf.protobuf"local b=require("Protol.com_struct_pb")module('Protol.cli_lobby_pb')
REQSHAPE=a.Descriptor()REQSHAPE_NAME_FIELD=a.FieldDescriptor()REQSHAPE_POINTS_FIELD=a.FieldDescriptor()REQSHAPE_IDS_FIELD=a.FieldDescriptor()REQSHAPE_COLOR_FIELD=a.FieldDescriptor()
REQSHAPE_NAME_FIELD.name="name"REQSHAPE_NAME_FIELD.full_name=".lq.ReqShape.name"REQSHAPE_NAME_FIELD.number=1;REQSHAPE_NAME_FIELD.label=1;REQSHAPE_NAME_FIELD.type=9;
REQSHAPE_POINTS_FIELD.name="points"REQSHAPE_POINTS_FIELD.full_name=".lq.ReqShape.points"REQSHAPE_POINTS_FIELD.number=2;REQSHAPE_POINTS_FIELD.label=3;REQSHAPE_POINTS_FIELD.type=11;REQSHAPE_POINTS_FIELD.message_type=b.POINT
REQSHAPE_IDS_FIELD.name="ids"REQSHAPE_IDS_FIELD.full_name=".lq.ReqShape.ids"REQSHAPE_IDS_FIELD.number=3;REQSHAPE_IDS_FIELD.label=3;REQSHAPE_IDS_FIELD.type=13;
REQSHAPE_COLOR_FIELD.name="color"REQSHAPE_COLOR_FIELD.full_name=".lq.ReqShape.color"REQSHAPE_COLOR_FIELD.number=4;REQSHAPE_COLOR_FIELD.label=1;REQSHAPE_COLOR_FIELD.type=14;REQSHAPE_COLOR_FIELD.enum_type=b.COLOR
REQSHAPE.name="ReqShape"REQSHAPE.full_name=".lq.ReqShape"REQSHAPE.fields={REQSHAPE_NAME_FIELD,REQSHAPE_POINTS_FIELD,REQSHAPE_IDS_FIELD,REQSHAPE_COLOR_FIELD}
RESSHAPE=a.Descriptor()RESSHAPE_OK_FIELD=a.FieldDescriptor()
RESSHAPE_OK_FIELD.name="ok"RESSHAPE_OK_FIELD.full_name=".lq.ResShape.ok"RESSHAPE_OK_FIELD.number=1;RESSHAPE_OK_FIELD.label=1;RESSHAPE_OK_FIELD.type=8;
RESSHAPE.name="ResShape"RESSHAPE.full_name=".lq.ResShape"RESSHAPE.fields={RESSHAPE_OK_FIELD}`;
const CONFIG = { service: { Lobby: { draw: { request: 'ReqShape', response: 'ResShape' }, debug: { request: 'ReqNope', response: 'ResShape' } } } };

test('Lua の定義から protobufjs の JSON を作る', () => {
  const r = luaToProtobufJson(new Map([['com_struct_pb', STRUCT_LUA], ['cli_lobby_pb', LOBBY_LUA]]), CONFIG);
  assert.equal(r.messages, 3);
  assert.equal(r.enums, 1);
  assert.equal(r.methods, 1);
  assert.deepEqual(r.skipped, ['Lobby.debug']); // 定義の無い型を使うメソッドは外す
  const lq = r.json.nested.lq.nested as Record<string, any>;
  assert.deepEqual(lq.ReqShape.fields, {
    name: { type: 'string', id: 1 },
    points: { rule: 'repeated', type: 'Point', id: 2 },
    ids: { rule: 'repeated', type: 'uint32', id: 3, options: { packed: false } }, // 数値の repeated は packed にしない
    color: { type: 'Color', id: 4 },
  });
  assert.deepEqual(lq.Color.values, { RED: 0, BLUE: 3 });

  // protobufjs で読めて、ゲームと同じく packed にせずに送る
  const root = loadRoot(r.json);
  const Req = root.lookupType('lq.ReqShape');
  const bytes = Req.encode(Req.fromObject({ ids: [1, 2] })).finish();
  assert.deepEqual([...bytes], [0x18, 1, 0x18, 2]);
});

test('暗号化された定義を取り出して復号する', () => {
  const key = Buffer.from('dummy-key-123456');
  const enc = (s: string) => xorDecrypt(Buffer.from(s, 'latin1'), key); // XOR なので同じ関数で暗号化できる
  const lua = new Map<string, string>(PB_LUA_NAMES.map((n) => [n, `-- ${n}`]));
  lua.set('com_struct_pb', STRUCT_LUA);
  lua.set('cli_lobby_pb', LOBBY_LUA);
  const bundle = textAssets([...lua].map(([n, s]) => [`${n}.lua`, enc(s)]));
  const out = decryptPbLua(bundle, key);
  assert.equal(out.get('cli_lobby_pb'), LOBBY_LUA);
  assert.equal(out.size, PB_LUA_NAMES.length);

  const protoConfigBundle = textAssets([['proto_config', Buffer.from(JSON.stringify(CONFIG))]]);
  assert.equal(buildLiqi({ protoConfigBundle, luaBundle: bundle }, key).methods, 1);
  assert.throws(() => decryptPbLua(textAssets([['client_pb.lua', Buffer.from('x')]]), key), /not found/);
});

test('使っている型が同じか、項目が増えただけなら、変更なしとみなす', () => {
  const old = miniLiqi();
  assert.deepEqual(diffUsedTypes(old, miniLiqi()), []);
  const grown = miniLiqi();
  grown.nested.lq.nested.RecordGame.fields.robots = { type: 'uint32', id: 20 };
  grown.nested.lq.nested.Unrelated = { fields: { a: { type: 'string', id: 1 } } };
  assert.deepEqual(diffUsedTypes(old, grown), []);
});

test('使っている型の項目番号・型・repeated が変わったり、消えたりしたら列挙する', () => {
  const old = miniLiqi();
  const changed = miniLiqi();
  const lq = changed.nested.lq.nested;
  lq.RecordGame.fields.end_time.id = 4;
  lq.RecordGame.nested.AccountInfo.fields.seat.type = 'string';
  delete lq.RecordGame.fields.uuid;
  lq.GamePhase.values.b = 2;
  lq.Lobby.methods.fetchGameRecordsDetail.responseType = 'ResOauth2Auth';
  const changes = diffUsedTypes(old, changed);
  assert.ok(changes.some((c) => c.startsWith('.lq.RecordGame.end_time: 3/uint32 → 4/uint32')), changes.join('\n'));
  assert.ok(changes.some((c) => c.startsWith('.lq.RecordGame.AccountInfo.seat:')));
  assert.ok(changes.some((c) => c === '.lq.RecordGame.uuid: 項目が無い'));
  assert.ok(changes.some((c) => c === '.lq.GamePhase.b: 1 → 2'));
  assert.ok(changes.some((c) => c.startsWith('Lobby.fetchGameRecordsDetail:')));
});

test('使っていない型の変更は無視する', () => {
  const old = miniLiqi();
  old.nested.lq.nested.Amulet = { fields: { a: { type: 'string', id: 1 } } };
  const changed = miniLiqi();
  changed.nested.lq.nested.Amulet = { fields: { a: { type: 'uint32', id: 9 } } };
  assert.deepEqual(diffUsedTypes(old, changed), []);
});
