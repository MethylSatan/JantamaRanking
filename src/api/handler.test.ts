import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './handler.ts';

const event = (method: string, rawPath: string) => ({ rawPath, requestContext: { http: { method } } });

test('/api/health に GET で応える', async () => {
  const res = await handler(event('GET', '/api/health'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('ほかのパスやメソッドは 404', async () => {
  assert.equal((await handler(event('GET', '/api/unknown'))).statusCode, 404);
  assert.equal((await handler(event('POST', '/api/health'))).statusCode, 404);
});
