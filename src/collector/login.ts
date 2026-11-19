// L2 のログイン（Node から直接。docs/architecture.md「雀魂の WebGL 版の通信」のログインの流れ）
import { randomUUID } from 'node:crypto';
import type { Conn } from './connection.ts';
import { defaultSleep, type Sleep } from './pacer.ts';
import type { ClientVersion } from './static.ts';

/** 運営アカウントの認証情報（Yostar の Token と ID）。値はログに出さない */
export interface Credentials {
  /** `oauth2Auth` の `type`（Yostar は 21） */
  type: number;
  /** Yostar の `UserInfo.Token` */
  code: string;
  /** Yostar の `UserInfo.ID` */
  uid: string;
}

/** requestConnection → heartbeat → oauth2Auth → oauth2Check → oauth2Login。失敗は MajsoulError */
export async function login(conn: Conn, cred: Credentials, version: ClientVersion, sleep: Sleep = defaultSleep): Promise<void> {
  await conn.call('Route.requestConnection', { type: 1, route_id: 'jp-1', timestamp: Math.floor(Date.now() / 1000), platform: 'Web' });
  // ゲームと同じく、最初に heartbeat を数回送ってから認証する
  await conn.call('Route.heartbeat', { delay: 5000, no_operation_counter: 0, platform: 11, network_quality: 5000 });
  for (let i = 0; i < 3; i++) {
    await sleep(600);
    await conn.call('Route.heartbeat', { delay: 0, no_operation_counter: 0, platform: 11, network_quality: 0 });
  }
  conn.startHeartbeat();

  const auth = await conn.call('Lobby.oauth2Auth', {
    type: cred.type, code: cred.code, uid: cred.uid, client_version_string: version.clientVersionString,
  });
  const accessToken: string = auth.access_token;
  await conn.call('Lobby.oauth2Check', { type: cred.type, access_token: accessToken });
  await conn.call('Lobby.oauth2Login', {
    type: cred.type,
    access_token: accessToken,
    reconnect: false,
    device: {
      platform: 'pc', hardware: 'unknown', os: 'windows', os_version: 'Unknown OS Unknown OS Version',
      is_browser: true, sale_platform: 'web', screen_type: 1,
    },
    random_key: randomUUID(),
    client_version: { resource: version.resource, package: version.package },
    currency_platforms: [1, 3, 5, 9, 12],
    client_version_string: version.clientVersionString,
    tag: 'jp',
  });
}
