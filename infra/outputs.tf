output "bucket" {
  value = aws_s3_bucket.site.bucket
}

output "data_bucket" {
  value = aws_s3_bucket.data.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "function_name" {
  value = aws_lambda_function.api.function_name
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "url" {
  value = "https://${local.fqdn}"
}
