/** API が利用者に返す誤り。status をそのまま応答の状態コードにする */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
