// Cognito の pre sign-up トリガー。Discord からの初回のログインで利用者を作らせる。
// 誰でもログインでき、本人が画面で申請し、管理人が承認する（承認と Host の付け外しは API）。
// 利用者の数は Cognito の無料の範囲（MAX_USERS。Discord 連携は月50人まで無料）に抑え、超えたら断る。
// 断った人のデータは残さない（ログにも ID を書かない）。
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});
const MAX_USERS = Number(process.env.MAX_USERS);

/** 利用者の数（limit に届いたらそこで止める） */
async function countUsers(userPoolId, limit) {
  let count = 0;
  let token;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, AttributesToGet: [], PaginationToken: token }));
    count += res.Users?.length ?? 0;
    token = res.PaginationToken;
  } while (token && count < limit);
  return count;
}

export const handler = async (event) => {
  if (event.triggerSource !== 'PreSignUp_ExternalProvider') {
    throw new Error('この方法では登録できません');
  }
  // 連携の利用者名は「<IdP の名前>_<IdP の sub>」の形
  if (!/^Discord_\d+$/i.test(event.userName ?? '')) {
    throw new Error('このアカウントは使えません');
  }
  if (!(MAX_USERS > 0)) throw new Error('MAX_USERS がない');
  if ((await countUsers(event.userPoolId, MAX_USERS)) >= MAX_USERS) {
    console.log('rejected: full');
    throw new Error('いまは新しい登録を受け付けていません');
  }
  console.log('allowed');
  return event;
};
