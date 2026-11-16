# H9: Pixel 7a の Chrome で試遊する(専用公開先の準備と手順)

> **状態(2026/11/16 JST)**: 準備は済んだが、**公開はまだ。** 試遊専用リポジトリが無いため、URL はまだありません(この文書に書いてある URL はありません)。
> 理由と、ユーザーが一度だけ行う操作は §2。実機の操作感は**未確認**。

## 1. 仕組み(トークン・Secrets・force-push が要らない)
- 元のゲーム(gusk2020/bird-flight-simulator)の main と既存の Pages は**変更しない**。Pages は 1 リポジトリに 1 サイトなので、別の URL には**別のリポジトリ**が要る。
- 試遊専用リポジトリに、`docs/h9-playtest-site/deploy-h9-playtest.yml` を `.github/workflows/` として置く。これが、公開リポジトリ gusk2020/bird-flight-simulator のブランチ `claude/h9-slow-cruise-ui` を**トークンなしで**取得し、ビルドして、**そのリポジトリの Pages だけに**標準のデプロイ(`actions/deploy-pages`)で公開する。force-push・履歴の書き換えはしない。
- 既存の `playtest-publish.yml`(別リポジトリの gh-pages へ force push、PAT と変数が必要)は、**使わない**。
- 公開前の自動確認(ワークフロー内): H9 のソースか(`src/cruise.ts`・`src/guide.ts`・`docs/H9_HANDOVER.md` がある)、`index.html` のアセット参照がすべて相対パスか(サブパスで白画面にならない)。公開物に `build-info.json`(元のブランチ・SHA・ビルド時刻・実行へのリンク)を保存する。

## 2. ユーザーが行う操作(Android・合計 約 3 分)
1. GitHub アプリ(または Chrome で github.com)で **新しいリポジトリ**を作る: 名前 `vind-ving-playtest`、**Public**、「Add a README file」にチェック。→ 作ったら Claude に「作った」と伝える。
   (Claude は今のセッションの権限で新しいリポジトリを作れない: 権限の範囲が、追加済みのリポジトリだけ。)
2. Claude が、そのリポジトリにワークフローと README を**通常の push** で入れる(ユーザー操作なし)。
3. そのリポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする(1 回だけ)。
4. **Actions → deploy-h9-playtest → Run workflow**(ブランチは既定のまま)。緑になるまで 2〜3 分。(Claude が起動できる場合は、ここも不要。)
5. Pixel 7a の Chrome で `https://gusk2020.github.io/vind-ving-playtest/build-info.json` を開き、`source_ref` が `claude/h9-slow-cruise-ui`、`source_sha` が Claude の報告と一致することを確かめる。
6. `https://gusk2020.github.io/vind-ving-playtest/` を開いて遊ぶ。

## 3. 試遊で見てほしいこと(すべて実機未確認)
1. 起動 3 画面(① 環境設定 → ② 操作UI設定 → ③ 開始: 「設定に戻る」「オート」「自分で操作」)。縦・横どちらでも操作できるか。
2. 低速巡航(手を離すと約 5 m/s)と、羽ばたきの連続での加速(約 17 m/s まで)、連打をやめると戻る感じ。
3. ◎の位置: 設定のプレビューでドラッグして動かせるか。縦横で別に保存されるか。「初期位置」に戻せるか。
4. 着地点マーカー: 青(離れていて近づく対象)と緑(その場で自動着地を始められる)の見分け、実線/破線。タップして着地が始まるか、「降りられません」と出るか。
5. 飛行ガイド(非表示・計器・HUD): 標高・地上高・方位・ピッチ/ロール・対地/対気速度が読めるか。視界の邪魔にならないか。
6. 近接◎(下のリング)での旋回・微速前進と、◯のタップ着地。
7. **縦画面で、上部のボタン列と速度・高度の文字が重なって見えないか**(ソフトウェア描画の画面での確認では重なって見えた。実機では未確認)。
- 低 FPS での安全性(タップの取りこぼしなど)は、自動テストでは実機の代替にならない。体感した不具合は、操作と症状だけで構わないので伝えてください。

## 4. 再配布(更新)の手順
- ブランチに新しい commit が入ったら、試遊専用リポジトリの Actions → `deploy-h9-playtest` → Run workflow。`build-info.json` の `source_sha` が最新の HEAD か確認する。
- 古い版を案内しない: 試遊を案内するときは、必ず `build-info.json` の `source_sha` を添える。
- 別のブランチを試すときは、ワークフローの入力 `ref` を変える(H9 のソースでない場合、ワークフローは止まる)。

## 5. 自動確認の範囲(この PR で実施済み。実機の代替ではない)
- `node tools/verify_subpath.mjs dist /vind-ving-playtest/`: サブパス配下に dist を置いた模擬の配信で、アセット参照が相対パス・全アセット取得・Pixel 7a 相当(412×915、タッチ)の縦画面で起動・ページエラー 0・H9 の 5 機能の存在・「自分で操作」で開始して低速巡航の係数 0.5。絶対パスのビルドでは失敗することを確認済み。
- 実在の URL に対する確認(HTTP 取得・実機での起動)は、公開後に行う(§2 の 5〜6)。
