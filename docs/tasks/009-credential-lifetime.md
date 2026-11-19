# 009 運営アカウントの認証情報の有効期間と取り直し方

状態: doing / 依存: 007

## 目的
L2 では、ブラウザのログインで得た `code` / `uid`（Yostar の Token と ID）をサーバーに置いて使う（タスク 007）。サーバーで動かし続けるには、これがどれくらいの期間使えるか、使えなくなったときにどう取り直すかを決める必要がある。タスク 006（回収ツール）と 008（Web サービスの構成）の前提になる。

## 読むべき資料
- `docs/tasks/007-l2-login-investigation.md`（メモ）
- `docs/architecture.md`（雀魂の WebGL 版の通信）
- `docs/local/006-l2-verification-notes.md`（ローカル限定。Yostar の SDK の要点、検証用アカウント）

## 作業範囲
- 日を空けて `local/probe/node-direct.js` を実行し、同じ `code` / `uid` で通り続けるかを記録する（例: 1日後、1週間後）
- 試行の後に一度ブラウザで開き、自動ログインが保たれているかを確かめる（タスク 007 の最後の試行の後は未確認）
- `code` が変わる条件を調べる（ブラウザでログアウトしたとき、別の端末でログインしたとき など）。分かる範囲でよい
- 取り直す方法を決める: 運営がブラウザで一度ログインして取り出す / Node から Yostar のメール認証ログインを行う、など
- 生の通信は観察のたびに保存する（`docs/decisions.md` 2026-11-16）。サーバーへの試行の回数がかさむ場合はユーザーに確認する

## 完了条件
- 認証情報の扱い（保管場所、取り直しの手順と頻度）が決まり、`docs/decisions.md` に書かれている

## メモ
### 2026-11-16 1日目: 仕組みの調査と暫定方針
- Node でのログインに成功した後も、ブラウザは操作なしで自動ログインでき、`code` / `uid` は変わっていなかった（007 の未確認を解消）
- 計測用に `local/probe/check-cred.js` を作った。Node で `oauth2Login` まで送って閉じ、結果を `local/probe/cred-lifetime.log` に1行追記する（1回の実行で `oauth2Auth` は1回。再試行しない）。初回は通った
- Yostar の SDK を手元で読んで分かったこと
  - ブラウザの自動ログインは、保存した UID・Token で `/user/quick-login` を呼ぶ。Geetest（CAPTCHA）が出ることがある
  - ログアウトは手元の保存を消すだけで、サーバーの API は呼ばない。Token がサーバー側で無効になるかは未検証
  - ログイン端末の一覧と削除（`/user/device-list`・`/user/remove-device`）がある。Token は端末ごとと見られる
  - Yostar の API が `100401`（NOT_LOGIN）・`100403`（LOGIN_EXPIRED）を返すと、SDK は手元のアカウントを消してログインし直させる。期限切れはありうる
  - メール認証ログインは `/yostar/send-code`（CAPTCHA の結果が要る）→ `/yostar/get-auth` → `/user/login`。Node だけでの取り直しは CAPTCHA が壁になる
- 暫定方針（`docs/decisions.md` 2026-11-16）: 秘密ファイルに保管。取り直しは運営がブラウザでログインして取り出す。ユーザーセンターで端末を削除しない
- 具体（時刻・ハッシュ）は `docs/local/006-l2-verification-notes.md`

### 2026-11-19 3日目: 1日後の計測と取り出し手順の修正
- 1日後の計測（11/17、cron で実行）は通った。同じ `code` / `uid` で `oauth2Login` まで進んだ（取得から約1.2日）
- 取り出し（`login-observe.js` の `SAVE_SECRET=1`）を直した。サーバーへの試行はしていない
  - 保存を上書きからマージに変え、端末 ID が消えないようにした
  - 端末 ID も自動で取り出すようにした（Yostar の SDK が IndexedDB に置く値。保存場所は SDK を読んで確認）
  - ネットワークなしで確かめられる部分（マージ、権限600）はダミーで確認した。IndexedDB からの読み出しは、次にブラウザを開くときに確かめる
- 具体は `docs/local/006-l2-verification-notes.md`

### 残り
- 計測: `node check-cred.js liqi.json` を 11/17（1日後）と 11/23（1週間後）に1回ずつ実行する。失敗したら、err の値を記録し、ブラウザで自動ログインできるかを確かめる
  - 11/17 は通った。残りは 11/23
  - WSL の cron で自動実行している（毎時7分に `local/probe/scheduled-check.sh`。予定時刻を過ぎて未計測なら1回だけ実行。WSL が止まっていた回は次の起動時に実行）。結果は `cred-lifetime.log`、実行の記録は `scheduled-check.log`
  - 計測が済んだら `crontab -e` で該当行（`# JantamaRanking task 009`）を消す
- 1週間後の計測の後、ユーザーに確認してから、ログアウトや別端末ログインで `code` が変わるかを試す（試すと計測がやり直しになるので最後に回す）
- 取り出しの手順: 今は `SAVE_SECRET=1 node login-observe.js liqi.json <ラベル>` でブラウザを開き、自動ログイン（出なければ手でログイン）すると、`code` / `uid` / 端末 ID が秘密ファイルに保存される（11/19 に修正済み）。次にブラウザを開くとき（11/23 の計測の後）に端末 ID の読み出しを実地で確かめる。運営向けの形にして回収ツールに組み込むかは 006 で決める
- 計測の結果で取り直しの頻度を決め、`docs/decisions.md` の暫定を確定させる
