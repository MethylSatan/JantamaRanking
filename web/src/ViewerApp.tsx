// 閲覧の画面（タスク 027）: /ranking.html?id=<公開 ID>。ログインなしで、ランキングを見て並べ替え・絞り込みする。
// 絞り込みの状態は URL のクエリに持たせ、URL を渡せば同じ表を開ける。

import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatDateTime, formatPt, modeLabel } from './lib/format.ts';
import {
  joinNames,
  nextSort,
  notYetRows,
  parseRankingJson,
  periodLabel,
  queryFromState,
  rankingRows,
  stateFromQuery,
  yearsOf,
  type RankingJson,
  type SortKey,
  type ViewState,
} from './lib/viewer.ts';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: RankingJson; view: ViewState };

const NOT_FOUND = 'ランキングが見つかりません。非公開になったか、URL が古い可能性があります。主催者に新しい URL を確かめてください。';

export function ViewerApp() {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const [now] = useState(() => Date.now());
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    if (!id) {
      setLoad({ state: 'error', message: NOT_FOUND });
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/rankings/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
        if (res.status === 403 || res.status === 404) return setLoad({ state: 'error', message: NOT_FOUND });
        if (!res.ok) throw new Error(String(res.status));
        const data = parseRankingJson(await res.json());
        setLoad({ state: 'ready', data, view: stateFromQuery(new URLSearchParams(location.search), data.games, now) });
        document.title = `${data.name} | 友人戦ランキング`;
      } catch {
        setLoad({ state: 'error', message: '読み込めませんでした。時間をおいて、ページを再読み込みしてください。' });
      }
    })();
  }, [id]);

  const setView = (patch: Partial<ViewState>) =>
    setLoad((l) => {
      if (l.state !== 'ready') return l;
      const view = { ...l.view, ...patch };
      history.replaceState(null, '', `?${queryFromState(id, view)}`);
      return { ...l, view };
    });

  return (
    <>
      <header class="site-header">
        <span class="site-title">友人戦ランキング</span>
      </header>
      <main>
        {load.state === 'loading' && <p class="note">読み込み中…</p>}
        {load.state === 'error' && <p class="error">{load.message}</p>}
        {load.state === 'ready' && <Ranking data={load.data} view={load.view} now={now} setView={setView} />}
      </main>
      <footer>
        <a href="help.html">使い方</a> ・ <a href="privacy.html">プライバシーポリシー</a>
      </footer>
    </>
  );
}

function Ranking({ data, view, now, setView }: { data: RankingJson; view: ViewState; now: number; setView: (p: Partial<ViewState>) => void }) {
  const years = useMemo(() => yearsOf(data.games, now), [data, now]);
  return (
    <>
      <h1>{data.name}</h1>
      {data.generatedAt && <p class="note">最終更新: {formatDateTime(data.generatedAt)}</p>}

      <div class="filters">
        <div class="segmented" role="group" aria-label="四麻か三麻か">
          {(['4p', '3p'] as const).map((m) => (
            <button type="button" key={m} class={view.mode === m ? 'active' : ''} aria-pressed={view.mode === m} onClick={() => setView({ mode: m })}>
              {modeLabel(m)}
            </button>
          ))}
        </div>
      </div>

      <nav class="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view.tab === 'ranking'} class={view.tab === 'ranking' ? 'active' : ''} onClick={() => setView({ tab: 'ranking' })}>
          ランキング
        </button>
        <button type="button" role="tab" aria-selected={view.tab === 'notyet'} class={view.tab === 'notyet' ? 'active' : ''} onClick={() => setView({ tab: 'notyet' })}>
          今月まだの人
        </button>
      </nav>

      {view.tab === 'ranking' ? <RankingTab data={data} view={view} now={now} years={years} setView={setView} /> : <NotYetTab data={data} view={view} now={now} />}
    </>
  );
}

function RankingTab({ data, view, now, years, setView }: { data: RankingJson; view: ViewState; now: number; years: number[]; setView: (p: Partial<ViewState>) => void }) {
  const rows = useMemo(() => rankingRows(data.games, view, now), [data, view, now]);
  const p = view.period;
  const periodValue = p.kind === 'all' ? 'all' : p.kind === 'year' ? String(p.year) : 'range';

  const onPeriod = (v: string) => {
    if (v === 'all') setView({ period: { kind: 'all' } });
    else if (v === 'range') setView({ period: { kind: 'range', from: '', to: '' } });
    else setView({ period: { kind: 'year', year: Number(v) } });
  };

  const header = (key: SortKey, label: string, cls = '') => {
    const active = view.sort === key;
    return (
      <th class={cls} aria-sort={active ? (view.desc ? 'descending' : 'ascending') : 'none'}>
        <button type="button" class="sort" onClick={() => setView(nextSort(view, key))}>
          {label}
          <span class="arrow" aria-hidden="true">{active ? (view.desc ? '▼' : '▲') : ''}</span>
        </button>
      </th>
    );
  };

  return (
    <>
      <div class="filters">
        <label>
          期間
          <select value={periodValue} onChange={(e) => onPeriod(e.currentTarget.value)}>
            <option value="all">全期間</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}年
              </option>
            ))}
            <option value="range">期間を指定</option>
          </select>
        </label>
        {p.kind === 'range' && (
          <>
            <label>
              開始日
              <input type="date" value={p.from} max={p.to || undefined} onChange={(e) => setView({ period: { ...p, from: e.currentTarget.value } })} />
            </label>
            <label>
              終了日
              <input type="date" value={p.to} min={p.from || undefined} onChange={(e) => setView({ period: { ...p, to: e.currentTarget.value } })} />
            </label>
          </>
        )}
        <label>
          名前
          <input type="search" value={view.q} placeholder="名前の一部" onInput={(e) => setView({ q: e.currentTarget.value })} />
        </label>
      </div>
      <p class="note">
        {modeLabel(view.mode)}・{periodLabel(p)}。日付は朝6時で区切ります（深夜の対局は前の日）。見出しを押すと並べ替えます。
      </p>

      {rows.length === 0 ? (
        <p>{view.q.trim() ? '名前に合う人がいません。' : 'この期間の対局はありません。'}</p>
      ) : (
        <div class="table-wrap">
          <table class="ranking">
            <thead>
              <tr>
                {header('rank', '順位', 'num')}
                {header('name', '名前')}
                {header('totalPt', '累計pt', 'num')}
                {header('avgPt', '平均pt', 'num')}
                {header('games', '対局数', 'num')}
                {header('tops', 'トップ', 'num')}
                {header('thisMonth', '今月', 'center')}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td class="num">{r.rank}</td>
                  <td class="name">{r.name}</td>
                  <td class="num">{formatPt(r.totalPt)}</td>
                  <td class="num">{formatPt(r.avgPt)}</td>
                  <td class="num">{r.games}</td>
                  <td class="num">{r.tops}</td>
                  <td class="center" title={r.thisMonth ? '今月参加済み' : '今月はまだ'}>
                    {r.thisMonth ? '◯' : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NotYetTab({ data, view, now }: { data: RankingJson; view: ViewState; now: number }) {
  const rows = useMemo(() => notYetRows(data.games, view.mode, now), [data, view.mode, now]);
  const line = joinNames(rows);
  const [copied, setCopied] = useState<'ok' | 'ng' | ''>('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied('ok');
    } catch {
      setCopied('ng');
    }
  };

  return (
    <>
      <p class="note">今年{modeLabel(view.mode)}を打った人のうち、今月まだ打っていない人です（今年の対局数の多い順）。期間と名前の絞り込みは効きません。</p>
      {rows.length === 0 ? (
        <p>該当する人はいません。</p>
      ) : (
        <>
          <div class="card">
            <h2>名前を1行で</h2>
            <p class="joined">{line}</p>
            <div class="actions">
              <button type="button" onClick={copy}>
                コピー
              </button>
              {copied === 'ok' && <span class="success">コピーしました</span>}
              {copied === 'ng' && <span class="error">コピーできませんでした。上の文を選んでコピーしてください</span>}
            </div>
          </div>
          <div class="table-wrap">
            <table class="ranking">
              <thead>
                <tr>
                  <th class="num">#</th>
                  <th>名前</th>
                  <th class="num">今年の対局数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td class="num">{r.rank}</td>
                    <td class="name">{r.name}</td>
                    <td class="num">{r.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
