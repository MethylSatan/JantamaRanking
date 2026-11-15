# アーキテクチャ

全体像の図は `architecture.png`（①牌譜を開く → ②牌譜ファイル取得 → ③Drive へアップロード → ④スクリプト実行 → ⑤牌譜データ取得 → ⑥スプレッドシートへ投入）。

## 構成要素
| 要素 | 場所 | 役割 |
|---|---|---|
| GetPaifuURLs | `Tampermonkey/GetPaifuURLs.js` | **WebGL 版では動かない（2026-11 時点）。** 雀魂の画面で L キー。`fetchGameRecordList`（type=1: 友人戦、最大30件）を呼び、URLと対戦者名を `PaifuURLs_YYYYMMDD.txt` に保存 |
| downloadlogs | `Tampermonkey/downloadlogs.js` | **WebGL 版では動かない（2026-11 時点）。** S キーで、開いている牌譜を json でダウンロード。Equim-chan 作のフォーク |
| PaifuImporter | `PaifuImporter/` | Node。`getPaifu.js` が `majsoul.js` で雀魂に WebSocket 接続し、URL一覧の各牌譜を `fetchGameRecord` で取得、`parse()` で変換して `output/` に json 保存 |
| token.js | `misc/token.js` | WebSocket メッセージ（hex）からアクセストークンを取り出す補助 |
| 牌譜回収（実装予定） | 未定（タスク 006） | 運営のアカウントで、主催者の友人戦一覧（`fetchAccountInfoExtra`）と中身（`fetchGameRecordsDetail`）を取る。検証用の試作は `local/probe/`（gitignore 済み） |
| Drive / GAS / スプレッドシート | リポジトリ外 | 牌譜の置き場、投入スクリプト、集計。GAS スクリプトは未管理 |

## データの流れ
雀魂のブラウザ版は Unity WebGL 版へ置き換わり（時期は未確認。2026-11 時点で確認）、Tampermonkey の2本は動かなくなった（タスク 001）。代わりに、運営のアカウントから主催者の友人戦を取る方式にする（タスク 005、`docs/decisions.md` 2026-11-16）。
```
新: 雀魂 ──(運営のアカウント: 主催者の友人戦一覧 → uuid → 中身)──▶ 牌譜 json
```
旧（参考）:
```
雀魂 ──(Tampermonkey)──▶ 牌譜URL一覧 .txt ──(PaifuImporter)──▶ 牌譜 json
雀魂 ──(downloadlogs)──────────────────────────────────────▶ 牌譜 json
牌譜 json ──▶ Google Drive ──(GAS)──▶ スプレッドシート（試合結果シート）──▶ 集計
```

## PaifuImporter の詳細
- CommonJS。依存は `protobufjs` / `ws` / `request-promise` / `uuid@3` など（古い。更新はタスクで検討）
- 認証: `env.js`（gitignore 済み）から `URL_BASE` / `ACCESS_TOKEN` / `PREFERRED_SERVER` / `OAUTH_TYPE` を読む
- 入力: `input/` の牌譜URL一覧（ファイル名は `getPaifu.js` にハードコード）
- 出力: `output/YYYY_MM_DD-hh_mm_ss_<ルール表示>.json`。`parse()` の結果は downloadlogs 由来の mjlog 形式（`ver: "2.3"`、`ref` は牌譜 uuid、`rule` など）
- 時刻は `TZ=Asia/Tokyo` 固定

## 雀魂の WebGL 版の通信（タスク 001・005 で確認）
- 接続先は `wss://jpgs.mahjongsoul.com/gateway`。ログイン後に `jpgsbk.mahjongsoul.com/gateway` も張る。最初に `.lq.Route.requestConnection` を送る
- 形式は従来どおり liqi（protobuf）。定義は `version.json` → `resversion<ver>.json` → `liqi.json` で取れる
- `client_version_string` は `WebGL_2022-0.16.280` の形式
- 他人を指定できる主な要求: `searchAccountByEid`（表示 ID → 内部 ID）、`fetchAccountInfoExtra(account_id, category, type)`（`category` 1=四麻/2=三麻、`type` 1=段位戦/2=友人戦。最新50件、2024-08 ごろ以降）

## 既知の注意点
- 雀魂側のプロトコル・バージョン変更で動かなくなりうる（`majsoul.js` は 2024-11 の修正が最後）
- `getPaifu.js` はグローバル変数の暗黙宣言が多い（`paifuURLs`, `uuids` など）
