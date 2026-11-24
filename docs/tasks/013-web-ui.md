# 013 Web サービスの画面と API

状態: doing / 依存: 006、010、012、020、022 / 子タスク: 024〜028

## 目的
Admin（当面）が取り込み・選定をし、閲覧者がランキングを見られる画面と API を作る。
1セッションに収まらないので、2026-11-25 に子タスクに分けた（`docs/decisions.md` 2026-11-25 タスク 013 の分割）。このタスクは親として、子タスクがすべて済んだら done にする。

## 読むべき資料
- `docs/product.md`（利用者と操作）
- `docs/architecture.md`（Web サービスの構成、データモデル、API、非同期の処理、権限（タスク 022））

## 作業範囲（子タスクへの振り分け）
| 子タスク | 範囲 |
|---|---|
| [024](024-api-foundation.md) API の土台 | JWT の検証、`authorize()` と操作の表、ランキングの作成・一覧・名前の変更・削除、雀魂アカウントの指定、操作ログ |
| [025](025-refresh-and-import.md) 候補の更新と取り込み | ジョブと Lambda の自己起動、ロック・間隔、候補の更新、取り込み、対象外にする・戻す、作り直し、ランキングの JSON |
| [026](026-admin-ui.md) 管理の画面 | Vite + TypeScript + Preact の導入、ワークフローの変更、管理の操作の画面 |
| [027](027-viewer-ui.md) 閲覧者の画面 | ランキング（推測されない URL、noindex）。列ごとの並べ替えと、名前・期間・四麻か三麻かでの絞り込み。CSV などでの書き出しは用意しない |
| [028](028-enable-daily-refresh.md) 定期取得の有効化 | Scheduler を有効にするかの判断（2026-11-20 ユーザーの判断で後で決めるとしたもの） |

- 共通: 非エンジニアが迷わない画面にする（`docs/product.md` の非機能要件）。雀魂への要求は `docs/architecture.md` の運用に従う（ロック、間隔、上限）

## 完了条件
- Admin が画面だけで、主催者の新しい対局を取り込み、ランキングに反映できる
- 閲覧者が URL を開くだけでランキングを見られる

## メモ
- タスク 010 からの申し送り（`docs/deploy.md`「API と OAC」）: CloudFront の OAC が `Authorization` ヘッダーを上書きするので、Cognito の JWT は別の名前のヘッダーで送る。POST・PUT では本文の SHA-256 を `x-amz-content-sha256` に付ける
- 基盤にあるもの: Lambda の環境変数 `DATA_BUCKET` / `TABLE_NAME` / `SSM_PREFIX`、DynamoDB（`pk`/`sk`）、ランキングの JSON の置き場（画面用バケットの `rankings/`）、Scheduler `jantama-ranking-daily`（DISABLED。入力は `{"source":"scheduler","action":"refresh-candidates"}`）、Cognito のアプリクライアント（SRP）
- 画面は今 `web/public/` を sync しているだけ。Vite を入れたら、ワークフローの sync 元をビルド結果に変える
- タスク 014 からの申し送り: API は Cognito の JWT を `x-auth-token` ヘッダーで受けて検証し、Admin かどうかは `admins` グループで決める（2026-11-25 に `operators` から改名）。操作ログには Cognito の `sub` を書き、Discord の ID・表示名は書かない（`docs/decisions.md` 2026-11-20 タスク 014）
- 長い処理（雀魂への要求）は CloudFront の応答待ち（既定30秒）を超えうる。非同期にする案を、2026-11-20 のセッションで検討した（API がジョブを作って Lambda 自身を非同期で起動し、画面が状態を見る）
- タスク 020 からの申し送り: 管理の画面のコールバックは `admin.html`（本番と `http://localhost:5173/`）。アプリクライアントはシークレットなしで、認可コード＋PKCE（`web/public/admin.html` が仮の実装）。連携の利用者は自動のグループ（`<ユーザープール ID>_Discord`）にも入るので、Admin は `admins` の有無で判定する。操作ログには `sub` を書く（`cognito:username` は Discord の ID を含むので書かない）。`admin.html` は仮のページなので置き換える
- タスク 022 からの申し送り（`docs/architecture.md`「権限（タスク 022）」）: 役割は Admin（Cognito のグループ `admins`）・Host（ランキングごと）・Viewer。Cognito のグループは `operators` から `admins` に改名した（API の判定もこの名前で書く）。権限の判断は `authorize(利用者, 操作, ランキング ID)` の1か所にまとめ、操作と許す役割の表をコードに1つ持つ。当面は Admin だけが使うが、Host の項目（`RANKING#<ID>` / `MEMBER#<sub>` と逆向きの `USER#<sub>` / `RANKING#<ID>`）を読む道も作る。自分が付いていないランキングは 404。操作ログに `sub` と `via`（どの役割で許したか）を書く。対局の状態はランキングごとに持つ。手動の候補の更新の間隔は雀魂アカウントごとに制限する。Host の付け外しの画面は作らない（タスク 023）
- タスク 021 からの申し送り（`docs/decisions.md` 2026-11-25 タスク 021）: 1つのランキングに雀魂アカウントを複数指定できるようにする（ランキングと雀魂アカウントの対応を DynamoDB の項目で持つ）。候補は各アカウントの記録を合わせ、牌譜 uuid で重複を除く。最後に候補を更新した時刻と手動の更新の間隔は雀魂アカウント単位。雀魂アカウントの指定・変更は Host にも許す（`authorize()` の表に反映し、操作ログに書く）。主催者の本人確認は行わない
- 2026-11-25: 子タスク 024〜028 に分けた。データモデル・API・非同期の処理の設計を `docs/architecture.md` に書いた。下の申し送りは、関係する子タスクで読む（014・020・021・022 は主に 024・026、010 の OAC は 024・026、長い処理は 025）
