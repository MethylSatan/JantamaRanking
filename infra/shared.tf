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

# 共有ゾーンの apex の A レコード。Cognito の独自ドメイン（auth.tf）は、親ドメインに A レコードがあることを求める。
# apex にサイトはないので、到達しない文書用のアドレス（RFC 5737）を置く。ゾーンは共有のリソースなので、ほかのリポジトリでは作らない
resource "aws_route53_record" "apex" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.zone_name
  type    = "A"
  ttl     = 3600
  records = ["192.0.2.1"]
}
