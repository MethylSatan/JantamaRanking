terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # 状態用バケットは word-flashcard と共有（docs/deploy.md）
  backend "s3" {
    bucket       = "methylsatan-tfstate"
    key          = "jantama-ranking/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "ap-northeast-1"

  default_tags {
    tags = { Project = "jantama-ranking" }
  }
}

# CloudFront 用の ACM 証明書と WAF（scope=CLOUDFRONT）は us-east-1 にある
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = { Project = "jantama-ranking" }
  }
}
