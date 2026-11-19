// 雀魂のゲームサーバーとの WebSocket 接続（liqi の要求・応答）。
// 形式: 送る [2, 番号(u16 LE), Wrapper{name, data}] / 応答 [3, 番号, Wrapper] / 通知 [1, Wrapper]
import protobuf from 'protobufjs';
import WebSocket from 'ws';

export const GATEWAY_URL = 'wss://jpgs.mahjongsoul.com/gateway';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

export type Log = (msg: string) => void;

/** 雀魂が `error.code` を返した */
export class MajsoulError extends Error {
  method: string;
  code: number;
  constructor(method: string, code: number) {
    super(`${method} → err=${code}`);
    this.name = 'MajsoulError';
    this.method = method;
    this.code = code;
  }
}

/** 応答が定義どおりに読めなかった（定義が合わなくなったおそれ） */
export class DecodeError extends Error {
  constructor(method: string, cause: unknown) {
    super(`${method}: 応答をデコードできない（${cause instanceof Error ? cause.message : String(cause)}）`);
    this.name = 'DecodeError';
  }
}

/** 接続。テストでは偽物に差し替える */
export interface Conn {
  /** `Lobby.oauth2Auth` の形で呼ぶ。`error.code` が0以外なら MajsoulError */
  call(method: string, body: Record<string, unknown>): Promise<any>;
  /** 一定間隔で `Route.heartbeat` を送り始める */
  startHeartbeat(): void;
  close(): void;
}

export type Connect = (url: string, root: protobuf.Root, log: Log) => Promise<Conn>;

/**
 * 定義に無い項目番号を探す（下の階層も見る）。見つけたら `型.項目#番号` を返す。
 * 項目が増えただけなら protobuf は読み飛ばせるので、止めずにログに残すために使う
 */
export function unknownFields(type: protobuf.Type, data: Uint8Array, path = type.name, out = new Set<string>(), depth = 0): Set<string> {
  const r = protobuf.Reader.create(data);
  while (r.pos < r.len) {
    const tag = r.uint32();
    const id = tag >>> 3;
    const wire = tag & 7;
    const f = type.fieldsById[id];
    if (!f) {
      out.add(`${path}#${id}`);
      r.skipType(wire);
    } else if (wire === 2 && f.resolvedType instanceof protobuf.Type && depth < 16) {
      unknownFields(f.resolvedType, r.bytes(), `${path}.${f.name}`, out, depth + 1);
    } else {
      r.skipType(wire);
    }
  }
  return out;
}

/** ws で接続する */
export const connect: Connect = (url, root, log) =>
  new Promise((resolve, reject) => {
    const Wrapper = root.lookupType('lq.Wrapper');
    const ws = new WebSocket(url, {
      headers: {
        Origin: 'https://game.mahjongsoul.com',
        'User-Agent': UA,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    let idx = 1;
    let hb: ReturnType<typeof setInterval> | undefined;
    const waiting = new Map<number, (data: Uint8Array) => void>();
    const reportedUnknown = new Set<string>();

    ws.on('message', (data: Buffer) => {
      const b = Buffer.from(data);
      if (b[0] === 1) {
        try { log(`[notify] ${Wrapper.decode(b.subarray(1)).toJSON().name}`); } catch { /* 読み捨て */ }
        return;
      }
      if (b[0] !== 3) return;
      const w = waiting.get(b.readUInt16LE(1));
      if (!w) return;
      waiting.delete(b.readUInt16LE(1));
      w((Wrapper.decode(b.subarray(3)) as unknown as { data: Uint8Array }).data);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('close', (code) => {
      clearInterval(hb);
      log(`[ws close] code=${code}`);
    });
    ws.on('open', () => {
      const call: Conn['call'] = (method, body) => {
        const m = root.lookup(`lq.${method}`);
        if (!(m instanceof protobuf.Method)) return Promise.reject(new Error(`method not found: ${method}`));
        m.resolve();
        const Req = m.resolvedRequestType!;
        const Res = m.resolvedResponseType!;
        const i = idx++ & 0xffff;
        const name = `.lq.${method}`;
        const frame = Buffer.concat([
          Buffer.from([2, i & 0xff, i >> 8]),
          Buffer.from(Wrapper.encode({ name, data: Req.encode(Req.fromObject(body)).finish() }).finish()),
        ]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            waiting.delete(i);
            rej(new Error(`${method}: 応答なし（${TIMEOUT_MS / 1000}秒）`));
          }, TIMEOUT_MS);
          waiting.set(i, (data) => {
            clearTimeout(t);
            let msg: any;
            try {
              msg = Res.toObject(Res.decode(data), { longs: Number, defaults: false });
              for (const u of unknownFields(Res, data)) {
                if (reportedUnknown.has(u)) continue;
                reportedUnknown.add(u);
                log(`[定義に無い項目] ${method}: ${u}`);
              }
            } catch (e) {
              rej(new DecodeError(method, e));
              return;
            }
            const code = msg.error?.code ?? 0;
            if (code) rej(new MajsoulError(method, code));
            else res(msg);
          });
          ws.send(frame);
        });
      };
      const heartbeat = () => call('Route.heartbeat', { delay: 0, no_operation_counter: 0, platform: 11, network_quality: 0 }).catch(() => {});
      resolve({
        call,
        startHeartbeat() {
          clearInterval(hb);
          hb = setInterval(heartbeat, 5000);
        },
        close() {
          clearInterval(hb);
          ws.close();
        },
      });
    });
  });
