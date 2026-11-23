#!/usr/bin/env bash
# Cognito の IdP「Discord」（OIDC）を作る。すでにあれば更新する。terraform apply から呼ばれる（auth.tf の terraform_data.discord_idp）。
# Client Secret を tfstate に入れないため、IdP は Terraform のリソースにせず、secret は SSM の SecureString から読む
# （docs/decisions.md 2026-11-23 タスク 020）。secret はコマンドの引数に載せず、自分だけが読める一時ファイルで AWS CLI に渡す。
# 環境変数: USER_POOL_ID、CLIENT_ID、SECRET_PARAMETER、AUTHORIZE_SCOPES、OIDC_ISSUER、AWS_REGION
set -euo pipefail

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

DISCORD_CLIENT_SECRET="$(aws ssm get-parameter --name "$SECRET_PARAMETER" --with-decryption --query Parameter.Value --output text)"
export DISCORD_CLIENT_SECRET

if aws cognito-idp describe-identity-provider --user-pool-id "$USER_POOL_ID" --provider-name Discord > /dev/null 2>&1; then
  action=update
else
  action=create
fi

python3 -I - "$tmp" "$action" <<'EOF'
import json, os, sys
path, action = sys.argv[1], sys.argv[2]
body = {
    'UserPoolId': os.environ['USER_POOL_ID'],
    'ProviderName': 'Discord',
    'ProviderDetails': {
        'client_id': os.environ['CLIENT_ID'],
        'client_secret': os.environ['DISCORD_CLIENT_SECRET'],
        'oidc_issuer': os.environ['OIDC_ISSUER'],
        'authorize_scopes': os.environ['AUTHORIZE_SCOPES'],
        'attributes_request_method': 'GET',
    },
    # 取るのは Discord の ID（sub）だけ
    'AttributeMapping': {'username': 'sub'},
}
if action == 'create':
    body['ProviderType'] = 'OIDC'
with open(path, 'w') as f:
    json.dump(body, f)
EOF

aws cognito-idp "${action}-identity-provider" --cli-input-json "file://$tmp" > /dev/null
echo "Discord の IdP を ${action} しました"
