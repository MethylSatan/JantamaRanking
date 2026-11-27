// 申請の画面（タスク 023）。Discord でログインしたが、まだ管理人に承認されていない人が見る。
// 名前とひとことを書いて申請し、承認を待つ。取り下げると、このサイトの情報（Discord の ID を含む）を消す。

import { useState } from 'preact/hooks';
import { api, LoginRequired, type Me } from './lib/api.ts';
import { logout } from './lib/auth.ts';
import { formatDateTime } from './lib/format.ts';

export function Apply({ me, onChanged, onLoginRequired }: { me: Me; onChanged: (me: Me) => void; onLoginRequired: () => void }) {
  const profile = me.profile;
  const [name, setName] = useState(profile?.name ?? '');
  const [note, setNote] = useState(profile?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fail = (e: unknown) => {
    if (e instanceof LoginRequired) onLoginRequired();
    else setError((e as Error).message);
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { profile: saved } = await api.putMyProfile(name, note);
      onChanged({ ...me, profile: saved });
      setMessage(profile ? '書き直しました。' : '申請しました。管理人の承認を待ってください。');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    const what = profile ? '申請を取り下げ、' : '';
    if (!confirm(`${what}このサイトに残っているあなたの情報を消しますか？`)) return;
    setBusy(true);
    try {
      await api.deleteMe();
      logout();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>主催者の申請</h1>
      {error && <p class="error">{error}</p>}
      {message && <p class="success">{message}</p>}
      {profile ? (
        <p>
          {formatDateTime(profile.appliedAt)} に申請しました。管理人が承認して、ランキングの主催者に付けると、ここでランキングを操作できるようになります。
        </p>
      ) : (
        <p>
          友人戦のランキングを作りたい方は、名前とひとことを書いて申請してください。管理人が確かめて承認します。
        </p>
      )}
      <form class="card" onSubmit={submit}>
        <label>
          名前（管理人に分かる呼び方。配信者名など）
          <input value={name} maxLength={100} required onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          ひとこと（どの友人戦のランキングか、連絡先など）
          <textarea value={note} maxLength={500} rows={4} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
        </label>
        <button type="submit" class="primary" disabled={busy || name.trim() === ''}>
          {profile ? '書き直す' : '申請する'}
        </button>
        <p class="note">書いた内容と Discord のユーザー ID は、管理人だけが見ます。</p>
      </form>
      <div class="card danger">
        <h2>{profile ? '申請を取り下げる' : '情報を消す'}</h2>
        <p class="note">このサイトに残っているあなたの情報（Discord のユーザー ID、申請の内容）を消して、ログアウトします。</p>
        <button type="button" disabled={busy} onClick={() => void withdraw()}>
          {profile ? '取り下げて消す' : '消す'}
        </button>
      </div>
    </section>
  );
}
