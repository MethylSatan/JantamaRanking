# 牌譜回収の CLI（手元で試す）

Web サービスができるまでの間、または動作を確かめるときに、手元から主催者の友人戦を回収する手順。部品の構成は `docs/architecture.md`「牌譜回収（タスク 006）」。

## 準備（初回だけ）
状態はすべて `local/collector/`（gitignore 済み）に置く。場所は環境変数 `COLLECTOR_DIR` で変えられる。

| ファイル | 中身 | 作り方 |
|---|---|---|
| `secret.json` | システム用の雀魂アカウントの認証情報 `{ "type": 21, "code": "…", "uid": "…" }` | ブラウザで取り出した値を写す（取り出し方は `docs/local/006-collector-notes.md`） |
| `lua-key.txt` | liqi の定義の鍵（1行） | 公開リポジトリには置かない（`docs/local/017-liqi-notes.md`） |
| `host.json` | 主催者の内部 ID `{ "accountId": … }` | 任意。あれば `candidates` で ID を省ける |

どれも権限 600 にする。`client-version.json`・`liqi.json`（雀魂のバージョンと定義）は、無ければ自動で作る。

## 使い方
リポジトリ直下で実行する。同時には実行できない（`run.lock`）。

```
node src/collector/cli.ts candidates            # host.json の主催者の候補を出す（ログイン1回、一覧2回）
node src/collector/cli.ts candidates <表示用ID>  # 表示用 ID で指定する（検索が1回増える）
node src/collector/cli.ts fetch 1 2 5            # 直前の候補の番号（または uuid）の牌譜を取る
node src/collector/cli.ts exclude 3 4            # 対象外にする（雀魂には接続しない）
node src/collector/cli.ts update-static          # 雀魂のバージョンと定義を作り直す（ログインしない）
```

- `fetch` で取った牌譜は `out/<uuid>.json` に保存し、`records.json` に取り込み済みとして記録する。取り込み済みと対象外は、次の `candidates` に出ない
- 候補が四麻・三麻それぞれ40件以上になると警告が出る。雀魂は最新50件しか返さないので、それより古い対局は取れなくなる
- ログインが `err=151` で失敗したら、雀魂のバージョンと定義を自動で取り直し、1回だけやり直す。それでも失敗したら `[通知]` が出て止まる。認証情報の期限切れなら、取り直す（タスク 009）
- `[通知] liqi の定義で、使っている型が変わった` が出たら、新しい定義は採用されていない。内容を見て、コードを直すかを決める
