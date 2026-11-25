// 管理の画面（タスク 026）。ログイン → ランキングの一覧（#/）→ ランキング（#/r/<ID>）。

import { useEffect, useState } from 'preact/hooks';
import { api, LoginRequired, type Me } from './lib/api.ts';
import { handleRedirect, loadTokens, logout, startLogin } from './lib/auth.ts';
import { RankingList } from './RankingList.tsx';
import { RankingPage } from './RankingPage.tsx';

type Route = { page: 'list' } | { page: 'ranking'; id: string };

function parseHash(hash: string): Route {
  const m = /^#\/r\/([0-9a-f-]{36})$/.exec(hash);
  return m ? { page: 'ranking', id: m[1]! } : { page: 'list' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

type Session = { state: 'loading' } | { state: 'login'; error?: string } | { state: 'ready'; me: Me } | { state: 'error'; error: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const route = useRoute();

  useEffect(() => {
    (async () => {
      try {
        await handleRedirect();
      } catch (e) {
        setSession({ state: 'login', error: (e as Error).message });
        return;
      }
      if (!loadTokens()) {
        setSession({ state: 'login' });
        return;
      }
      try {
        setSession({ state: 'ready', me: await api.me() });
      } catch (e) {
        if (e instanceof LoginRequired) setSession({ state: 'login' });
        else setSession({ state: 'error', error: (e as Error).message });
      }
    })();
  }, []);

  const onLoginRequired = () => setSession({ state: 'login', error: 'ログインの期限が切れました。もう一度ログインしてください。' });

  return (
    <>
      <header class="site-header">
        <a href="#/" class="site-title">友人戦ランキング 管理</a>
        {session.state === 'ready' && (
          <span class="who">
            {session.me.admin ? '管理人' : '主催者'}としてログイン中
            <button type="button" class="link" onClick={logout}>
              ログアウト
            </button>
          </span>
        )}
      </header>
      <main>
        {session.state === 'loading' && <p>読み込んでいます…</p>}
        {session.state === 'error' && <p class="error">{session.error}</p>}
        {session.state === 'login' && (
          <section class="login">
            {session.error && <p class="error">{session.error}</p>}
            <p>管理の画面を使うには、Discord でログインしてください。</p>
            <p>
              <button id="login" type="button" class="primary" onClick={() => void startLogin()}>
                Discord でログイン
              </button>
            </p>
            <p class="note">ログインできるのは、管理人が登録した人だけです。</p>
          </section>
        )}
        {session.state === 'ready' &&
          (route.page === 'list' ? (
            <RankingList me={session.me} onLoginRequired={onLoginRequired} />
          ) : (
            <RankingPage key={route.id} id={route.id} me={session.me} onLoginRequired={onLoginRequired} />
          ))}
      </main>
      <footer>
        <a href="privacy.html">プライバシーポリシー</a>
      </footer>
    </>
  );
}
