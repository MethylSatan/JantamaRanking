# 牌譜の json、雀魂のバージョンと定義を置くバケット。非公開。
# 古い版を残し、誤って上書き・削除しても戻せるようにする（docs/architecture.md「作り直し・取り消し・履歴」）
resource "aws_s3_bucket" "data" {
  bucket = "${local.name}-data-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ランキングの JSON の過去の版も残す（画面のファイルは毎回 sync で置き換わるが、量は小さい）
resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

# 対局・ランキング（企画）・主催者・操作ログ・ロック。項目の形はタスク 013 で決める
resource "aws_dynamodb_table" "main" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}
