# 020 Discord ログインの接続

状態: doing / 依存: 014

## 目的
運営と主催者が Discord でログインできるようにする。Discord を Cognito のユーザープールに OIDC の IdP としてつなぎ、画面から Hosted UI 経由でログインして、Cognito の JWT を受け取れることを確かめる（`docs/decisions.md` 2026-11-20 タスク 014）。

## 読むべき資料
- `docs/decisions.md`（2026-11-20 タスク 014）
- `docs/architecture.md`（Web サービスの構成の「ログイン」）
- `docs/deploy.md`（構成、API と OAC）
- `infra/auth.tf`
- `docs/local/014-login-notes.md`（ローカル限定。Discord の discovery と規約の要点）

## 作業範囲
- 運営が Discord の開発者ポータルで Application を作り、client ID と secret を得る（手順を `docs/deploy.md` に書く）
- Terraform（`infra/auth.tf`）に足す
  - ユーザープールのドメイン（Cognito のプレフィックスのドメインで足りるか、独自ドメインにするか）
  - Discord の IdP（OIDC。issuer `https://discord.com`、スコープ `openid identify`、メールは求めない）と属性の対応
  - アプリクライアントの OAuth の設定（認可コード＋PKCE、コールバック・ログアウトの URL、IdP に Discord）
  - 運営のグループ（`operators`）
  - client secret は Terraform の変数で渡し、コミットしない（tfstate には入る）
- Discord の Application に、Cognito のコールバック（`https://<ユーザープールのドメイン>/oauth2/idpresponse`）を登録する
- 最小のページでログインし、受け取ったトークン（`sub`、グループ、Discord の ID の入り方）を確かめる
- 確かめること
  - `allow_admin_create_user_only = true` のままで、連携の利用者が自動で作られるか
  - `username_attributes = ["email"]` のままで、メールのない連携の利用者を作れるか（変えるとユーザープールの作り直しになる）
  - 許可していない Discord のアカウントで利用者を作らない方法（pre sign-up トリガーで、許可した Discord の ID だけ通す、など）
- 規約で求められるページ: プライバシーポリシー（集めるデータ、使い方、削除の頼み方）と連絡先。画面と開発者ポータルからリンクする
- 運営のメールとパスワードのログイン（SRP）を残すか外すかを決める

## 完了条件
- 運営が Discord でログインし、`operators` グループの入った Cognito の JWT を画面で受け取れる
- 許可していない Discord のアカウントでは、利用者が作られない（か、作られても操作できない）ことを確かめた
- 手順が `docs/deploy.md` に、決定が `docs/decisions.md` にある

## メモ
- 2026-11-23 の作業
  - 構成: ログイン画面は独自ドメイン `jantama-ranking-auth.methylsatan.com`、apex に到達しない A レコード、SRP を外す、許可の一覧は SSM と pre sign-up、Client Secret は SSM（IdP は `infra/scripts/discord-idp.sh` が作る）。理由は `docs/decisions.md` 2026-11-23（タスク 020）
  - apply は1回で通った。独自ドメインの作成に約3分。apex の A レコードは到達しないアドレス（`192.0.2.1`）で足りた
  - IdP を `oidc_issuer` だけで作ると、`describe-identity-provider` に接続先（`token_url`・`jwks_uri` など）は出ないが、discovery から引いて動く
  - 手元（`http://localhost:5173/admin.html`）で確認した
    - 許可していない ID: 「PreSignUp failed with error このアカウントは許可されていません」で戻り、Cognito の利用者は作られない
    - 許可した ID: ログインでき、ID トークンに `sub`、`cognito:username`（`Discord_<Discord のユーザー ID>`）、`identities`（`providerName: Discord`、`userId` に Discord のユーザー ID）が入る
    - `operators` に入れてログインし直すと、`cognito:groups` に `operators` が入る
  - **連携の利用者は、Cognito が自動で作る IdP ごとのグループ（`<ユーザープール ID>_Discord`）にも入る。** 運営かどうかは「グループがあるか」ではなく「`operators` があるか」で決める
  - VS Code の中のブラウザで開くと、ページのアドレスが `localhost` 以外になり、Cognito が `redirect_mismatch` で止まる。Windows のブラウザで `http://localhost:5173/admin.html` を開く
  - 5173 番は word-flashcard の Vite の開発サーバーと重なる。手元の確認では、そちらを止めてから `python3 -I -m http.server 5173 --bind 127.0.0.1 -d web/public`
- タスク 013 の API は、この JWT を `x-auth-token` ヘッダーで受けて検証する（OAC が `Authorization` を上書きするため。`docs/deploy.md`）
- Cognito の Lite プランでは、ログイン画面は旧来の Hosted UI。OIDC 連携は月50 MAU まで無料
