# word-flashcard が作ったもの（アカウントに1つ、または使い回せるもの）を参照する
data "aws_caller_identity" "current" {}

data "aws_route53_zone" "main" {
  name = var.zone_name
}

data "aws_acm_certificate" "wildcard" {
  provider    = aws.us_east_1
  domain      = "*.${var.zone_name}"
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}
