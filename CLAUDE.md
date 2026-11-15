# JantamaRanking

雀魂（Mahjong Soul）の友人戦の牌譜を集計してランキングにまとめる、半自動のツール群。
Vtuber の東風乃ちのさんのメン限友人戦向けに作ったもの。2024-11 以降止まっていたが、2026-11 に再開した。

## 主要な制約
- 牌譜の取得は雀魂のログイン済みセッションに依存する（Tampermonkey、または `PaifuImporter` の WebSocket 接続）。雀魂側の仕様変更で壊れうる
- 集計先は当面 Google スプレッドシートを続ける見込み。ただし GAS（Google Apps Script）への依存はやめたい。方針はタスクで検討する
- アクセストークンと牌譜データは公開リポジトリに載せない（`env.js`、`input/`、`output/` は gitignore 済み）
- 利用者は個人・小規模コミュニティで、エンジニアではない想定。商用サービスではない
- README と利用者向けの手順は、専門用語やリポジトリ構成を書かず、利用者目線で書く。開発者向けの情報は `CLAUDE.md` と `docs/` に置く

## コマンド
`PaifuImporter/` で実行する（Node.js。バージョンは未確認、タスク001で確認する）。
- `npm install`: 依存を入れる
- `node getPaifu.js`: `input/` の牌譜URL一覧を読み、牌譜 json を `output/` に書き出す
  - `env.js`（`URL_BASE` / `ACCESS_TOKEN` / `PREFERRED_SERVER` / `OAUTH_TYPE` をエクスポート）が必要。gitignore 済みなので手元で作る
  - 入力ファイル名が `getPaifu.js` 内にハードコードされている（`PaifuURLs_20231216.txt`）
- テストなし（`npm test` は未設定）

Tampermonkey スクリプトは `Tampermonkey/` にある。ブラウザの拡張に貼って使う。
- `GetPaifuURLs.js`: 雀魂の画面で L キー → 友人戦の牌譜URL一覧を `PaifuURLs_YYYYMMDD.txt` で保存
- `downloadlogs.js`: S キーで牌譜を json でダウンロード（Equim-chan 作の downloadlogs のフォーク）

## 文書の地図
| 文書 | 内容 |
|---|---|
| `docs/product.md` | 何を作るか。目的、機能・非機能要件、スコープ外、未決事項 |
| `docs/architecture.md` | どう作るか。構成要素、データの流れ、リポジトリ構成、牌譜 json |
| `docs/decisions.md` | 決定ログ（追記のみ） |
| `docs/tasks/README.md` | タスク一覧と状態。セッション開始時の入口 |
| `docs/tasks/NNN-*.md` | タスクごとの詳細 |
| `architecture.png` | 全体像の図（取得→Drive→GAS→スプレッドシート） |

## セッションの進め方
1セッション1タスクを基本とする。
1. `docs/tasks/README.md` で担当するタスクを確認する
2. そのタスクファイルの「読むべき資料」だけを読む（他の文書は必要になるまで読まない）
3. 作業後、タスクファイルの状態とメモ、`docs/tasks/README.md` の状態を更新する
4. 新しい決定は `docs/decisions.md` に追記する。設計文書の内容と食い違ったら設計文書も直す
5. 範囲外の気づきは、新しいタスクとして `docs/tasks/` に起票する

## 規約
- 文書は日本語。コード識別子は英語
- コミットメッセージは英語で短く
- `env.js`、トークン、牌譜データ（`input/` `output/`）はコミットしない
- 外部由来のコード（`downloadlogs.js` など）は、出典を冒頭コメントに残す
- 雀魂のサーバーへ繰り返しアクセスするコードは、間隔を空ける（負荷をかけない）
