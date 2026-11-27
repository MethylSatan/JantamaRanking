// ランキングの一覧と作成。

import { useEffect, useState } from 'preact/hooks';
import { api, LoginRequired, type Me, type RankingListItem } from './lib/api.ts';
import { ACCOUNT_ALERT_COUNT } from './lib/format.ts';
import { canGlobal } from './lib/permissions.ts';

export function RankingList({ me, onLoginRequired }: { me: Me; onLoginRequired: () => void }) {
  const [rankings, setRankings] = useState<RankingListItem[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    if (e instanceof LoginRequired) onLoginRequired();
    else setError((e as Error).message);
  };

  useEffect(() => {
    api.listRankings().then((r) => setRankings(r.rankings), fail);
  }, []);

  const create = async (ev: Event) => {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await api.createRanking(name);
      location.hash = `#/r/${created.id}`;
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const visible = rankings?.filter((r) => r.state === 'public') ?? [];
  const deleted = rankings?.filter((r) => r.state === 'deleted') ?? [];

  return (
    <section>
      <h1>ランキング</h1>
      {canGlobal(me, 'manageUsers') && (
        <p>
          <a href="#/users">利用者（申請の承認・却下）</a>
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {rankings === null && !error && <p>読み込んでいます…</p>}
      {rankings !== null && rankings.length === 0 && (
        <p>{me.admin ? 'まだランキングがありません。下から作成してください。' : '操作できるランキングがありません。管理人に連絡してください。'}</p>
      )}
      {visible.length > 0 && (
        <ul class="ranking-list">
          {visible.map((r) => (
            <li key={r.id}>
              <a href={`#/r/${r.id}`}>{r.name}</a>
              {r.accountCount !== undefined && r.accountCount >= ACCOUNT_ALERT_COUNT && (
                <>
                  {' '}
                  <span class="badge" title="雀魂への要求が多くなります。必要なアカウントか確かめてください。">
                    雀魂アカウント {r.accountCount}件
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleted.length > 0 && (
        <details>
          <summary>削除（非公開）にしたランキング {deleted.length}件</summary>
          <ul class="ranking-list">
            {deleted.map((r) => (
              <li key={r.id}>
                <a href={`#/r/${r.id}`}>{r.name}</a> <span class="badge">非公開</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {canGlobal(me, 'createRanking') && (
        <form class="card" onSubmit={create}>
          <h2>ランキングを作る</h2>
          <label>
            名前
            <input
              value={name}
              maxLength={100}
              required
              placeholder="例: ○○さんの友人戦"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="primary" disabled={busy || name.trim() === ''}>
            作成する
          </button>
          <p class="note">作成したあと、設定で雀魂アカウントを指定すると、対局の候補を取ってこられます。</p>
        </form>
      )}
    </section>
  );
}
