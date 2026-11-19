# 配信とデプロイ

URL: `https://jantama-ranking.methylsatan.com`（名前の経緯は `docs/decisions.md` 2026-11-20 タスク 010）

## 構成
```
GitHub (master へ push)
  └ GitHub Actions: test → typecheck → API をバンドル → 画面を S3 へ sync → Lambda のコードを更新 → CloudFront を無効化
        └ OIDC で IAM ロール jantama-ranking-deploy を引き受ける（長期キーなし）

ブラウザ → jantama-ranking.methylsatan.com（Route 53 の ALIAS）
         → CloudFront（WAF、*.methylsatan.com の証明書、定額の無料プラン）
             ├ /*     → S3 jantama-ranking-site-<account>（画面。ランキングの JSON は rankings/ の下）
             └ /api/* → Lambda Function URL（IAM 認証。CloudFront の OAC が署名）→ Lambda jantama-ranking-api
Lambda → S3 jantama-ranking-data-<account>（牌譜の json、雀魂のバージョンと定義）
       → DynamoDB jantama-ranking
       → SSM Parameter Store /jantama-ranking/*（認証情報・定義の鍵。値は手で入れる）
EventBridge Scheduler jantama-ranking-daily → Lambda（1日1回。タスク 013 までは DISABLED）
Cognito ユーザープール jantama-ranking（運営1人。自己登録なし。Lite プラン。Discord ログインはタスク 020 で足す）
```
- コードは `infra/`（Terraform）。状態は S3 の `methylsatan-tfstate`（word-flashcard と共有。キーは `jantama-ranking/terraform.tfstate`）
- リージョンは `ap-northeast-1`。WAF だけ CloudFront の都合で `us-east-1`
- word-flashcard のものを `data` で参照する（作らない）: Route 53 のゾーン `methylsatan.com`、us-east-1 の証明書 `*.methylsatan.com`、GitHub の OIDC プロバイダー
- Lambda は `nodejs24.x`（arm64）。`src/api/handler.ts` を esbuild で1ファイル（`dist/api/index.mjs`）にまとめる。Node 26 のランタイムは 2026-11 時点でプレビューなので使わない
- Lambda のコードは GitHub Actions が更新する。Terraform は最初に仮のコード（503 を返す）で作るだけで、以降のコードの変更は無視する（`lifecycle.ignore_changes`）

## 検索避け
- `web/public/index.html` の `robots` メタ、`web/public/robots.txt`（全拒否）、CloudFront Functions（`jantama-ranking-noindex`）が画面にも API にも付ける応答ヘッダー `X-Robots-Tag: noindex, nofollow, noarchive`
- 証明書はワイルドカード（word-flashcard のもの）なので、CT ログにサブドメイン名は載らない

## API と OAC（タスク 013 で気をつけること）
- Function URL は IAM 認証で、CloudFront の OAC（配信元の種類 `lambda`）だけが署名して呼べる。直接の要求は 403
- CloudFront から呼ぶには、Lambda に `lambda:InvokeFunctionUrl` と `lambda:InvokeFunction`（`invoked_via_function_url = true`）の両方の許可が要る（`infra/api.tf`）
- **OAC は署名のとき `Authorization` ヘッダーを上書きする。** Cognito の JWT は別の名前のヘッダーで送る
- **POST・PUT では、ブラウザが本文の SHA-256（16進）を `x-amz-content-sha256` ヘッダーに付けて送る。** 付けないと署名が合わず失敗する
- `/api/*` のキャッシュは `Managed-CachingDisabled`。配信元へは `Managed-AllViewerExceptHostHeader` で、Host 以外のヘッダー・クエリ・Cookie を渡す
- Lambda はパスを `/api/...` のまま受け取る（`rawPath`）

## 費用（東京、2026-11-20 に AWS の Price List API と料金ページで確認）
| もの | 単価 | 見込み |
|---|---|---|
| CloudFront・WAF | 定額の無料プラン（超過料金なし。利用枠は月100万リクエスト・100GB） | $0 |
| Route 53 のゾーン | word-flashcard のプランに含まれる。ALIAS へのクエリは無料 | $0 |
| Lambda（arm64） | 要求 $0.20/100万、計算 $0.0000133/GB秒 | 1日1回60秒・512MB でも月約900GB秒で約 $0.01（無料枠を使わない場合） |
| DynamoDB（オンデマンド） | 書き込み $0.715/100万、読み込み $0.1425/100万。保存は25GBまで無料 | 1円未満 |
| DynamoDB の PITR | $0.228/GB月（テーブルの大きさに比例。復元できる期間を短くしても変わらない） | 数 MB なら $0.001 未満 |
| S3（2バケット、バージョニング） | $0.025/GB月 | 牌譜は年500局で約1MB。1円未満 |
| CloudWatch Logs（Lambda のログ。30日で削除） | 取り込み $0.76/GB | 1円未満 |
| EventBridge Scheduler | 月1,400万回まで無料 | $0 |
| Cognito（Lite） | 運営・主催者の数人。Discord からの OIDC 連携は月50 MAU まで無料、超えると $0.015/MAU（2026-11-20、タスク 014 で料金ページの要約を確認） | 無料枠の範囲 |
| SSM Parameter Store（標準） | 無料 | $0 |

合計の見込みは月数円以内。定価で見積もっても1円台〜数円で、Lambda・CloudWatch Logs などの恒常の無料枠に収まれば $0。

### 定額の無料プランの条件（word-flashcard の `docs/deploy.md` と同じ。違うところだけ）
- **Lambda Function URL を配信元にしても、Free プランに加入できた**（2026-11-20、`status = ACTIVE`、`plan_tier = FREE`）
- AWS 管理の配信元向けポリシー（`Managed-AllViewerExceptHostHeader`）は Free でも使える。独自のキャッシュポリシー・配信元向けポリシー・レスポンスヘッダーポリシーは使えない
- 定額プランのディストリビューションに付けた Web ACL と CloudFront Functions は、ほかのディストリビューションと共有できない。word-flashcard とは別に作っている
- Free プランは1アカウントで3つまで。word-flashcard とこのサービスで2つ使っている
- キャッシュの振り分けルール（cache behavior）は5つまで（いま2つ）

## 初回の構築手順
前提: `terraform`（1.10 以上）と `aws` CLI v2 を入れ、`aws login` でログインしておく。AWS 側は管理者相当の権限が要る。状態用バケット・Route 53 のゾーン・証明書・OIDC プロバイダーは、word-flashcard の手順で作り済みであること。
1. `cd infra && terraform init && terraform apply`。定額プランへの加入も含まれる（`plan.tf`）。`terraform state show aws_pricingplanmanager_subscription.site` で `status = ACTIVE`、`plan_tier = FREE` を確認する
2. GitHub のシークレットを設定する。値は秘密情報ではないが、公開リポジトリでは Actions のログを誰でも見られるので、アカウント ID がログに出ないようシークレットにする（word-flashcard は非公開なので変数）
   ```
   gh secret set AWS_DEPLOY_ROLE_ARN --body "$(terraform -chdir=infra output -raw deploy_role_arn)"
   gh secret set SITE_BUCKET --body "$(terraform -chdir=infra output -raw bucket)"
   gh secret set CLOUDFRONT_DISTRIBUTION_ID --body "$(terraform -chdir=infra output -raw distribution_id)"
   gh secret set API_FUNCTION_NAME --body "$(terraform -chdir=infra output -raw function_name)"
   ```
3. master に push する（または Actions の `deploy` を手動実行）
4. 運営のユーザーと SSM の値を手で入れる（タスク 013 で手順を足す）

## 普段のデプロイ
master に push するだけ（`.github/workflows/deploy.yml`）。手で出すときは、リポジトリ直下で:
```
npm run build:api
python3 -I -c "import zipfile;z=zipfile.ZipFile('dist/api.zip','w',zipfile.ZIP_DEFLATED);z.write('dist/api/index.mjs','index.mjs');z.close()"
aws s3 sync web/public s3://$(terraform -chdir=infra output -raw bucket) --delete --cache-control "no-cache" --exclude "rankings/*"
aws lambda update-function-code --function-name $(terraform -chdir=infra output -raw function_name) --zip-file fileb://dist/api.zip
aws cloudfront create-invalidation --distribution-id $(terraform -chdir=infra output -raw distribution_id) --paths "/*"
```
- sync は `rankings/*` を除外する（Lambda が書くランキングの JSON を消さない）

## 確認
- `curl -sI https://jantama-ranking.methylsatan.com/`（200、`x-robots-tag: noindex, nofollow, noarchive`）
- `curl -s https://jantama-ranking.methylsatan.com/api/health`（`{"ok":true}`）
- Function URL に直接要求すると 403（`aws lambda get-function-url-config --function-name jantama-ranking-api` で URL を出す）

## 注意・メモ
- **OIDC の `sub` は名前だけの形式**（`repo:MethylSatan/JantamaRanking:ref:refs/heads/master`）。word-flashcard（新しいリポジトリ）は不変 ID 付きの形式で、リポジトリごとに違う。ID 付きで書いたら「Not authorized to perform sts:AssumeRoleWithWebIdentity」になった（2026-11-20）。形式は `gh api repos/MethylSatan/JantamaRanking/actions/oidc/customization/sub` の `sub_claim_prefix` で確かめる。`infra/variables.tf` の `github_repo_sub`
- デプロイを許すのは `master` ブランチだけ（`infra/variables.tf` の `deploy_branch`）
- DynamoDB のテーブルと Cognito のユーザープールは削除保護を有効にしている。消すときは先に外す
- 画面用のバケットもバージョニングを有効にしている（ランキングの JSON の過去の版を残すため）。sync のたびに古い版が残るが、量は小さい
- Lambda の環境変数: `DATA_BUCKET`、`TABLE_NAME`、`SSM_PREFIX`（`/jantama-ranking/`）
