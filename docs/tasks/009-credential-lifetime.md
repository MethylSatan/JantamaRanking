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

### 残り
- 計測: `node check-cred.js liqi.json` を 11/17（1日後）と 11/23（1週間後）に1回ずつ実行する。失敗したら、err の値を記録し、ブラウザで自動ログインできるかを確かめる
  - WSL の cron で自動実行している（毎時7分に `local/probe/scheduled-check.sh`。予定時刻を過ぎて未計測なら1回だけ実行。WSL が止まっていた回は次の起動時に実行）。結果は `cred-lifetime.log`、実行の記録は `scheduled-check.log`
  - 計測が済んだら `crontab -e` で該当行（`# JantamaRanking task 009`）を消す
- 1週間後の計測の後、ユーザーに確認してから、ログアウトや別端末ログインで `code` が変わるかを試す（試すと計測がやり直しになるので最後に回す）
- 取り出しの手順を運営向けに用意する（今は `login-observe.js` の `SAVE_SECRET=1`。ただし保存時に端末 ID が消えるので直す）。これは 006 で回収ツールに組み込むかを決める
- 計測の結果で取り直しの頻度を決め、`docs/decisions.md` の暫定を確定させる
