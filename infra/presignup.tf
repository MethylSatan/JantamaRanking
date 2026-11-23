# Cognito の pre sign-up トリガー（lambda/presignup/index.mjs）。許可していない Discord の ID では利用者を作らない。
# コードが小さく、変更も少ないので、API の Lambda と違って Terraform が載せる（GitHub Actions のデプロイの対象外）
locals {
  allowed_ids_parameter = "/${local.name}/allowed-discord-ids"
}

data "archive_file" "presignup" {
  type        = "zip"
  source_file = "${path.module}/lambda/presignup/index.mjs"
  output_path = "${path.module}/.terraform/presignup.zip"
}

resource "aws_iam_role" "presignup" {
  name               = "${local.name}-presignup"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_cloudwatch_log_group" "presignup" {
  name              = "/aws/lambda/${local.name}-presignup"
  retention_in_days = 30
}

data "aws_iam_policy_document" "presignup" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.presignup.arn}:*"]
  }

  # 許可の一覧。値は手で入れる（Terraform に書かない）
  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:ap-northeast-1:${data.aws_caller_identity.current.account_id}:parameter${local.allowed_ids_parameter}"]
  }
}

resource "aws_iam_role_policy" "presignup" {
  name   = "presignup"
  role   = aws_iam_role.presignup.id
  policy = data.aws_iam_policy_document.presignup.json
}

resource "aws_lambda_function" "presignup" {
  function_name = "${local.name}-presignup"
  role          = aws_iam_role.presignup.arn
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 128
  timeout       = 5

  filename         = data.archive_file.presignup.output_path
  source_code_hash = data.archive_file.presignup.output_base64sha256

  environment {
    variables = {
      ALLOWED_IDS_PARAMETER = local.allowed_ids_parameter
    }
  }

  depends_on = [aws_cloudwatch_log_group.presignup]
}

resource "aws_lambda_permission" "presignup" {
  statement_id  = "AllowCognito"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.presignup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
