# 016 雀魂のバージョンへの追従

状態: done / 依存: 011

## 目的
Node から雀魂にログインするときは、雀魂のバージョン（`client_version_string`、`client_version.resource`）を送る。雀魂が更新されると古いバージョンは `err=151` で拒否される（`docs/decisions.md` 2026-11-19 タスク 011）。Web サービス（Lambda）はブラウザを開けないので、ブラウザなしで今のバージョンを得て、定期取得が止まらないようにする。

## 読むべき資料
- `docs/architecture.md`（雀魂の WebGL 版の通信）
- `docs/tasks/011-lambda-majsoul-connectivity.md`（メモ）

## 作業範囲
- 今のバージョンをブラウザなしで得る方法を調べる。第一候補は `version.json`（liqi の定義を取るときの入口。WebGL 版の `0.16.x` と同じ値かは未確認）。他に、ゲームの起動時に読む設定ファイルなど
- 調べるときは、まずブラウザの通信の記録（`local/probe/` のログ、キャッシュ）から探し、サーバーへの試行を増やさない
- バージョンと一緒に liqi の定義も変わりうる。定義の更新をどう追うかもあわせて考える
- 得たバージョンを Lambda でどう使うか（毎回取る、`err=151` のときだけ取り直す、など）を決める

## 完了条件
- 雀魂のバージョンの得方と使い方が決まり、`docs/decisions.md` と `docs/architecture.md` に書かれている

## メモ
- 手元の検証用の暫定: `login-observe.js` がゲームの送ったバージョンを `local/probe/client-version.json` に保存し、`check-cred.js`・`node-direct.js` はそこから読む。`err=151` が出たら `cred-refresh.sh` でブラウザを1回開けば直る

### 2026-11-19 ブラウザなしで得る方法が分かった
- まず手元の記録を探した。ブラウザのキャッシュ（Service Worker の CacheStorage）に、Unity のデータファイル `u6v_td1bd8bb002s_<ハッシュ>` があり、中に `{"version":"0.16.287","platform":"WebGL"}` が入っていた（11/16 のものは `0.16.280`）。起動時に読む `jp-release.json` 2つ・`bundle_hash.txt`・`bundle_info_so.majset` は、本文がキャッシュに残っていなかった
- ユーザーの許可を得て、公開の静的ファイルを取った（ログインはしていない。要求は合計9回、間は2秒）。`jp-release.json` 2つは配信元の URL とパスの設定だけだった。`bundle_info_so.majset` を展開すると、データファイルの今の名前があった
- 手順は `docs/architecture.md`（雀魂の WebGL 版の通信）。`local/probe/fetch-client-version.js`（Node だけ、依存なし）で、ブラウザが送った3つの値と一致することを確かめた
- `version.json` は旧クライアントの系列（`0.11.x`）なので使わない
- 使い方はユーザーと決めた: 前回の値を保存し、`err=151` のときだけ取り直す（`docs/decisions.md` 2026-11-19 タスク 016）
- liqi の定義の追い方は今回は決めず、タスク 017 に起票した
- 未確認: `WebGL_2022-` の出どころ、`bundle_hash.txt` が何のハッシュか、データファイルに入っていたもう1つの JSON `{"version": "0.11.603"}` が何か
