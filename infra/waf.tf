# CloudFront の定額プランでは Web ACL の関連付けが必須（プランに含まれるので追加費用なし）。
# 定額プランのディストリビューションの Web ACL は共有できないので、word-flashcard とは別に作る
resource "aws_wafv2_web_acl" "site" {
  provider = aws.us_east_1
  name     = local.name
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  visibility_config {
    cloudwatch_metrics_enabled = false
    metric_name                = local.name
    sampled_requests_enabled   = false
  }
}
