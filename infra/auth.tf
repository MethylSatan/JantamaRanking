# Admin・Host（主催者）の認証。ログインは Discord だけ（Discord を OIDC の IdP にする。docs/decisions.md 2026-11-20「ログインの方式」、2026-11-23「Discord ログインの接続」）。
# 自己登録は無効。Discord からの初回のログインで利用者が作られるが、許可していない Discord の ID は pre sign-up で拒む（presignup.tf）
resource "aws_cognito_user_pool" "main" {
  name           = local.name
  user_pool_tier = "LITE"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # 作った当初（メールとパスワード）の設定。変えるとユーザープールの作り直しになるので残す
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = false
    require_uppercase = false
    require_numbers   = false
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  lambda_config {
    pre_sign_up = aws_lambda_function.presignup.arn
  }

  deletion_protection = "ACTIVE"
}

# ログイン画面（旧来の Hosted UI。Lite プランでは managed login は使えない）。
# サービスのドメインの下のパスには置けないので、別のホスト名にする。1階層にしてワイルドカード証明書を使う（CT ログにサービス名を載せない）
resource "aws_cognito_user_pool_domain" "main" {
  domain                = local.auth_fqdn
  user_pool_id          = aws_cognito_user_pool.main.id
  certificate_arn       = data.aws_acm_certificate.wildcard.arn
  managed_login_version = 1

  # 親ドメインに A レコードが要る（shared.tf）
  depends_on = [aws_route53_record.apex]
}

resource "aws_route53_record" "auth" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.auth_fqdn
  type    = "A"

  alias {
    name                   = aws_cognito_user_pool_domain.main.cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.main.cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}

# Discord（OIDC）。discovery は https://discord.com/.well-known/openid-configuration。
# IdP は Terraform のリソースにしない。aws_cognito_identity_provider には tfstate に残らない書き方（write-only）がなく、
# Client Secret が tfstate に入るため。secret は SSM の SecureString に手で入れ、apply のときにスクリプトが読んで IdP を作る・更新する
# （docs/decisions.md 2026-11-23「Discord ログインの接続」）。secret を変えたときは terraform apply -replace=terraform_data.discord_idp
locals {
  discord_secret_parameter = "/${local.name}/discord-client-secret"
  # 取るのは Discord の ID（sub）だけ。メールや名前は求めない（Discord の規約: 必要なデータだけ）
  discord_scopes = "openid identify"
}

resource "terraform_data" "discord_idp" {
  triggers_replace = {
    user_pool_id = aws_cognito_user_pool.main.id
    client_id    = var.discord_client_id
    scopes       = local.discord_scopes
    script       = filesha256("${path.module}/scripts/discord-idp.sh")
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/discord-idp.sh"
    environment = {
      USER_POOL_ID     = aws_cognito_user_pool.main.id
      CLIENT_ID        = var.discord_client_id
      SECRET_PARAMETER = local.discord_secret_parameter
      AUTHORIZE_SCOPES = local.discord_scopes
      OIDC_ISSUER      = "https://discord.com"
      AWS_REGION       = "ap-northeast-1"
    }
  }
}

# 画面（ブラウザ）から使うので、クライアントシークレットは持たない（認可コード＋PKCE）
resource "aws_cognito_user_pool_client" "web" {
  name            = "web"
  user_pool_id    = aws_cognito_user_pool.main.id
  generate_secret = false

  # メールとパスワード（SRP）は使わない。トークンの更新だけ
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  supported_identity_providers         = ["Discord"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid"]
  # 管理の画面。localhost は手元での確認用
  callback_urls = ["https://${local.fqdn}/admin.html", "http://localhost:5173/admin.html"]
  logout_urls   = ["https://${local.fqdn}/", "http://localhost:5173/"]

  prevent_user_existence_errors = "ENABLED"

  # IdP「Discord」はスクリプトで作る（上の terraform_data.discord_idp）
  depends_on = [terraform_data.discord_idp]
}

# Admin（全体の権限）。Discord で一度ログインして利用者ができてから、手で入れる（docs/deploy.md、docs/architecture.md「権限」）
resource "aws_cognito_user_group" "admins" {
  name         = "admins"
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Admin（すべてのランキングと利用者を管理する）"
}
