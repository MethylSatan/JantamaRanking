# 配信とデプロイ

URL: `https://jantama-ranking.methylsatan.com`（名前の経緯は `docs/decisions.md` 2026-11-20 タスク 010）

## 構成
```
GitHub (master へ push)
  └ GitHub Actions: test → typecheck → API をバンドル → 画面をビルド（Vite。`dist/web`）→ S3 へ sync → Lambda のコードを更新 → CloudFront を無効化
        └ OIDC で IAM ロール jantama-ranking-deploy を引き受ける（長期キーなし）

ブラウザ → jantama-ranking.methylsatan.com（Route 53 の ALIAS）
         → CloudFront（WAF、*.methylsatan.com の証明書、定額の無料プラン）
             ├ /*     → S3 jantama-ranking-site-<account>（画面。ランキングの JSON は rankings/ の下）
             └ /api/* → Lambda Function URL（IAM 認証。CloudFront の OAC が署名）→ Lambda jantama-ranking-api
Lambda → S3 jantama-ranking-data-<account>（牌譜の json、雀魂のバージョンと定義）
       → DynamoDB jantama-ranking
       → SSM Parameter Store /jantama-ranking/*（認証情報・定義の鍵。値は手で入れる）
EventBridge Scheduler jantama-ranking-daily → Lambda（1日1回。有効にしないと決めた（タスク 028）。DISABLED）
Cognito ユーザープール jantama-ranking（Lite プラン。ログインは Discord だけ。自己登録なし）
  ├ ログイン画面（Hosted UI）: jantama-ranking-auth.methylsatan.com（Cognito が立てる CloudFront。Route 53 の ALIAS）
  ├ IdP: Discord（OIDC）
  └ pre sign-up: Lambda jantama-ranking-presignup（許可した Discord の ID だけ利用者を作る。一覧は SSM /jantama-ranking/allowed-discord-ids）
```
- コードは `infra/`（Terraform）。状態は S3 の `methylsatan-tfstate`（word-flashcard と共有。キーは `jantama-ranking/terraform.tfstate`）
- リージョンは `ap-northeast-1`。WAF だけ CloudFront の都合で `us-east-1`
- word-flashcard のものを `data` で参照する（作らない）: Route 53 のゾーン `methylsatan.com`、us-east-1 の証明書 `*.methylsatan.com`、GitHub の OIDC プロバイダー
- Lambda は `nodejs24.x`（arm64）。`src/api/handler.ts` を esbuild で1ファイル（`dist/api/index.mjs`）にまとめる。Node 26 のランタイムは 2026-11 時点でプレビューなので使わない
- Lambda のコードは GitHub Actions が更新する。Terraform は最初に仮のコード（503 を返す）で作るだけで、以降のコードの変更は無視する（`lifecycle.ignore_changes`）

## 検索避け
- 画面の各ページ（`web/public/index.html`・`web/admin.html` など）の `robots` メタ、`web/public/robots.txt`（全拒否）、CloudFront Functions（`jantama-ranking-noindex`）が画面にも API にも付ける応答ヘッダー `X-Robots-Tag: noindex, nofollow, noarchive`
- 証明書はワイルドカード（word-flashcard のもの）なので、CT ログにサブドメイン名は載らない

## API と OAC（タスク 024〜027 で気をつけること）
- Function URL は IAM 認証で、CloudFront の OAC（配信元の種類 `lambda`）だけが署名して呼べる。直接の要求は 403
- CloudFront から呼ぶには、Lambda に `lambda:InvokeFunctionUrl` と `lambda:InvokeFunction`（`invoked_via_function_url = true`）の両方の許可が要る（`infra/api.tf`）
- **OAC は署名のとき `Authorization` ヘッダーを上書きする。** Cognito の JWT は別の名前のヘッダーで送る
- **POST・PUT では、ブラウザが本文の SHA-256（16進）を `x-amz-content-sha256` ヘッダーに付けて送る。** 付けないと署名が合わず失敗する
- `/api/*` のキャッシュは `Managed-CachingDisabled`。配信元へは `Managed-AllViewerExceptHostHeader` で、Host 以外のヘッダー・クエリ・Cookie を渡す
- Lambda はパスを `/api/...` のまま受け取る（`rawPath`）
- `x-auth-token` に入れるのは Cognito の**アクセストークン**（ID トークンではない。`token_use=access` を確かめる）
- AWS SDK はバンドルせず、Lambda のランタイムのものを使う（`build:api` の `--external:@aws-sdk/*`）

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
| Cognito（Lite） | Admin・Host の数人。Discord からの OIDC 連携は月50 MAU まで無料、超えると $0.015/MAU（2026-11-20、タスク 014 で料金ページの要約を確認） | 無料枠の範囲 |
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
1. Discord の開発者ポータル（https://discord.com/developers/applications）で Application を作る。OAuth2 の画面で Client ID を控え（`infra/variables.tf` の既定値にする）、Client Secret を発行して SSM に入れる（下の「Discord の Client Secret」。リポジトリにも `docs/local/` にも書かない）。Public Client はオフのまま。Redirects に `https://jantama-ranking-auth.methylsatan.com/oauth2/idpresponse` を足す。Bot・Installation・OAuth2 URL Generator は使わない
2. 許可の一覧を SSM に作る。最初は誰も入れない値にしておき、弾かれることを確かめてから自分の ID を入れる（下の「ログインの許可」）
   ```
   aws ssm put-parameter --name /jantama-ranking/allowed-discord-ids --type StringList --value none
   ```
3. `cd infra && terraform init && terraform apply`。定額プランへの加入も含まれる（`plan.tf`）。`terraform state show aws_pricingplanmanager_subscription.site` で `status = ACTIVE`、`plan_tier = FREE` を確認する
4. GitHub のシークレットを設定する。値は秘密情報ではないが、公開リポジトリでは Actions のログを誰でも見られるので、アカウント ID がログに出ないようシークレットにする（word-flashcard は非公開なので変数）
   ```
   gh secret set AWS_DEPLOY_ROLE_ARN --body "$(terraform -chdir=infra output -raw deploy_role_arn)"
   gh secret set SITE_BUCKET --body "$(terraform -chdir=infra output -raw bucket)"
   gh secret set CLOUDFRONT_DISTRIBUTION_ID --body "$(terraform -chdir=infra output -raw distribution_id)"
   gh secret set API_FUNCTION_NAME --body "$(terraform -chdir=infra output -raw function_name)"
   ```
5. master に push する（または Actions の `deploy` を手動実行）
6. Discord の開発者ポータルの General Information に、Privacy Policy URL（`https://jantama-ranking.methylsatan.com/privacy.html`）を入れる（Discord の開発者向けの規約で必要）
7. Admin にする人が Discord でログインし、`admins` グループに入れる（下の「ログインの許可」）
8. システム用の雀魂アカウントの認証情報と定義の鍵を SSM に入れる（下の「雀魂の認証情報と定義の鍵」）

### 雀魂の認証情報と定義の鍵
Lambda が雀魂にログインするために使う（`src/api/aws.ts`）。値はリポジトリにも `docs/local/` にも書かない。手元の回収ツールの秘密ファイル（`local/collector/secret.json`・`lua-key.txt`。`docs/collector.md`）から入れる。値が画面やシェルの履歴に出ないよう、権限600の一時ファイルを `file://` で渡して、すぐ消す。
```
umask 077; t=$(mktemp -d)
python3 -c "import json;d=json.load(open('local/collector/secret.json'));print(json.dumps({k:d[k] for k in ('type','code','uid')}))" > $t/cred.json
tr -d '\r\n' < local/collector/lua-key.txt > $t/key.txt
aws ssm put-parameter --name /jantama-ranking/majsoul-credentials --type SecureString --value file://$t/cred.json --overwrite
aws ssm put-parameter --name /jantama-ranking/liqi-lua-key --type SecureString --value file://$t/key.txt --overwrite
rm -rf $t
```
- 認証情報を取り直したら（タスク 009）、上の1つめだけやり直す
- 雀魂のバージョンと定義は、Lambda が data バケットの `state/` に置く。無いとき・`oauth2Auth` が `err=151` のときに静的ファイルから作り直す（入れる必要はない）

### Discord の Client Secret
**tfstate に入れない。** secret が漏れると、アプリの持ち主（Admin）の Discord アカウントのトークンを、`client_credentials` で取られうる（`docs/decisions.md` 2026-11-23 タスク 020）。
- secret は SSM の SecureString `/jantama-ranking/discord-client-secret` に手で入れる。シェルの履歴に残さないよう、`read -s` で入れる
  ```
  read -rs SECRET && aws ssm put-parameter --name /jantama-ranking/discord-client-secret --type SecureString --value "$SECRET" --overwrite; unset SECRET
  ```
- Cognito の IdP「Discord」は、`terraform apply` のときに `infra/scripts/discord-idp.sh` が SSM から secret を読んで作る（あれば更新する）。Terraform のリソースにはしない（`aws_cognito_identity_provider` に tfstate に残らない書き方がないため）。手元に `aws` CLI と `python3` が要る
- secret を変えたら（Discord の「Reset Secret」の後など）、SSM を上書きしてから `terraform -chdir=infra apply -replace=terraform_data.discord_idp`
- Client ID は秘密ではないので、`infra/variables.tf` の既定値に置いている

### ログインの許可
- 自分の Discord の ID は、Discord の設定で開発者モードをオンにし、自分のアイコンの右クリック →「ユーザー ID をコピー」で得る
- 許可の一覧はカンマ区切りで上書きする。一覧が効くのは初回のログイン（Cognito の利用者ができるとき）だけ
  ```
  aws ssm put-parameter --name /jantama-ranking/allowed-discord-ids --type StringList --value <ID>,<ID> --overwrite
  ```
- 初回のログインで利用者ができたら、Admin にする人をグループに入れる。利用者名は `Discord_<Discord の ID>` の形（タスク 020 で確認）
  ```
  aws cognito-idp admin-add-user-to-group --user-pool-id $(terraform -chdir=infra output -raw user_pool_id) --username <利用者名> --group-name admins
  ```
  グループはトークンに入るので、入れた後はログインし直す。連携の利用者は、Cognito が自動で作る `<ユーザープール ID>_Discord` のグループにも入る（Admin の判定には使わない）
- 手元でログインを確かめるときは、`npm run dev`（Vite。5173番）を立て、Windows のブラウザで `http://localhost:5173/admin.html` を開く（VS Code の中のブラウザはアドレスが変わり、`redirect_mismatch` になる）
- 許可を取り消すときは、一覧から外し、`aws cognito-idp admin-delete-user` で利用者を消す（Discord の規約: 不要になったデータは消す）

## 普段のデプロイ
master に push するだけ（`.github/workflows/deploy.yml`）。手で出すときは、リポジトリ直下で:
```
npm run build:api
npm run build:web
python3 -I -c "import zipfile;z=zipfile.ZipFile('dist/api.zip','w',zipfile.ZIP_DEFLATED);z.write('dist/api/index.mjs','index.mjs');z.close()"
aws s3 sync dist/web s3://$(terraform -chdir=infra output -raw bucket) --delete --cache-control "no-cache" --exclude "rankings/*"
aws lambda update-function-code --function-name $(terraform -chdir=infra output -raw function_name) --zip-file fileb://dist/api.zip
aws cloudfront create-invalidation --distribution-id $(terraform -chdir=infra output -raw distribution_id) --paths "/*"
```
- sync は `rankings/*` を除外する（Lambda が書くランキングの JSON を消さない）

## 手元の開発（画面。タスク 026）
- `npm run dev` で Vite を立てる（`http://localhost:5173/admin.html`、閲覧は `http://localhost:5173/ranking.html?id=<公開 ID>`）。`/api` と `/rankings` は Vite の proxy で本番（`jantama-ranking.methylsatan.com`）へ送るので、**手元でも本番の API・DynamoDB・雀魂への接続を使う**。確かめるときはテスト用のランキングを作り、最後に削除（非公開）にする
- Cognito のコールバックに `http://localhost:5173/admin.html` を登録してある（`infra/auth.tf`）。ポートは固定（`strictPort`）
- ビルドは `npm run build:web`（出力は `dist/web/`。`web/public/` の静的ファイルもそのまま入る）
- 2026-11-25（タスク 027）: 起動中にファイルを変えても、画面が古いまま（Vite が変更を拾わない）ことが2回あった。おかしいときは `npm run dev` を起動し直す
- 閲覧の画面は、本番に公開中のランキングが無ければ、Playwright の `page.route` で `/rankings/*.json` を架空の対局（`src/ranking/testdata.ts` の `game`）に差し替えて確かめる

## 確認
- `curl -sI https://jantama-ranking.methylsatan.com/`（200、`x-robots-tag: noindex, nofollow, noarchive`）
- `curl -s https://jantama-ranking.methylsatan.com/api/health`（`{"ok":true}`）
- Function URL に直接要求すると 403（`aws lambda get-function-url-config --function-name jantama-ranking-api` で URL を出す）
- API の中身（Admin のトークンで）: `npm run apicheck -- smoke`。テスト用のランキングを作り、操作して、最後に削除（非公開）にする。任意の要求は `npm run apicheck -- call GET /api/me`
- 候補の更新から取り込みまで（タスク 025）: `npm run apicheck -- flow <表示用ID> [取り込む件数]`。テスト用のランキングに雀魂アカウントを指定し、候補の更新 → 取り込み → 公開の URL のランキングの JSON → 対象外・戻す → 作り直し → 公開 ID の取り直しを確かめ、最後に削除（非公開）にする。**雀魂へのログインが2回起きる**（候補の更新と取り込み）。牌譜は S3 の `records/` に残る
  - トークンは `local/apicheck/tokens.json`（Cognito のリフレッシュトークン。既定で30日）。無い・切れたときは `npm run apicheck -- login`: Playwright がブラウザを開くので、Discord のログインだけ手で行う（入力は自動化しない。Discord の規約と CAPTCHA のため）。ブラウザのプロファイルも `local/apicheck/profile` に残す
  - 管理の画面での同じ流れの確認（タスク 026）は、Playwright で `npm run dev` の画面を開いて行った。`local/apicheck/tokens.json` のリフレッシュトークンを画面の sessionStorage（`tokens`）に入れると、画面がアクセストークンを取り直すので、Discord の入力は要らない
  - Admin でない利用者での確認（403・404）は、Discord のアカウントが1つなので本番ではできない。自動テスト（`src/api/*.test.ts`）で確かめる

## 注意・メモ
- **OIDC の `sub` は名前だけの形式**（`repo:MethylSatan/JantamaRanking:ref:refs/heads/master`）。word-flashcard（新しいリポジトリ）は不変 ID 付きの形式で、リポジトリごとに違う。ID 付きで書いたら「Not authorized to perform sts:AssumeRoleWithWebIdentity」になった（2026-11-20）。形式は `gh api repos/MethylSatan/JantamaRanking/actions/oidc/customization/sub` の `sub_claim_prefix` で確かめる。`infra/variables.tf` の `github_repo_sub`
- デプロイを許すのは `master` ブランチだけ（`infra/variables.tf` の `deploy_branch`）
- DynamoDB のテーブルと Cognito のユーザープールは削除保護を有効にしている。消すときは先に外す
- 画面用のバケットもバージョニングを有効にしている（ランキングの JSON の過去の版を残すため）。sync のたびに古い版が残るが、量は小さい
- Lambda の環境変数: `DATA_BUCKET`、`SITE_BUCKET`（ランキングの JSON の置き場）、`TABLE_NAME`、`SSM_PREFIX`（`/jantama-ranking/`）、`USER_POOL_ID`・`USER_POOL_CLIENT_ID`（アクセストークンの検証）
- Lambda の権限（タスク 025 で追加）: 自分の `lambda:InvokeFunction`（ジョブを非同期で起動する）、site バケットの `rankings/*` の `s3:DeleteObject`（公開 ID の取り直し・削除で古い JSON を消す）
- **`methylsatan.com`（apex）の A レコードはこのリポジトリで作っている**（`infra/shared.tf`。値は到達しない文書用のアドレス `192.0.2.1`）。Cognito の独自ドメインが、親ドメインに A レコードがあることを求めるため。ゾーンは共有のリソースなので、ほかのリポジトリでは apex の A レコードを作らない（2026-11-23、タスク 020）
