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

# GitHub の OIDC トークンの sub は、名前に不変の ID が付く形式（owner@ownerID/repo@repoID）。
# ID は gh api repos/MethylSatan/JantamaRanking で確認した
variable "github_repo_sub" {
  description = "デプロイを許可する GitHub リポジトリ（OIDC sub 形式の owner@id/repo@id）"
  type        = string
  default     = "MethylSatan@5436289/JantamaRanking@571210014"
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
