# 013 Web サービスの画面と API

状態: todo / 依存: 006、010、012、020

## 目的
運営が取り込み・選定をし、閲覧者がランキングを見られる画面と API を作る。

## 読むべき資料
- `docs/product.md`（利用者と操作）
- `docs/architecture.md`（Web サービスの構成、データモデル、負荷を抑える運用）

## 作業範囲
- 運営の画面（Discord でログイン。Cognito の Hosted UI 経由、タスク 020）: ランキング（企画）の作成 → 主催者の指定 → 候補の対局の一覧（日時・ルール・参加者）→ 取り込む / 対象外にする
- 運営の画面: 取り込み済みの対局を対象外に戻す・対象外から戻す操作、操作ログの表示、牌譜からの作り直し（`docs/architecture.md`「作り直し・取り消し・履歴」）
- 閲覧者の画面: ランキング（推測されない URL、noindex）。列ごとの並べ替えと、名前・期間・四麻か三麻かでの絞り込み。CSV などでの書き出しは用意しない
- API: 候補の更新、取り込み、対象外にする。雀魂への要求は `docs/architecture.md` の運用に従う（ロック、間隔、上限）
- 定期取得（EventBridge Scheduler から1日1回程度）。013 で有効にするかは後で決める（2026-11-20 ユーザーの判断）
- 画面は Vite + TypeScript + Preact で作る（`docs/decisions.md` 2026-11-20 タスク 019）
- 非エンジニアが迷わない画面にする（`docs/product.md` の非機能要件）

## 完了条件
- 運営が画面だけで、主催者の新しい対局を取り込み、ランキングに反映できる
- 閲覧者が URL を開くだけでランキングを見られる

## メモ
- タスク 010 からの申し送り（`docs/deploy.md`「API と OAC」）: CloudFront の OAC が `Authorization` ヘッダーを上書きするので、Cognito の JWT は別の名前のヘッダーで送る。POST・PUT では本文の SHA-256 を `x-amz-content-sha256` に付ける
- 基盤にあるもの: Lambda の環境変数 `DATA_BUCKET` / `TABLE_NAME` / `SSM_PREFIX`、DynamoDB（`pk`/`sk`）、ランキングの JSON の置き場（画面用バケットの `rankings/`）、Scheduler `jantama-ranking-daily`（DISABLED。入力は `{"source":"scheduler","action":"refresh-candidates"}`）、Cognito のアプリクライアント（SRP）
- 画面は今 `web/public/` を sync しているだけ。Vite を入れたら、ワークフローの sync 元をビルド結果に変える
- タスク 014 からの申し送り: API は Cognito の JWT を `x-auth-token` ヘッダーで受けて検証し、運営かどうかは `operators` グループで決める。操作ログには Cognito の `sub` を書き、Discord の ID・表示名は書かない（`docs/decisions.md` 2026-11-20 タスク 014）
- 長い処理（雀魂への要求）は CloudFront の応答待ち（既定30秒）を超えうる。非同期にする案を、2026-11-20 のセッションで検討した（API がジョブを作って Lambda 自身を非同期で起動し、画面が状態を見る）
- タスク 020 からの申し送り: 運営の画面のコールバックは `admin.html`（本番と `http://localhost:5173/`）。アプリクライアントはシークレットなしで、認可コード＋PKCE（`web/public/admin.html` が仮の実装）。連携の利用者は自動のグループ（`<ユーザープール ID>_Discord`）にも入るので、運営は `operators` の有無で判定する。操作ログには `sub` を書く（`cognito:username` は Discord の ID を含むので書かない）。`admin.html` は仮のページなので置き換える
