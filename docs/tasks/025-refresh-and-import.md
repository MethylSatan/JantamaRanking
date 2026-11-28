# 025 候補の更新と取り込み（雀魂への要求）

状態: done / 依存: 024、006、012（親: 013）

## 目的
API から雀魂に要求して候補を更新し、選んだ対局を取り込み、ランキングの JSON を作る。対象外にする・戻す、牌譜からの作り直しもここで作る。

## 読むべき資料
- `docs/architecture.md`「データモデル」「API」「非同期の処理」「雀魂に負荷をかけない運用」「作り直し・取り消し・履歴」「牌譜回収」「集計（Web サービス）」
- `src/collector/index.ts`、`src/ranking/index.ts`
- `docs/tasks/013-web-ui.md` のメモ（長い処理、基盤にあるもの）

## 作業範囲
- ジョブ: 項目の作成、自分の Lambda の非同期の起動、状態の更新。IAM に自分の `lambda:InvokeFunction` を足す（`infra/api.tf`）
- ロック（`LOCK` / `MAJSOUL`、条件付き書き込み、期限）と、雀魂アカウントごとの手動の候補の更新の間隔
- collector の組み込み: 雀魂のバージョンと定義は S3、認証情報と定義の鍵は SSM。表示用 ID から内部 ID を引く（最初の更新）
- 候補の更新: 雀魂アカウントごとに候補の対局を保存し、ランキングごとに uuid で合わせて出す。一覧の上限の警告を画面に渡す
- 取り込み: 牌譜（head）を S3 `records/<uuid>.json` に置き、`fromRecordGame` で `GameResult` を作ってランキングの対局の状態に持つ。ランキングの JSON を作り直して site バケットの `rankings/<公開 ID>.json` に置く
- 対象外にする・戻す、牌譜からの作り直し、公開 ID の取り直し
- Scheduler の入力（`{"source":"scheduler","action":"refresh-candidates"}`）を処理する道（有効にするのはタスク 028）
- ランキングの JSON の形を決める（027 の画面が並べ替え・絞り込みできるよう、対局単位の結果を含めるか、集計済みにするか）

## 完了条件
- API だけで、主催者の新しい対局を候補に出し、取り込み、ランキングの JSON に反映できる
- 対象外にした対局が JSON から外れ、戻すと入る。作り直しで同じ JSON になる

## メモ
- 2026-11-25 に 013 から分けた（`docs/decisions.md` 2026-11-25 タスク 013 の分割）
- ~~未決（ユーザーと決める）: 手動の候補の更新の間隔の値。公開 ID を取り直したときの古い JSON の扱い（今の IAM に `DeleteObject` は無い）。ジョブ・候補の項目を消すか（DynamoDB の TTL を有効にするか）~~ → 間隔は5秒、古い JSON は消す。項目を消すかは未決のまま（下）
- 雀魂へ繰り返しアクセスする処理なので、間隔と上限は `docs/architecture.md` の運用に従う

### 2026-11-25 実装と本番での確認
- 先に取り込みの手順を決めた（`docs/architecture.md`「取り込みの手順」）。決定は `docs/decisions.md` 2026-11-25 タスク 025
  - 手動の候補の更新の間隔: 雀魂アカウントごとに5秒（ユーザー: 数秒は待たせてよい）。ロックは全体で1つ、使われていれば最大60秒待つ
  - 公開 ID を取り直したら古い JSON は消す（ユーザー）。ランキングの削除でも消す
  - ランキングの JSON は `{ version, name, generatedAt, games: GameResult[] }`（取り込み済みだけ）。集計は画面で行う（027）
- 実装: `src/api/jobs.ts`（ジョブ・ロック・候補の更新・取り込み・作り直し・定期取得）、`games.ts`（候補の合わせ方・JSON）、`blobs.ts`・`aws.ts`（S3・SSM・Lambda の起動）、`routes.ts`・`handler.ts`（API とイベントの振り分け）、`store.ts`（項目）。テストは `src/api/games.test.ts`（偽の雀魂・メモリの Store と S3）
- infra: Lambda に `SITE_BUCKET`、IAM に自分の `lambda:InvokeFunction` と `rankings/*` の `s3:DeleteObject`。SSM に認証情報と定義の鍵を入れた（`docs/deploy.md` 手順 8）
- ビルドの不具合を直した: collector を組み込んだら、ESM のバンドルで `ws` の `require("events")` が読み込みで失敗した。`node -e` では `require` があるので通ってしまう。banner で `createRequire` を入れた
- 本番の確認（`npm run apicheck -- flow`）: 候補の更新 → 取り込み1件 → 公開の URL の JSON → 対象外・戻す → 作り直しで同じ JSON → 公開 ID の取り直しで古い URL が 403、まで通った。雀魂へのログインはこのセッションで3回（候補の更新2回、取り込み1回。2回目の取り込みは S3 の牌譜を使いログインしなかった）。最初の実行で、雀魂のバージョン（0.16.289）と定義が静的ファイルから作られ、data バケットの `state/` に置かれた。通知・誤りは出ていない
  - 1回目の確認は、確認の側で失敗した: 戻した直後に読んだ公開の JSON が古かった。CloudFront の `Managed-CachingOptimized` は `no-cache` でも最短1秒は覚えるため。閲覧者には問題ないので、確認の側で反映を待つようにした
  - 確認に使った雀魂アカウントは主催者ではなく、手元の `local/probe/targets.json` の `main`（ユーザーの判断）

### 残り（他のタスクへ）
- ジョブ・候補の対局の項目を消すか（DynamoDB の TTL）: 手順が画面で固まってから決める（026 以降。ユーザーの指摘）
- Admin への通知の送り先（`[通知]` は CloudWatch Logs とジョブの結果だけ）: 028 で確かめる
- 公開の JSON の反映は最大1秒ほど遅れる（上）: 027 の画面で気にするなら考える

