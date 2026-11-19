# 定期取得（1日1回、登録した主催者の候補を更新する）。処理はタスク 013 で作るので、それまでは止めておく
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.api.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-api"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "daily" {
  name                         = "${local.name}-daily"
  state                        = "DISABLED"
  schedule_expression          = "cron(0 7 * * ? *)"
  schedule_expression_timezone = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.api.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "scheduler", action = "refresh-candidates" })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
