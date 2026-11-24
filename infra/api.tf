# API の Lambda。CloudFront の /api/* から Function URL（OAC で署名）経由で呼ばれる。
# コードは GitHub Actions が更新する（docs/deploy.md）。Terraform は最初の仮のコードで作るだけ
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/.terraform/placeholder.zip"

  source {
    filename = "index.mjs"
    content  = "export const handler = async () => ({ statusCode: 503, body: 'not deployed yet' });\n"
  }
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# ログは30日で消す（CloudWatch Logs の保存料金を増やさない）
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = 30
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name}-api"
  role          = aws_iam_role.api.arn
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 512
  # 雀魂からの取得（要求の間隔2秒、牌譜は最大100件）を1回の実行で終えられる長さ
  timeout = 300

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  environment {
    variables = {
      DATA_BUCKET = aws_s3_bucket.data.bucket
      # ランキングの JSON の置き場（rankings/<公開 ID>.json）
      SITE_BUCKET = aws_s3_bucket.site.bucket
      TABLE_NAME  = aws_dynamodb_table.main.name
      SSM_PREFIX  = "/${local.name}/"
      # x-auth-token の Cognito のアクセストークンを確かめる（発行者と client_id）
      USER_POOL_ID        = aws_cognito_user_pool.main.id
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.web.id
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.api.name
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# 認証は IAM。CloudFront の OAC だけが署名して呼べる（直接の要求は 403）
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${local.name}-api"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Function URL を CloudFront から呼ぶには、InvokeFunctionUrl と InvokeFunction の両方の許可が要る
resource "aws_lambda_permission" "cloudfront_url" {
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
  # Function URL 経由の呼び出しにだけ使える許可にする
  invoked_via_function_url = true
}

data "aws_iam_policy_document" "api" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn, aws_s3_bucket.site.arn]
  }

  # 牌譜・雀魂のバージョン・定義（data）と、ランキングの JSON（site の rankings/ の下。デプロイの sync はここを消さない）
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/*", "${aws_s3_bucket.site.arn}/rankings/*"]
  }

  # 公開 ID を取り直したときと、ランキングを削除（非公開）にしたときに、古い JSON を消す。過去の版はバージョニングで残る
  statement {
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.site.arn}/rankings/*"]
  }

  # 雀魂への要求はジョブにして、自分を非同期（InvocationType: Event）で起動する（docs/architecture.md「非同期の処理」）
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.api.arn]
  }

  statement {
    actions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
      "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
      # TransactWriteItems は中の操作ごとの許可で判断される。条件だけの項目に ConditionCheckItem が要る
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.main.arn, "${aws_dynamodb_table.main.arn}/index/*"]
  }

  # 認証情報と定義の鍵。値は手で入れる（Terraform に書かない）。SecureString の既定の鍵（aws/ssm）で復号できる
  statement {
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:PutParameter"]
    resources = ["arn:aws:ssm:ap-northeast-1:${data.aws_caller_identity.current.account_id}:parameter/${local.name}/*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
