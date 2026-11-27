# JantamaRanking

雀魂（Mahjong Soul）の友人戦の牌譜を集計してランキングにまとめる、半自動のツール群。
Vtuber の東風乃ちのさんのメン限友人戦向けに作ったもの。2024-11 以降止まっていたが、2026-11 に再開した。

## 主要な制約
- 牌譜の取得は雀魂のログイン済みセッションに依存する（Tampermonkey、または `PaifuImporter` の WebSocket 接続）。雀魂側の仕様変更で壊れうる
- 集計は Web サービスの中で行い、ランキングは Web ページで見せる。Google スプレッドシートと GAS（Google Apps Script）はやめる（`docs/decisions.md` 2026-11-19「Web サービスの構成」）。旧方式の利点（作り直せる、誤りを戻せる、自由に並べ替えられる）は非機能要件として引き継ぐ（`docs/product.md`）
- 旧スプレッドシートは、移行が済むまで変更しない（場所は `docs/local/003-sheet-notes.md`）
- アクセストークンと牌譜データは公開リポジトリに載せない（`env.js`、`input/`、`output/` は gitignore 済み）
- 利用者は個人・小規模コミュニティで、エンジニアではない想定。商用サービスではない
- 目指す形は、牌譜の取り込みと集計対象の選定をセルフサービスで行える Web サービス。雀魂への接続はサーバー側の Node から直接行う（L2）のが前提で、ブラウザ相乗り（L1）は最終手段（`docs/product.md`）
- 利用者向けの手順は、サイトのヘルプページ（`web/public/help.html`）に、専門用語やリポジトリ構成を書かず、利用者目線で書く（利用者はリポジトリを見ない）。README はリポジトリの紹介とヘルプページへのリンクだけにする。開発者向けの情報は `CLAUDE.md` と `docs/` に置く

## コマンド
リポジトリ直下（集計 `src/ranking/`、牌譜回収 `src/collector/`。Node 26 で `.ts` を直接実行する）:
- `npm install` / `npm test`（`node --test`）/ `npm run typecheck`
- `npm run dev`: 管理の画面を手元で立てる（Vite、`http://localhost:5173/admin.html`。API は本番に向く。`docs/deploy.md`「手元の開発」）
- `npm run build:web`: 画面を `dist/web/` にビルドする（Vite + Preact。ソースは `web/`）
- `npm run build:api`: Lambda 用に `src/api/handler.ts` を `dist/api/index.mjs` にまとめる（esbuild）
- `npm run apicheck -- smoke`: 本番の API を Admin のトークンで確かめる（`login` / `smoke` / `call`。`docs/deploy.md`「確認」）
- `node src/collector/cli.ts <コマンド>`: 牌譜回収を手元で試す（`candidates` / `fetch` / `exclude` / `update-static`）。状態は `local/collector/`。手順は `docs/collector.md`
- `node src/migrate/legacy.ts <fetch|compare|upload>`: 旧方式の牌譜の移行（実施済み。一度きり）。入出力は `local/legacy/`

`PaifuImporter/` で実行する（Node.js。バージョンは未確認）。
- `npm install`: 依存を入れる
- `node getPaifu.js`: `input/` の牌譜URL一覧を読み、牌譜 json を `output/` に書き出す
  - `env.js`（`URL_BASE` / `ACCESS_TOKEN` / `PREFERRED_SERVER` / `OAUTH_TYPE` をエクスポート）が必要。gitignore 済みなので手元で作る
  - 入力ファイル名が `getPaifu.js` 内にハードコードされている（`PaifuURLs_20231216.txt`）
- テストなし

Tampermonkey スクリプトは `Tampermonkey/` にある。ブラウザの拡張に貼って使う。
- `GetPaifuURLs.js`: 雀魂の画面で L キー → 友人戦の牌譜URL一覧を `PaifuURLs_YYYYMMDD.txt` で保存
- `downloadlogs.js`: S キーで牌譜を json でダウンロード（Equim-chan 作の downloadlogs のフォーク）

## 文書の地図
| 文書 | 内容 |
|---|---|
| `docs/product.md` | 何を作るか。目的、機能・非機能要件、スコープ外、未決事項 |
| `docs/architecture.md` | どう作るか。全体像の図（Mermaid）、構成要素、データの流れ、リポジトリ構成、牌譜 json |
| `docs/collector.md` | 牌譜回収の CLI の使い方 |
| `docs/deploy.md` | AWS の構成（`infra/`）、デプロイ、費用、OAC の注意 |
| `docs/decisions.md` | 決定ログ（追記のみ） |
| `docs/tasks/README.md` | タスク一覧と状態。セッション開始時の入口 |
| `docs/tasks/NNN-*.md` | タスクごとの詳細 |
| `docs/local/` | ローカル限定のメモ（gitignore 済み。別の環境には無いことがある）。入口は `docs/local/README.md` |

## セッションの進め方
1セッション1タスクを基本とする。
1. `docs/tasks/README.md` で担当するタスクを確認する
2. そのタスクファイルの「読むべき資料」だけを読む（他の文書は必要になるまで読まない）
3. 作業後、タスクファイルの状態とメモ、`docs/tasks/README.md` の状態を更新する
4. 新しい決定は `docs/decisions.md` に追記する。設計文書の内容と食い違ったら設計文書も直す
5. 範囲外の気づきは、新しいタスクとして `docs/tasks/` に起票する

## 規約
- 文書は日本語。コード識別子は英語
- 設計文書（`docs/product.md`・`architecture.md`・`deploy.md`・`collector.md`）と `CLAUDE.md` は今の姿を書き、タスク番号を書かない。どのタスクで決めた・作ったかは、`docs/decisions.md`（見出しにタスク番号）とタスクファイルに書く。決定ログを指すときは日付と見出しの題名で指す（例: `docs/decisions.md` 2026-11-25「権限の設計」）。まだ終わっていない作業を指すときだけ、タスク番号を書いてよい
- コミットメッセージは英語で短く
- `env.js`、トークン、牌譜データ（`input/` `output/`）はコミットしない
- 公開リポジトリなので、機微な内容は `docs/local/` に書く。対象は、規約などについての判断、検証に使ったアカウント、個人の対局の具体（日時・件数・ニックネーム）。公開側の文書には、API の仕様や設計の要旨だけを書き、必要なら `docs/local/` を指す
- アカウント ID・トークンは、`docs/local/` にも書かない。使う場所（`local/probe/targets*.json` など）にだけ置く
- 外部由来のコード（`downloadlogs.js` など）は、出典を冒頭コメントに残す
- 雀魂のサーバーへ繰り返しアクセスするコードは、間隔を空ける（負荷をかけない）
