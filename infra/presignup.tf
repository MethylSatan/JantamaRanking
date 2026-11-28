# Cognito の pre sign-up トリガー（lambda/presignup/index.mjs）。Discord からのログインなら誰でも利用者を作るが、
# 人数が Cognito の無料の範囲（50人）を超えたら断る。承認は画面で管理人が行う。
# コードが小さく、変更も少ないので、API の Lambda と違って Terraform が載せる（GitHub Actions のデプロイの対象外）
locals {
  max_users = 50
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

  # 利用者の数を数える。ユーザープールの ID はイベントで届くので、関数の環境変数には持たない
  # （ここで ARN を参照しても、ユーザープール → 関数 → ロールの依存は循環しない）
  statement {
    actions   = ["cognito-idp:ListUsers"]
    resources = [aws_cognito_user_pool.main.arn]
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
      MAX_USERS = local.max_users
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
