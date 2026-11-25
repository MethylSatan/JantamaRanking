import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { errorMessage, requestHeaders, sha256Hex, type Job, type Me } from './api.ts';
import { b64url, codeChallenge, expiresAt, needsRefresh } from './auth.ts';
import { formatDateTime, jobSummary, lengthLabel, logSummary, publicUrl } from './format.ts';
import { waitJob } from './job.ts';
import { canGlobal, canOnRanking } from './permissions.ts';
import { PERMISSIONS } from '../../../src/api/authorize.ts';

test('codeChallenge は verifier の SHA-256 の base64url', async () => {
  const verifier = 'abc-DEF_123.~xyz';
  assert.equal(await codeChallenge(verifier), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(b64url(new Uint8Array([251, 255])), '-_8');
});

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('アクセストークンの期限と取り直しの判断', () => {
  const tokens = { access_token: jwt({ exp: 2000 }), id_token: '' };
  assert.equal(expiresAt(tokens), 2_000_000);
  assert.equal(needsRefresh(tokens, 1_000_000), false);
  assert.equal(needsRefresh(tokens, 1_950_000), true);
  assert.equal(expiresAt({ access_token: 'broken', id_token: '' }), 0);
});

test('GET 以外は本文の SHA-256 を付ける', async () => {
  const body = '{"name":"テスト"}';
  assert.equal(await sha256Hex(body), createHash('sha256').update(body).digest('hex'));
  assert.deepEqual(await requestHeaders('t', 'GET', ''), { 'x-auth-token': 't' });
  const post = await requestHeaders('t', 'POST', '');
  assert.equal(post['x-amz-content-sha256'], createHash('sha256').update('').digest('hex'));
  const put = await requestHeaders('t', 'PATCH', body);
  assert.equal(put['content-type'], 'application/json');
});

test('誤りの文', () => {
  assert.match(errorMessage(429, 'refreshed too recently'), /時間をおいて/);
  assert.match(errorMessage(400, 'no accounts'), /雀魂アカウント/);
  assert.match(errorMessage(500, 'internal error'), /500/);
});

const me = (admin: boolean): Me => ({ sub: 's', admin, permissions: PERMISSIONS as unknown as Me['permissions'] });

test('ボタンの出し分けは API の表に従う', () => {
  assert.equal(canGlobal(me(true), 'createRanking'), true);
  assert.equal(canGlobal(me(false), 'createRanking'), false);
  assert.equal(canOnRanking(me(true), 'admin', 'deleteRanking'), true);
  assert.equal(canOnRanking(me(false), 'host', 'deleteRanking'), false);
  assert.equal(canOnRanking(me(false), 'host', 'import'), true);
  assert.equal(canOnRanking(me(true), 'admin', 'createRanking'), false);
});

test('表示の整形', () => {
  assert.equal(formatDateTime(Date.UTC(2026, 10, 24, 15, 5)), '2026/11/25 00:05');
  assert.equal(lengthLabel(1), '東風');
  assert.equal(lengthLabel(12), '半荘');
  assert.equal(publicUrl('https://x', 'a b'), 'https://x/ranking.html?id=a%20b');
});

test('処理の結果の要約', () => {
  const refresh = jobSummary({
    kind: 'refresh',
    status: 'done',
    result: {
      accounts: [
        { displayId: '1', internalId: '9', returned: { '4p': 42, '3p': 0 }, newCandidates: 3, warnings: ['四麻: 一覧が42件'] },
        { displayId: '2', error: 'not found' },
      ],
      notices: ['定義が変わった'],
    },
  });
  assert.deepEqual(refresh.lines, ['ID 1: 四麻42件・三麻0件、新しい候補3件']);
  assert.equal(refresh.warnings.length, 3);
  const imp = jobSummary({ kind: 'import', status: 'done', result: { imported: ['a', 'b'], skipped: [], missing: ['c'], failed: [] } });
  assert.deepEqual(imp.lines, ['2件を取り込みました', '1件は雀魂から牌譜を取れませんでした']);
  assert.deepEqual(jobSummary({ kind: 'rebuild', status: 'failed', error: 'lock' }).lines, ['失敗しました: lock']);
  assert.equal(
    logSummary({ at: '', sub: 's', via: 'admin', op: 'import', target: 'j', detail: { imported: ['a'], skipped: [], missing: [], failed: [] } }),
    '1件を取り込みました',
  );
  assert.equal(logSummary({ at: '', sub: 's', via: 'admin', op: 'refresh', detail: { error: 'x' } }), '失敗: x');
});

test('処理が終わるまで見る', async () => {
  const base = { id: 'j', kind: 'refresh', createdBy: 's', via: 'admin', createdAt: '', updatedAt: '' } as const;
  const states: Job[] = [
    { ...base, status: 'running', progress: 'a' },
    { ...base, status: 'done', result: {} },
  ];
  const seen: string[] = [];
  const final = await waitJob({ ...base, status: 'queued' }, async () => states.shift()!, (j) => seen.push(j.status), {
    sleep: async () => {},
  });
  assert.equal(final.status, 'done');
  assert.deepEqual(seen, ['queued', 'running', 'done']);
});
