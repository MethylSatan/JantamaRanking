// Web サービスの API（Lambda Function URL）の入口。CloudFront の /api/* から呼ばれる。
// いまは疎通確認だけ。取り込みなどの処理はタスク 013 で足す。

/** Function URL のイベントのうち、使う部分だけ（ペイロード形式 2.0） */
export interface FunctionUrlEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const json = (statusCode: number, value: unknown): FunctionUrlResult => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(value),
});

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const method = event.requestContext.http.method;
  if (event.rawPath === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    return json(200, { ok: true });
  }
  return json(404, { error: 'not found' });
}
