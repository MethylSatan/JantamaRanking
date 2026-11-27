// Cognito の利用者（タスク 023）。誰でも Discord でログインでき、利用者の一覧は Cognito を元にする
// （ログインしただけで申請していない人も、管理人に見えて消せるように）。本番は aws.ts の CognitoDirectory。

/** Cognito の利用者 */
export interface DirectoryUser {
  sub: string;
  /** Cognito の利用者名（Discord からのログインは `Discord_<Discord の ID>`） */
  username: string;
  createdAt: string;
}

export interface Directory {
  listUsers(): Promise<DirectoryUser[]>;
  findUser(sub: string): Promise<DirectoryUser | undefined>;
  /** Admin（グループ admins）の sub */
  listAdminSubs(): Promise<string[]>;
  /** 全端末でサインアウトさせてから消す */
  deleteUser(username: string): Promise<void>;
}

/** 利用者名から Discord の ID を取る（`Discord_<数字>`）。違う形なら undefined */
export const discordIdOf = (username: string): string | undefined => /^Discord_(\d+)$/i.exec(username)?.[1];

/** テスト用 */
export class MemoryDirectory implements Directory {
  readonly users = new Map<string, DirectoryUser>();
  readonly admins = new Set<string>();
  readonly deleted: string[] = [];

  add(sub: string, discordId: string, opts: { admin?: boolean; createdAt?: string } = {}) {
    this.users.set(sub, { sub, username: `Discord_${discordId}`, createdAt: opts.createdAt ?? '2026-11-01T00:00:00.000Z' });
    if (opts.admin) this.admins.add(sub);
  }

  async listUsers() {
    return [...this.users.values()];
  }

  async findUser(sub: string) {
    return this.users.get(sub);
  }

  async listAdminSubs() {
    return [...this.admins];
  }

  async deleteUser(username: string) {
    for (const [sub, u] of this.users) {
      if (u.username === username) {
        this.users.delete(sub);
        this.deleted.push(username);
      }
    }
  }
}
