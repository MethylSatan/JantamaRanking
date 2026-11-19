# 運営の認証。運営1人を手で登録し、自己登録は無効にする（docs/decisions.md 2026-11-19 タスク 008）
resource "aws_cognito_user_pool" "main" {
  name           = local.name
  user_pool_tier = "LITE"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

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

  deletion_protection = "ACTIVE"
}

# 画面（ブラウザ）から使うので、クライアントシークレットは持たない
resource "aws_cognito_user_pool_client" "web" {
  name            = "web"
  user_pool_id    = aws_cognito_user_pool.main.id
  generate_secret = false

  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
}
