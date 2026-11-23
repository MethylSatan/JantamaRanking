// Cognito の pre sign-up トリガー。Discord からの初回のログインで、許可した Discord の ID だけ利用者を作らせる。
// 許可の一覧は SSM の StringList（カンマ区切り。値は手で入れる。docs/deploy.md）。Discord の規約に沿い、
// 許可していない人のデータは残さない（ログにも ID を書かない）。
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export const handler = async (event) => {
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') {
    throw new Error('この方法では登録できません');
  }
  // 連携の利用者名は「<IdP の名前>_<IdP の sub>」の形
  const match = /^Discord_(\d+)$/i.exec(event.userName ?? '');
  if (!match) {
    throw new Error('このアカウントは許可されていません');
  }
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: process.env.ALLOWED_IDS_PARAMETER }));
  const allowed = (Parameter?.Value ?? '').split(',').map((s) => s.trim());
  if (!allowed.includes(match[1])) {
    console.log('rejected');
    throw new Error('このアカウントは許可されていません');
  }
  console.log('allowed');
  return event;
};
