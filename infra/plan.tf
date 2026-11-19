# CloudFront の定額プラン（Free）。月 $0 で超過料金なし。
# Route 53 のゾーンは word-flashcard のプランに入っているので、ここには含めない
resource "aws_pricingplanmanager_subscription" "site" {
  plan_family = "CloudFront"
  plan_tier   = "FREE"

  resource_arns = [
    aws_cloudfront_distribution.site.arn,
    aws_wafv2_web_acl.site.arn,
  ]
}
