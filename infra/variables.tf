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
}
