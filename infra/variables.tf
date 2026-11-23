variable "zone_name" {
  description = "Route 53 のドメイン（apex）。ゾーンは word-flashcard が作ったものを参照する"
  type        = string
  default     = "methylsatan.com"
}

variable "subdomain" {
  description = "サービスのサブドメイン"
  type        = string
  default     = "jantama-ranking"
}

# GitHub の OIDC トークンの sub の形式は、リポジトリごとに違う。
# このリポジトリは名前だけの形式（use_immutable_subject=false）。word-flashcard は ID 付き（owner@id/repo@id）。
# 確認: gh api repos/MethylSatan/JantamaRanking/actions/oidc/customization/sub の sub_claim_prefix
variable "github_repo_sub" {
  description = "デプロイを許可する GitHub リポジトリ（OIDC sub の repo: の後ろ。owner/repo）"
  type        = string
  default     = "MethylSatan/JantamaRanking"
}

variable "deploy_branch" {
  description = "デプロイを許可するブランチ"
  type        = string
  default     = "master"
}

locals {
  name = "jantama-ranking"
  fqdn = "${var.subdomain}.${var.zone_name}"
  # Cognito のログイン画面（Hosted UI）のドメイン
  auth_fqdn = "${var.auth_subdomain}.${var.zone_name}"
}

# Discord の開発者ポータルで作った Application の Client ID（秘密ではない。ログインの URL にも出る）。
# Client Secret は Terraform に渡さない（SSM /jantama-ranking/discord-client-secret。auth.tf）
variable "discord_client_id" {
  description = "Discord の Application の Client ID"
  type        = string
  default     = "1574154884524146850"
}

variable "auth_subdomain" {
  description = "Cognito のログイン画面のサブドメイン（ワイルドカード証明書が使えるよう1階層にする）"
  type        = string
  default     = "jantama-ranking-auth"
}
