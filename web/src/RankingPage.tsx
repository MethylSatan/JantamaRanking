// ランキングの画面: 候補 / 取り込み済み / 対象外 / 操作ログ / 設定。
// 時間のかかる操作（候補の更新・取り込み・作り直し）は処理（ジョブ）になるので、終わるまで進み具合を出す。

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  api,
  LoginRequired,
  type AccountView,
  type GameListState,
  type GamesAccount,
  type GameState,
  type Job,
  type LogEntry,
  type Me,
  type MergedCandidate,
  type Operation,
  type Player,
  type RankingDetail,
  type HostView,
  type UserRow,
} from './lib/api.ts';
import { accountLabel, formatDateTime, formatPt, jobSummary, lengthLabel, logSummary, modeLabel, opLabel, publicUrl } from './lib/format.ts';
import { isFinished, waitJob } from './lib/job.ts';
import { canOnRanking } from './lib/permissions.ts';

type Tab = GameListState | 'logs' | 'settings';
const TABS: [Tab, string][] = [
  ['candidate', '候補'],
  ['imported', '取り込み済み'],
  ['excluded', '対象外'],
  ['logs', '操作ログ'],
  ['settings', '設定'],
];

/** 一度に取り込める件数（API の上限） */
const IMPORT_LIMIT = 100;

interface Shared {
  ranking: RankingDetail;
  me: Me;
  can: (op: Operation) => boolean;
  /** 処理を始めて、終わるまで見る */
  runJob: (start: () => Promise<{ job: Job }>) => Promise<void>;
  jobRunning: boolean;
  /** 変わったら一覧を読み直す */
  version: number;
  /** 一覧などを読み直す */
  changed: () => void;
  setRanking: (r: RankingDetail) => void;
  fail: (e: unknown) => void;
  notify: (message: string) => void;
}

export function RankingPage({ id, me, onLoginRequired }: { id: string; me: Me; onLoginRequired: () => void }) {
  const [ranking, setRanking] = useState<RankingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('candidate');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [version, setVersion] = useState(0);
  // 処理を始めてから終わるまで。API が返る前（job がまだ null）の二重押しも防ぐ
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const abort = useRef(new AbortController());

  const fail = (e: unknown) => {
    if (e instanceof LoginRequired) onLoginRequired();
    else {
      setMessage('');
      setError((e as Error).message);
    }
  };
  const notify = (m: string) => {
    setError('');
    setMessage(m);
  };

  useEffect(() => {
    api.getRanking(id).then(setRanking, fail);
    const ctrl = abort.current;
    return () => ctrl.abort();
  }, [id]);

  if (!ranking) {
    return (
      <section>
        <p>
          <a href="#/">← ランキングの一覧</a>
        </p>
        {error ? <p class="error">{error}</p> : <p>読み込んでいます…</p>}
      </section>
    );
  }

  const jobRunning = starting || (job !== null && !isFinished(job));
  const shared: Shared = {
    ranking,
    me,
    can: (op) => canOnRanking(me, ranking.via, op),
    jobRunning,
    version,
    changed: () => setVersion((v) => v + 1),
    setRanking,
    fail,
    notify,
    runJob: async (start) => {
      // 同じ描画の間の連打は state では止められないので ref で弾く
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      setError('');
      setMessage('');
      try {
        const { job: started } = await start();
        await waitJob(started, async (jobId) => (await api.job(jobId)).job, setJob, { signal: abort.current.signal });
      } catch (e) {
        fail(e);
      } finally {
        startingRef.current = false;
        setStarting(false);
        setVersion((v) => v + 1);
      }
    },
  };

  return (
    <section>
      <p>
        <a href="#/">← ランキングの一覧</a>
      </p>
      <h1>{ranking.name}</h1>
      {ranking.state === 'deleted' && <p class="warning">このランキングは削除（非公開）されています。閲覧者からは見られません。</p>}
      {job && <JobPanel job={job} onClose={jobRunning ? undefined : () => setJob(null)} />}
      {error && <p class="error">{error}</p>}
      {message && <p class="success">{message}</p>}
      <nav class="tabs" role="tablist">
        {TABS.filter(([t]) => t !== 'logs' || shared.can('viewLogs')).map(([t, label]) => (
          <button type="button" role="tab" key={t} aria-selected={tab === t} class={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'candidate' && <CandidatesTab {...shared} />}
      {(tab === 'imported' || tab === 'excluded') && <StatesTab key={tab} state={tab} {...shared} />}
      {tab === 'logs' && <LogsTab {...shared} />}
      {tab === 'settings' && <SettingsTab {...shared} />}
    </section>
  );
}

const JOB_KIND_LABELS: Record<string, string> = { refresh: '候補の更新', import: '取り込み', rebuild: '作り直し' };

function JobPanel({ job, onClose }: { job: Job; onClose?: () => void }) {
  const { lines, warnings } = isFinished(job) ? jobSummary(job) : { lines: [], warnings: [] };
  return (
    <div class={`card job ${job.status}`} role="status" aria-live="polite">
      <p>
        <strong>{JOB_KIND_LABELS[job.kind] ?? job.kind}</strong>
        {': '}
        {job.status === 'queued' && '始めています…'}
        {job.status === 'running' && `${job.progress ?? '処理しています'}…`}
        {job.status === 'done' && '終わりました'}
        {job.status === 'failed' && '失敗しました'}
        {onClose && (
          <button type="button" class="link close" onClick={onClose}>
            閉じる
          </button>
        )}
      </p>
      {!isFinished(job) && <p class="note">数十秒かかることがあります。この画面を開いたままお待ちください。</p>}
      {lines.length > 0 && (
        <ul>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul class="warning">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useGames(s: Shared, state: GameListState) {
  const [data, setData] = useState<{ accounts: GamesAccount[]; games: (MergedCandidate | GameState)[] } | null>(null);
  useEffect(() => {
    let live = true;
    api.listGames(s.ranking.id, state).then((r) => live && setData(r), s.fail);
    return () => {
      live = false;
    };
  }, [s.ranking.id, state, s.version]);
  return data;
}

function Players({ players }: { players: { rank: number; name: string; pt?: number; score?: number }[] }) {
  return (
    <ol class="players">
      {[...players]
        .sort((a, b) => a.rank - b.rank)
        .map((p) => (
          <li key={p.rank}>
            <span class="rank">{p.rank}位</span> {p.name}
            {p.pt !== undefined && <span class="pt"> {formatPt(p.pt)}</span>}
          </li>
        ))}
    </ol>
  );
}

function AccountsStatus({ accounts }: { accounts: GamesAccount[] }) {
  if (accounts.length === 0) return <p class="warning">雀魂アカウントが指定されていません。「設定」で指定してください。</p>;
  return (
    <ul class="accounts">
      {accounts.map((a) => (
        <li key={a.internalId ?? a.pendingId}>
          雀魂アカウント {accountLabel(a)}:{' '}
          {a.lastRefreshedAt ? `最後に更新 ${formatDateTime(a.lastRefreshedAt)}` : 'まだ更新していません'}
        </li>
      ))}
    </ul>
  );
}

function CandidatesTab(s: Shared) {
  const data = useGames(s, 'candidate');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const games = (data?.games ?? []) as MergedCandidate[];

  useEffect(() => setSelected(new Set()), [s.version]);

  const toggle = (uuid: string) => {
    const next = new Set(selected);
    if (next.has(uuid)) next.delete(uuid);
    else next.add(uuid);
    setSelected(next);
  };
  const allSelected = games.length > 0 && games.every((g) => selected.has(g.uuid));

  const exclude = async (uuid: string) => {
    s.notify('');
    setBusy(true);
    try {
      await api.exclude(s.ranking.id, uuid);
      s.notify('対象外にしました。「対象外」のタブから戻せます。');
      s.changed();
    } catch (e) {
      s.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {data && <AccountsStatus accounts={data.accounts} />}
      <div class="actions">
        {s.can('refresh') && (
          <button
            type="button"
            class="primary"
            disabled={s.jobRunning || data?.accounts.length === 0}
            onClick={() => void s.runJob(() => api.refresh(s.ranking.id))}
          >
            候補を更新（雀魂から取ってくる）
          </button>
        )}
      </div>
      <p class="note">
        雀魂は、アカウントごとに最近の友人戦を50件までしか返しません。50件に近づいたら、早めに取り込むか対象外にしてください。
      </p>
      {!data && <p>読み込んでいます…</p>}
      {data && games.length === 0 && <p>候補の対局はありません。</p>}
      {games.length > 0 && (
        <>
          {s.can('import') && (
            <div class="actions sticky">
              <button
                type="button"
                class="primary"
                disabled={s.jobRunning || selected.size === 0 || selected.size > IMPORT_LIMIT}
                onClick={() => void s.runJob(() => api.importGames(s.ranking.id, [...selected]))}
              >
                選んだ{selected.size}件を取り込む
              </button>
              {selected.size > IMPORT_LIMIT && <span class="error">一度に取り込めるのは{IMPORT_LIMIT}件までです。</span>}
            </div>
          )}
          <table class="games">
            <thead>
              <tr>
                {s.can('import') && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="すべて選ぶ"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(games.map((g) => g.uuid)))}
                    />
                  </th>
                )}
                <th>終了日時</th>
                <th>種類</th>
                <th>参加者（順位）</th>
                {s.can('exclude') && <th></th>}
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.uuid} class={selected.has(g.uuid) ? 'selected' : ''}>
                  {s.can('import') && (
                    <td>
                      <input type="checkbox" aria-label="選ぶ" checked={selected.has(g.uuid)} onChange={() => toggle(g.uuid)} />
                    </td>
                  )}
                  <td class="nowrap">{formatDateTime(g.endTime)}</td>
                  <td class="nowrap">
                    {modeLabel(g.mode)} {lengthLabel(g.subTag)}
                    {data && data.accounts.length > 1 && (
                      <div class="note">
                        {g.sources.map((id) => accountLabel(data.accounts.find((a) => a.internalId === id) ?? { internalId: id })).join('・')}
                      </div>
                    )}
                  </td>
                  <td>
                    <Players players={g.players.map((p) => ({ rank: p.rank, name: p.nickname }))} />
                  </td>
                  {s.can('exclude') && (
                    <td>
                      <button type="button" disabled={busy} onClick={() => void exclude(g.uuid)}>
                        対象外にする
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** 牌譜 uuid の先頭（yymmdd）から対局の日付。結果を持たない対象外の対局に使う */
const dateFromUuid = (uuid: string): string => {
  const m = /^(\d{2})(\d{2})(\d{2})-/.exec(uuid);
  return m ? `20${m[1]}/${m[2]}/${m[3]}` : '';
};

function StatesTab(s: Shared & { state: 'imported' | 'excluded' }) {
  const data = useGames(s, s.state);
  const [busy, setBusy] = useState(false);
  const games = (data?.games ?? []) as GameState[];

  const act = async (uuid: string) => {
    s.notify('');
    setBusy(true);
    try {
      if (s.state === 'imported') {
        await api.exclude(s.ranking.id, uuid);
        s.notify('対象外にしました。ランキングから外れました。「対象外」のタブから戻せます。');
      } else {
        const { game } = await api.restore(s.ranking.id, uuid);
        s.notify(game.state === 'imported' ? '取り込み済みに戻しました。ランキングに入りました。' : '候補に戻しました。');
      }
      s.changed();
    } catch (e) {
      s.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {s.state === 'imported' && <p class="note">ここにある対局がランキングに入ります。</p>}
      {s.state === 'excluded' && <p class="note">ここにある対局はランキングに入りません。「戻す」で元に戻せます。</p>}
      {!data && <p>読み込んでいます…</p>}
      {data && games.length === 0 && <p>対局はありません。</p>}
      {games.length > 0 && (
        <table class="games">
          <thead>
            <tr>
              <th>終了日時</th>
              <th>種類</th>
              <th>参加者（順位・pt）</th>
              {s.can('exclude') && <th></th>}
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.uuid}>
                <td class="nowrap">{g.result ? formatDateTime(g.result.endTime) : dateFromUuid(g.uuid)}</td>
                <td class="nowrap">{g.result ? modeLabel(g.result.mode) : ''}</td>
                <td>
                  {g.result ? (
                    <Players players={g.result.players} />
                  ) : (
                    <span class="note">取り込む前に対象外にした対局</span>
                  )}
                </td>
                {s.can('exclude') && (
                  <td>
                    <button type="button" disabled={busy} onClick={() => void act(g.uuid)}>
                      {s.state === 'imported' ? '対象外にする' : '戻す'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LogsTab(s: Shared) {
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    api.logs(s.ranking.id).then((r) => setLogs(r.logs), s.fail);
  }, [s.ranking.id, s.version]);
  if (!logs) return <p>読み込んでいます…</p>;
  if (logs.length === 0) return <p>操作の記録はまだありません。</p>;
  return (
    <div>
      <p class="note">新しい順に100件まで出します。</p>
      <table class="logs">
        <thead>
          <tr>
            <th>日時</th>
            <th>だれ</th>
            <th>操作</th>
            <th>内容</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={`${l.at}${l.op}${l.target ?? ''}`}>
              <td class="nowrap">{formatDateTime(l.at)}</td>
              <td class="nowrap">
                {l.sub === s.me.sub ? '自分' : 'ほかの人'}（{l.via === 'admin' ? '管理人' : '主催者'}）
              </td>
              <td class="nowrap">{opLabel(l.op)}</td>
              <td>{logSummary(l)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab(s: Shared) {
  const { ranking } = s;
  const [name, setName] = useState(ranking.name);
  const [displayId, setDisplayId] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const specified = new Set(ranking.accounts.map((a) => a.internalId));
  const choices = players.filter((p) => !specified.has(p.internalId));

  // 雀魂アカウントを選ぶための、ランキングの対局の参加者
  useEffect(() => {
    if (!s.can('setAccounts')) return;
    let alive = true;
    api.listPlayers(ranking.id).then(
      (r) => alive && setPlayers(r.players),
      (e) => alive && s.fail(e),
    );
    return () => {
      alive = false;
    };
  }, [ranking.id, s.version]);
  const url = publicUrl(location.origin, ranking.publicId);

  const run = async (fn: () => Promise<RankingDetail>, done: string) => {
    s.notify('');
    setBusy(true);
    try {
      s.setRanking(await fn());
      s.notify(done);
      s.changed();
      return true;
    } catch (e) {
      s.fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings">
      {s.can('rename') && (
        <form
          class="card"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.renameRanking(ranking.id, name), '名前を変えました。');
          }}
        >
          <h2>名前</h2>
          <label>
            ランキングの名前（閲覧者にも見えます）
            <input value={name} maxLength={100} required onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <button type="submit" disabled={busy || name.trim() === '' || name.trim() === ranking.name}>
            名前を変える
          </button>
        </form>
      )}

      <div class="card">
        <h2>雀魂アカウント</h2>
        <p class="note">
          ここに指定した雀魂アカウントの友人戦が、候補として出てきます（ふつうは友人戦の部屋を立てる人）。複数指定できます。
        </p>
        {ranking.accounts.length === 0 ? (
          <p>まだ指定していません。</p>
        ) : (
          <ul class="accounts">
            {ranking.accounts.map((a: AccountView) => (
              <li key={a.internalId ?? a.pendingId}>
                {accountLabel(a)}
                {s.can('setAccounts') && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const label = accountLabel(a);
                      if (confirm(`雀魂アカウント「${label}」を外しますか？（取り込み済みの対局はそのまま残ります）`)) {
                        void run(() => api.removeAccount(ranking.id, a), `「${label}」を外しました。`);
                      }
                    }}
                  >
                    外す
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {s.can('setAccounts') && (
          <>
            <h3>対局の参加者から選ぶ</h3>
            {choices.length === 0 ? (
              <p class="note">このランキングの対局（取り込み済み・候補）に、まだ指定していない参加者がいません。</p>
            ) : (
              <form
                class="inline"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const p = choices.find((c) => c.internalId === picked);
                  if (!p) return;
                  if (await run(() => api.addAccount(ranking.id, p.internalId), `「${p.name}」を指定しました。「候補」のタブで候補を更新してください。`)) {
                    setPicked('');
                  }
                }}
              >
                <select value={picked} aria-label="参加者" onChange={(e) => setPicked((e.target as HTMLSelectElement).value)}>
                  <option value="">選んでください</option>
                  {choices.map((p) => (
                    <option key={p.internalId} value={p.internalId}>
                      {p.name}（{p.games}局）
                    </option>
                  ))}
                </select>
                <button type="submit" disabled={busy || picked === ''}>
                  指定する
                </button>
              </form>
            )}
            <h3>雀魂の ID で指定する</h3>
            <p class="note">
              対局がまだ無いときは、雀魂のプロフィールや友達追加の画面に出る数字の ID で指定できます。ID は次の候補の更新でアカウントを確かめるためだけに使い、確かめたら消します。ほかの管理人・主催者の画面にも出しません。
            </p>
            <form
              class="inline"
              onSubmit={async (e) => {
                e.preventDefault();
                const id = displayId.trim();
                if (await run(() => api.addAccountByDisplayId(ranking.id, id), '指定しました。「候補」のタブで候補を更新してください。')) {
                  setDisplayId('');
                }
              }}
            >
              <input
                value={displayId}
                inputMode="numeric"
                autocomplete="off"
                pattern="[0-9]{1,12}"
                placeholder="例: 12345678"
                aria-label="雀魂の ID"
                onInput={(e) => setDisplayId((e.target as HTMLInputElement).value)}
              />
              <button type="submit" disabled={busy || !/^\d{1,12}$/.test(displayId.trim())}>
                指定する
              </button>
            </form>
          </>
        )}
      </div>

      {s.can('manageHosts') && <HostsCard {...s} />}

      {s.can('publicUrl') && (
        <div class="card">
          <h2>公開 URL</h2>
          {ranking.state === 'deleted' ? (
            <p>削除（非公開）にしたランキングは、閲覧者から見られません。</p>
          ) : (
            <>
              <p class="note">この URL を知っている人は、ログインせずにランキングを見られます。検索には出ません。</p>
              <p class="url">
                <input readOnly value={url} aria-label="公開 URL" onFocus={(e) => (e.target as HTMLInputElement).select()} />
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(url).then(() => s.notify('URL をコピーしました。'), s.fail)}
                >
                  コピー
                </button>
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirm('公開 URL を新しくしますか？今までの URL では見られなくなります。')) {
                    void run(() => api.regeneratePublicId(ranking.id), '公開 URL を新しくしました。新しい URL を閲覧者に伝えてください。');
                  }
                }}
              >
                URL を新しくする
              </button>
            </>
          )}
        </div>
      )}

      {s.can('rebuild') && (
        <div class="card">
          <h2>作り直し</h2>
          <p class="note">保存してある牌譜から、取り込み済みの対局の結果とランキングを作り直します。集計がおかしいときに使います。雀魂には接続しません。</p>
          <button
            type="button"
            disabled={s.jobRunning}
            onClick={() => {
              if (confirm('ランキングを作り直しますか？')) void s.runJob(() => api.rebuild(ranking.id));
            }}
          >
            作り直す
          </button>
        </div>
      )}

      {s.can('deleteRanking') && ranking.state !== 'deleted' && (
        <div class="card danger">
          <h2>削除</h2>
          <p class="note">ランキングを非公開にします。取り込んだデータは消えません（戻すときは開発者に連絡してください）。</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm(`「${ranking.name}」を削除（非公開に）しますか？`)) {
                void run(() => api.deleteRanking(ranking.id), '削除（非公開に）しました。');
              }
            }}
          >
            削除する
          </button>
        </div>
      )}
    </div>
  );
}

/** 主催者（Host）の付け外し。管理人だけ（タスク 023）。付けられるのは「利用者」で承認した人 */
function HostsCard(s: Shared) {
  const { ranking } = s;
  const [hosts, setHosts] = useState<HostView[] | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listHosts(ranking.id), api.listUsers()]).then(
      ([h, u]) => {
        if (!alive) return;
        setHosts(h.hosts);
        setUsers(u.users);
      },
      (e) => alive && s.fail(e),
    );
    return () => {
      alive = false;
    };
  }, [ranking.id]);

  const current = new Set(hosts?.map((h) => h.sub));
  const choices = users.filter((u) => !u.admin && u.status === 'approved' && !current.has(u.sub));
  const hostLabel = (h: HostView) => h.name ?? `Discord ID ${h.discordId ?? '不明'}`;

  const run = async (fn: () => Promise<{ hosts: HostView[] }>, done: string) => {
    s.notify('');
    setBusy(true);
    try {
      setHosts((await fn()).hosts);
      s.notify(done);
      return true;
    } catch (e) {
      s.fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="card">
      <h2>主催者</h2>
      <p class="note">主催者は、このランキングの候補の更新・取り込み・雀魂アカウントの指定などができます（作成・削除・主催者の付け外しはできません）。</p>
      {hosts === null ? (
        <p>読み込んでいます…</p>
      ) : hosts.length === 0 ? (
        <p>まだいません（管理人だけで操作しています）。</p>
      ) : (
        <ul class="hosts">
          {hosts.map((h) => (
            <li key={h.sub}>
              {hostLabel(h)}{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirm(`「${hostLabel(h)}」をこのランキングの主催者から外しますか？`)) {
                    void run(() => api.removeHost(ranking.id, h.sub), `「${hostLabel(h)}」を外しました。`);
                  }
                }}
              >
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      {choices.length === 0 ? (
        <p class="note">
          付けられる人がいません。主催者にしたい人に、管理の画面に Discord でログインして申請してもらい、<a href="#/users">利用者</a>で承認してください。
        </p>
      ) : (
        <form
          class="inline"
          onSubmit={async (e) => {
            e.preventDefault();
            const u = choices.find((c) => c.sub === picked);
            if (!u) return;
            if (await run(() => api.addHost(ranking.id, u.sub), `「${u.name ?? ''}」を主催者に付けました。`)) setPicked('');
          }}
        >
          <select value={picked} aria-label="承認済みの利用者" onChange={(e) => setPicked((e.target as HTMLSelectElement).value)}>
            <option value="">選んでください</option>
            {choices.map((u) => (
              <option key={u.sub} value={u.sub}>
                {u.name}（Discord ID {u.discordId ?? '不明'}）
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || picked === ''}>
            主催者に付ける
          </button>
        </form>
      )}
    </div>
  );
}
