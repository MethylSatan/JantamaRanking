// 利用者（管理人だけ）。申請中・承認済み・ログインだけの人を出し、承認・却下（削除）する。
// 主催者に付けるのは、ランキングの設定のタブで行う。

import { useEffect, useState } from 'preact/hooks';
import { api, LoginRequired, type UserRow } from './lib/api.ts';
import { formatDateTime } from './lib/format.ts';

const label = (u: UserRow) => u.name ?? `Discord ID ${u.discordId ?? '不明'}`;

export function UserList({ onLoginRequired }: { onLoginRequired: () => void }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    if (e instanceof LoginRequired) onLoginRequired();
    else {
      setMessage('');
      setError((e as Error).message);
    }
  };
  const load = () => api.listUsers().then((r) => setUsers(r.users), fail);
  useEffect(() => void load(), []);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      setMessage(done);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = (u: UserRow) => {
    const what = u.status === 'approved' ? 'この人を利用者から外し' : 'この申請を却下し';
    if (confirm(`「${label(u)}」について、${what}、情報（Discord の ID・申請の内容・主催者の設定）を消しますか？`)) {
      void run(() => api.deleteUser(u.sub), `「${label(u)}」を消しました。`);
    }
  };

  const pending = users?.filter((u) => !u.admin && u.status === 'pending') ?? [];
  const approved = users?.filter((u) => u.admin || u.status === 'approved') ?? [];
  const loginOnly = users?.filter((u) => !u.admin && u.status === undefined) ?? [];

  const row = (u: UserRow, actions: preact.ComponentChildren) => (
    <li key={u.sub} class="card user">
      <p>
        <strong>{label(u)}</strong> {u.admin && <span class="badge">管理人</span>}
      </p>
      {u.note && <p class="pre">{u.note}</p>}
      <p class="note">
        Discord ID {u.discordId ?? '不明'} / {u.appliedAt ? `申請 ${formatDateTime(u.appliedAt)}` : `ログイン ${formatDateTime(u.createdAt)}`}
        {u.rankingIds.length > 0 && ` / 主催者のランキング ${u.rankingIds.length}件`}
      </p>
      {!u.admin && <p class="actions">{actions}</p>}
    </li>
  );

  return (
    <section>
      <p>
        <a href="#/">← ランキングの一覧</a>
      </p>
      <h1>利用者</h1>
      {error && <p class="error">{error}</p>}
      {message && <p class="success">{message}</p>}
      {users === null && !error && <p>読み込んでいます…</p>}
      {users !== null && (
        <>
          <h2>申請中 {pending.length}件</h2>
          {pending.length === 0 ? (
            <p class="note">申請はありません。</p>
          ) : (
            <ul class="users">
              {pending.map((u) =>
                row(
                  u,
                  <>
                    <button type="button" class="primary" disabled={busy} onClick={() => void run(() => api.approveUser(u.sub), `「${label(u)}」を承認しました。ランキングの設定で主催者に付けてください。`)}>
                      承認する
                    </button>
                    <button type="button" disabled={busy} onClick={() => remove(u)}>
                      却下して消す
                    </button>
                  </>,
                ),
              )}
            </ul>
          )}
          <h2>承認済み {approved.length}件</h2>
          <ul class="users">
            {approved.map((u) =>
              row(
                u,
                <button type="button" disabled={busy} onClick={() => remove(u)}>
                  利用者から外して消す
                </button>,
              ),
            )}
          </ul>
          {loginOnly.length > 0 && (
            <>
              <h2>ログインだけした人 {loginOnly.length}件</h2>
              <p class="note">申請を書いていない人です。心当たりがなければ消してください。</p>
              <ul class="users">
                {loginOnly.map((u) =>
                  row(
                    u,
                    <button type="button" disabled={busy} onClick={() => remove(u)}>
                      消す
                    </button>,
                  ),
                )}
              </ul>
            </>
          )}
          <p class="note">利用者は合わせて50人までです（それを超えると、新しくログインできません）。いま {users.length}人。</p>
        </>
      )}
    </section>
  );
}
