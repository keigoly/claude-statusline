# 開発ノート

使い方は [README.md](./README.md) を参照。ここには**なぜその実装になっているか**を残す。

## 構成

| ファイル | 役割 |
| --- | --- |
| `statusline.cjs` | 本体。Claude Code が各描画で **stdin に JSON** を渡して実行し、**標準出力がそのままステータス行**になる。git を 1 回叩く以外は I/O をローカルファイルに限る |
| `usage-fetch.cjs` | 背景フェッチャ。ネットワークへ出るのはこのプロセスだけ。結果をキャッシュへ atomic に書く |

キャッシュは `~/.claude/statusline-usage-cache.json`。

## 設計の前提: 描画はブロックしてはいけない

statusline はアクティブ時に毎秒数回実行される。1 回の描画で数百 ms かかると入力が引っかかるため、
**本体は同期 I/O をローカルファイル読みに限り、ネットワークには一切触れない**。

外部から取る必要のある値は、すべて次の形にそろえてある。

1. 本体はキャッシュを**読むだけ**
2. キャッシュが TTL 超過なら、本体が**detached でフェッチャを spawn**（`.unref()` / `stdio:'ignore'`）
3. フェッチャが書き終えた**次の描画**から新しい値が出る

多重起動はロックファイル（90 秒）で防ぐ。取得に失敗しても既存キャッシュは壊さない。

## 調査で分かった Claude Code 側の仕様

いずれも実バイナリと実機の描画で確認したもの。**公式に保証された挙動ではない**。

### stdin にはモデル別週間枠もプラン種別も載らない

statusline へ渡る `rate_limits` は `five_hour` と `seven_day` の 2 つだけ。本体が HTTP レスポンス
ヘッダーの `anthropic-ratelimit-unified-*` から組み立てているため、出力キーは最大 4 種にしかならず、
モデル別の週間枠は構造上載らない。プラン種別も同様に含まれない。

→ 背景フェッチャが Claude Code 自身の使う usage エンドポイントを叩いて補完する。認証は Keychain の
OAuth トークンを読むだけで、リフレッシュは本体に任せる（期限切れなら次回描画で再取得される）。
**非公開の経路なので本体更新で壊れうる**が、壊れても fail-open で他の表示は出続ける。

### 再描画には上限がある

アイドル時は約 1fps（`refreshInterval` は整数秒のみで小数不可）、アクティブ時も約 3fps
（300ms デバウンス）。Claude Code はスクリプトの出力を 1 枚のスナップショットとして行に貼る方式で、
描画ループへは触れられない。**滑らかなアニメーションは構造的に不可能**。

→ 動かすと必ず「1 秒ずつ」カクつくため、モデル名の装飾は**静的グラデーション**を採用している。

### effort の一部は statusline から区別できない

最上位の effort 指定は、stdin にも環境変数にも通常の最高値と同じ値でしか現れない。

## 配色

| 対象 | 色 |
| --- | --- |
| アイコン | オレンジ `#FF6A00`（truecolor）で統一 |
| モデル名 | 主要モデルごとに `sheen(base, shine)` で中央がふわっと光る左右対称の静的グラデ。それ以外は teal 単色 |
| effort | low=白 / medium=青 / high=緑 / xhigh=赤 / max=金 |
| 使用率バー・％ | 0-30%=緑 / 31-60%=黄 / 61-90%=赤 / 91%+=紫（`barColor()`） |
| プラン種別 | 金 |
| 外注先モデル名 | 藤色 `#A78BFA`。**自前モデルの sheen とは意図的に別系統**にして「外部へ出ている」ことを一目で分かるようにしている |
| OpenRouter 残額 | `barColor()` と同一規則。残りが減る＝使用率が上がる、と読み替える |

## 外注経路の読み取り (`readRoute()`)

- ファイル**末尾 64KB だけ**を `openSync` + `readSync` で読む。ログが肥大しても読み込み量は一定
- 先頭行は途中で切れているため捨てる
- `JSON.parse` の前に `indexOf('"openrouter"')` で粗フィルタ。実測 0.110ms/回
- 後方から走査し、**最初に見つかった 1 件**が窓外なら何も出さずに打ち切る（さらに古い行は見ない）
- ファイル名は JST 日付。日跨ぎ直後に取りこぼさないよう前日ファイルも見る（`[0, -1]` の 2 日分）。
  `jstDateStr()` は UTC から固定オフセットで計算するため、**マシンの TZ 設定に依存しない**

## 残額の算出

上限が 2 系統あり、**先に枯れる方**が実際の制約になるため `min` を採る。採用した側の総額を `base` として
一緒に保存し、`100 - remaining / base * 100` を使用率とみなして着色する。どちらが採用されたかは
`source` に残る。

Anthropic 側と OpenRouter 側は**独立に取得**する。片方が落ちても、もう片方が取れていれば
キャッシュへ載せる。これにより片方の障害でもう片方の表示が消えることはない。

## 主ツリーの運用違反表示 (2 行目)

「主ツリーは常に既定ブランチ (main)」「linked worktree は既定ブランチを掴まない」という運用の**違反だけ**を
赤＋警告記号で出す。正常時の見た目は従来どおり (緑のブランチ名)。

- `主ツリー≠main` … 主ツリー (`.git` が実ディレクトリのツリー) が既定ブランチ以外にいる。cmux の全ワークスペース・
  仕事用アカウント・launchd が同じ状態を見ている
- `worktree が main を保持` … linked worktree (`.git` が `gitdir:` を書いたファイル) が既定ブランチにいる。
  主ツリーは既定ブランチへ戻れなくなっている

2026-09-02、主ツリーが 10 日間 feat ブランチのままだったが、ブランチ名を正しく出していただけでは異常が正常に
見えて誰も気づかなかった。**正しい表示と、異常が伝わる表示は別物。**

判定は **git を叩かず fs だけ**で行う (`treeRole()`)。描画は毎秒数回走るので git 起動を増やさない
(実測: 変更前後で差なし)。既定ブランチは `refs/remotes/origin/HEAD` → `main` → `master` の順
(packed-refs も見る)。判定できなければ従来表示 (fail-open)。

同時に `C.red` を定義した。以前から `NAI 停止` が `C.red` を参照していたが未定義で、`undefined` の文字列が
そのまま出ていた。

## 変更手順

1. **見える化**: 変更前にモック描画で現状を把握する。色は `sed 's/\x1b\[[0-9;]*m//g'` で除去すると構造だけ確認できる
2. **最小改修**: 該当の定義・関数のみ変更する。関係ない箇所は触らない
3. **整合性確認**: 実端末で表示を確認する。異常系（キャッシュ不在・ディレクトリ不在・旧形式キャッシュ）も必ず通す

## テスト

```sh
# 基本
echo '{"model":{"display_name":"Opus 5"},"effort":{"level":"xhigh"},"workspace":{"current_dir":"/tmp/demo","repo":{"name":"demo"}},"context_window":{"used_percentage":75},"rate_limits":{"five_hour":{"used_percentage":40,"resets_at":0}},"pr":{"number":42}}' | node statusline.cjs

# プラン種別・週間枠・残額まで出す（要 Keychain ログイン + OPENROUTER_API_KEY）
node usage-fetch.cjs && cat ~/.claude/statusline-usage-cache.json

# 外注経路の矢印
D=$(mktemp -d)
python3 -c "import json,datetime;ts=datetime.datetime.now(datetime.timezone.utc).isoformat();\
print(json.dumps({'timestamp':ts,'payload':{'backend':'openrouter','model':'z-ai/glm-5.2','provider':'Novita'}}))" \
  > "$D/events_$(date +%F).jsonl"
echo '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"/tmp/demo"},"context_window":{"used_percentage":38}}' \
  | STATUSLINE_EVENTS_DIR="$D" node statusline.cjs
```

必ず通すパターン: ①外注なし ②窓内に外注あり ③別モデルへの外注 ④窓外（矢印が消える）
⑤除外対象の事業者のみ（矢印が出ない）⑥イベントディレクトリ不在 ⑦`openrouter` を含まない旧キャッシュ。

主ツリーの運用違反表示は、一時リポジトリで次を通す (色は `sed 's/\x1b\[[0-9;]*m//g'` で除去して構造を見る):

```sh
D=$(mktemp -d); git init -q -b main "$D" && git -C "$D" commit -q --allow-empty -m init
git -C "$D" branch feat/x && git -C "$D" worktree add -q "$D-feat" feat/x
r() { printf '{"workspace":{"current_dir":"%s","repo":{"name":"t"}}}' "$1" | node statusline.cjs | sed -n 2p; }
r "$D"                                   # ① 主ツリー main → 緑
git -C "$D" switch -q feat/x 2>/dev/null || { git -C "$D" branch feat/y; git -C "$D" switch -q feat/y; }
r "$D"                                   # ② 主ツリー feat → 赤「主ツリー≠main」
r "$D-feat"                              # ③ worktree feat → 緑
git -C "$D" worktree add -q "$D-main" main
r "$D-main"                              # ④ worktree が main → 赤「worktree が main を保持」
r "$D/sub" 2>/dev/null; r /tmp           # ⑤ サブディレクトリでも判定 / git 外は行ごと消える
```

## 関連

- stdin スキーマ: https://code.claude.com/docs/en/statusline
