# 010 AWS 基盤（Terraform とデプロイ）

状態: done / 依存: 008、011

## 目的
Web サービスの配信と API の基盤を、Terraform で作る。word-flashcard の基盤に合わせる（`docs/decisions.md` 2026-11-19）。

## 読むべき資料
- `docs/architecture.md`（Web サービスの構成）
- `../word-flashcard/docs/deploy.md` と `../word-flashcard/infra/`（手本。隣のリポジトリ）

## 作業範囲
- `infra/` に Terraform を置く。状態は `methylsatan-tfstate` の `jantama-ranking/terraform.tfstate`
- word-flashcard のリソースは `data` で参照する: Route 53 のゾーン、us-east-1 の `*.methylsatan.com` の証明書、GitHub の OIDC プロバイダー
- 作るもの: S3（画面・ランキングの JSON・牌譜の json）、CloudFront（WAF、定額の無料プラン）、Lambda と Function URL、DynamoDB、SSM Parameter Store（認証情報の置き場。値は Terraform に書かず、手で入れる）、Cognito のユーザープール（運営1人、自己登録なし）、EventBridge Scheduler、デプロイ用の IAM ロール
- **最初に確かめる**: Lambda Function URL を定額プランのディストリビューションの配信元にできるか（OAC、AWS 管理のポリシーだけで足りるか）。だめなら API Gateway の HTTP API にし、決定ログに書く
- Free プランは1アカウントで3つまで。word-flashcard で1つ使っている
- 牌譜の S3 はバージョニングを有効にし、DynamoDB はポイントインタイムリカバリを有効にする（`docs/architecture.md`「作り直し・取り消し・履歴」）。料金を確かめる
- GitHub Actions で main への push でデプロイする
- 手順を `docs/deploy.md` に書く（word-flashcard の形式に合わせる）

## 完了条件
- `https://jantama-ranking.methylsatan.com`（当初は `jantama.methylsatan.com`。`docs/decisions.md` 2026-11-20 タスク 010）で空の画面が出て、`/api` の疎通用の要求に Lambda が応える
- 費用が無料枠に収まる設定であることを確かめ、`docs/deploy.md` に書いている

## メモ
- 2026-11-20: `terraform apply` で32件を作成。定額の無料プランは `ACTIVE` / `FREE` で、Lambda Function URL を配信元にしても加入できた。API Gateway は使わない
- 確認: 画面 200（`x-robots-tag` 付き）、`/api/health` → `{"ok":true}`、知らないパスは 404、Function URL への直接の要求は 403
- ブランチはタスクに書いた「main」ではなく、このリポジトリの既定の `master`
- Lambda は `nodejs24.x`（arm64）。Node 26 のランタイムはプレビューなので使わない。esbuild で1ファイルにまとめる
- ランキングの JSON は画面用バケットの `rankings/` の下。デプロイの sync はここを除外する
- SSM のパラメータは Terraform で作らない（値を tfstate に入れない）。Scheduler は DISABLED で作った（処理はタスク 013）
- 費用は `docs/deploy.md`。Price List API で東京の単価を確認し、定価でも月数円以内
- OAC の注意（`Authorization` の上書き、POST の `x-amz-content-sha256`）はタスク 013 のメモに申し送った
