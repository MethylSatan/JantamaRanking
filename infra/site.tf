# 画面（SPA）とランキングの JSON を置くバケット。CloudFront の OAC 経由でだけ読める
resource "aws_s3_bucket" "site" {
  bucket = "${local.name}-site-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.name}-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# 定額の無料プランでは、独自のキャッシュポリシー・配信元向けポリシー・レスポンスヘッダーポリシーは使えない。
# AWS 管理のポリシーだけを使う
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Host 以外のヘッダー・クエリ・Cookie を配信元に渡す（Host は Function URL のものにする必要がある）
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# 検索エンジンに載せない。ヘッダーのポリシーは使えないので CloudFront Functions で付ける。
# 定額プランのディストリビューションの関数は共有できないので、word-flashcard とは別に作る
resource "aws_cloudfront_function" "noindex" {
  name    = "${local.name}-noindex"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var response = event.response;
      response.headers['x-robots-tag'] = { value: 'noindex, nofollow, noarchive' };
      return response;
    }
  EOT
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  default_root_object = "index.html"
  aliases             = [local.fqdn]
  price_class         = "PriceClass_All"
  web_acl_id          = aws_wafv2_web_acl.site.arn

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    # function_url は https://<id>.lambda-url.<region>.on.aws/ の形
    domain_name              = split("/", aws_lambda_function_url.api.function_url)[2]
    origin_id                = "api"
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.noindex.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.noindex.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = data.aws_acm_certificate.wildcard.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "site_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ALIAS レコードへのクエリは無料で、定額プランの利用枠にも数えられない
resource "aws_route53_record" "app" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.fqdn
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
