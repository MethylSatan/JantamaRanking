# 010 AWS 基盤（Terraform とデプロイ）

状態: todo / 依存: 008、011

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
- GitHub Actions で main への push でデプロイする
- 手順を `docs/deploy.md` に書く（word-flashcard の形式に合わせる）

## 完了条件
- `https://jantama.methylsatan.com` で空の画面が出て、`/api` の疎通用の要求に Lambda が応える
- 費用が無料枠に収まる設定であることを確かめ、`docs/deploy.md` に書いている

## メモ
（未着手）
