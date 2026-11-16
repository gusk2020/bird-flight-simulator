# H9: Pixel 7a の Chrome で試遊する(同じリポジトリの GitHub Pages に /h9/ として載せる)

> **運用方針(ユーザー決定・確定)**: 正式版も試遊版も、**`gusk2020/bird-flight-simulator` の 1 つのリポジトリだけ**で管理する。**別リポジトリの作成・PAT の作成・Cloudflare など外部サービスの追加はしない。**
> 以前の案(試遊専用の別リポジトリ `vind-ving-playtest`、`docs/h9-playtest-site/` のワークフロー、`playtest-publish.yml` の別 repo への force push)は**撤回**した。今後の試遊版(H10 以降)も同じ方式で行う。
>
> **状態(2026/11/16 JST 確認済み)**: **H9 試遊版は公開済み** — `https://gusk2020.github.io/bird-flight-simulator/h9/`(ビルド元 `claude/h9-slow-cruise-ui` の `ca550be`)。正式版(ルート)は現状のまま。詳細は §6。実機(Pixel 7a)の操作感は未確認。

## 1. 仕組み
- GitHub Pages は 1 リポジトリに 1 サイト。デプロイのたびに**サイト全体が入れ替わる**ので、1 回のデプロイで 2 つを一緒に載せる。
  - ルート `https://gusk2020.github.io/bird-flight-simulator/` = **正式版(main のビルド)**。現在公開中のものと**バイト単位で同一**(§4)。
  - `https://gusk2020.github.io/bird-flight-simulator/h9/` = **H9 試遊版**(ブランチ `claude/h9-slow-cruise-ui` のビルド)。
- `.github/workflows/pages.yml`(このブランチの版)が、main と試遊版を**別々にチェックアウト・ビルド**し、`tools/assemble_site.sh` で 1 つのアーティファクトにまとめて、標準の `actions/deploy-pages` で公開する。別リポジトリ・トークン・Secrets・force-push は使わない。
  - **手動実行(workflow_dispatch)**: main をルートに、入力 `playtest_ref` のブランチを `/h9/` に載せる(`none` で正式版だけ)。
  - **main への push**: 正式版だけをデプロイ(今までと同じ)。**このとき /h9/ は消える**(サイト全体が入れ替わるため)。試遊を続けるときは手動実行し直す。
- 組み立ての安全確認(ワークフロー内): H9 のソースか(`src/cruise.ts`・`src/guide.ts`・`docs/H9_HANDOVER.md`)、H9 の `index.html` に絶対パス参照がないか、`/h9/` が main のビルドと衝突しないか、**ルートが main のビルドと完全に一致するか(`diff -rq`)**。どれかが崩れたらデプロイしない。
- 公開物に `h9/build-info.json`(試遊版のブランチ・SHA、ルートの main の SHA、ビルド時刻、実行へのリンク)を保存する。ルートには新しいファイルを足さない。

## 2. 保存データの分離(同じオリジンなので必要)
正式版と試遊版は同じオリジン(gusk2020.github.io)で配られるため、ブラウザの保存領域(localStorage)が共有される。そのままだと、試遊で変えた設定が正式版の保存データに混ざる。
- `src/settings.ts`: **サブパス `/h9/` で動くときだけ**保存キーを `vindving.h9.prefs.v1` にする。ルートは従来の `vindving.prefs.v1` のまま(正式版の保存データには何も起きない)。この判定は、ページのパスが `…/h9/` のときだけ効く。
- 結果として、試遊版は**初回は設定が空**(正式版の設定は引き継がない)。H9 の設定は試遊版にだけ残る。

## 3. 試遊で見てほしいこと(すべて実機未確認)
1. `…/h9/build-info.json` を先に開き、`h9_source_ref` が `claude/h9-slow-cruise-ui`、`h9_source_sha` が Claude の報告と一致することを確かめる(古い版を H9 として遊ばないため)。
2. 起動 3 画面(① 環境設定 → ② 操作UI設定 → ③ 開始: 「設定に戻る」「オート」「自分で操作」)。縦・横どちらでも操作できるか。
3. 低速巡航(手を離すと約 5 m/s)と、羽ばたきの連続での加速(約 17 m/s まで)、連打をやめると戻る感じ。
4. ◎の位置: 設定のプレビューでドラッグして動かせるか。縦横で別に保存されるか。初期位置に戻せるか。
5. 着地点マーカー: 青(離れていて近づく)と緑(その場で自動着地を始められる)の見分け、実線/破線。タップして着地が始まるか、「降りられません」と出るか。
6. 飛行ガイド(非表示・計器・HUD): 標高・地上高・方位・ピッチ/ロール・対地/対気速度が読めるか。視界の邪魔にならないか。
7. 近接◎(下のリング)での旋回・微速前進と、◯のタップ着地。
8. **縦画面で、上部のボタン列と速度・高度の文字が重なって見えないか**(ソフトウェア描画の画面では重なって見えた。実機未確認)。
- 低 FPS での安全性は、自動テストでは実機の代替にならない。体感した不具合は、操作と症状だけで構わないので伝えてください。

## 4. 安全性の根拠(実測)
- **ルートは現状のまま**: 現在公開中のルート(`index.html`・`assets/index-BPCMNOYV.js`)の SHA-256 は、main(c29213a)を手元でビルドしたものと**一致**した。組み立て後のルートも、`diff -rq` で main のビルドと一致する。
- **/h9/ の検証**(`node tools/verify_subpath.mjs <サイト> /bird-flight-simulator/`、Pixel 7a 相当の縦画面・タッチ): ルートと /h9/ の両方で、アセット参照が相対パス・全アセット 200・起動・エラー 0。/h9/ で H9 の 5 機能の存在と、「自分で操作」での開始・低速巡航の係数 0.5。ルートに H9 の機能が混ざっていないこと。
- **保存の分離**: 同じブラウザで、ルートに設定を保存 → /h9/ で別の設定を保存 → ルートの保存が変わらない、を確認。キーを分離しないビルドでは 3 項目が失敗する(検証が実際に検出できる)。
- 単体テスト 607 件(保存キーの判定 4 項目を含む)。

## 5. 再配布(更新)の手順(ユーザー・Android)
- GitHub の Actions → **Deploy to GitHub Pages** → Run workflow → ブランチは `claude/h9-slow-cruise-ui`、`playtest_ref` は既定のまま → 緑になるまで 2〜3 分。
- `…/h9/build-info.json` の `h9_source_sha` が最新の HEAD か確認する。試遊を案内するときは、必ず SHA を添える。
- 試遊版だけをやめたいとき: `playtest_ref` を `none` にして実行(正式版だけのサイトに戻る)。

## 6. 公開の実績

### 6.1 公開済み(2026/11/16 16:05〜16:07 JST、確認済み)
- 手動実行: Pages の実行 **43821291687**(ブランチ `claude/h9-slow-cruise-ui`、`playtest_ref` = `claude/h9-slow-cruise-ui`)。build・deploy とも成功。
  - 1 回目(実行 43818242540)は、`github-pages` 環境がブランチからのデプロイを拒否して失敗(サイトは変わらなかった)。ユーザーが環境にブランチのデプロイ許可を足したあと、2 回目で成功。
- **アクセスできた URL**(実在の URL を取得して確認):
  - `https://gusk2020.github.io/bird-flight-simulator/h9/` — HTTP 200(HTML 16,717 バイト)。
  - `https://gusk2020.github.io/bird-flight-simulator/h9/assets/index-D_UOuXCO.js` — HTTP 200(685,504 バイト)。
  - `https://gusk2020.github.io/bird-flight-simulator/h9/build-info.json` — HTTP 200。`h9_source_ref` = `claude/h9-slow-cruise-ui`、**`h9_source_sha` = `ca550bea53e5fc27bc5afece3ee6201abeb95df7`**(ブランチの当時の HEAD と一致)、`root_source_sha` = `c29213a4afe38768a0c25ce7e6d99455ab22eebf`(main)、ビルド時刻 2026-11-16T07:05:38Z。
  - 正式版(ルート): `https://gusk2020.github.io/bird-flight-simulator/` — HTTP 200(11,649 バイト)、`…/assets/index-BPCMNOYV.js` — HTTP 200(673,624 バイト)。
- **正式版が維持されている**: ルートの `index.html`(SHA-256 2afb218a…)と JS(62194f3b…)は、公開前の取得値および main(c29213a)の手元ビルドと**一致**。ルートの JS に H9 の機能(`scale0`、`vindving.h9.prefs.v1`)は含まれない。
- **H9 の配信物が、ブランチのビルドと一致**: `/h9/` の JS(SHA-256 f81e82f2…)と `index.html`(9ba59ae0…)は、`ca550be` を手元でビルドしたものと一致。`/h9/` の JS に `scale0`(5 件)・`canStart`(2 件)・`vindving.h9.prefs.v1`(1 件)がある。
- **CSS**: 外部の CSS ファイルは無い(スタイルは `index.html` に埋め込み、`<style>` 1 つ)。取得する対象の CSS ファイルは存在しない。
- アセット参照は相対パス(絶対パス参照 0 件)で、`/h9/` 配下で解決される。
- **実在の URL をブラウザ(Chromium、Pixel 7a 相当 412×915・タッチ・縦画面)で開いて確認**: `/h9/` は起動し、ページエラー 0、失敗した読み込み 0、起動 3 画面(DOM)・飛行ガイド 3 択・低速巡航(`CRUISE` 有効、係数 0.5)を確認。ルートは起動し、エラー 0、H9 の機能は混ざっていない(正式版のまま)。
- **保存データの分離(実在のサイトで確認)**: 同じブラウザで、ルートで設定を保存 → `/h9/` で飛行ガイド=HUD を保存 → `/h9/` の保存は `vindving.h9.prefs.v1` に入り、ルートの `vindving.prefs.v1` は変わらない(開き直しても不変)。

### 6.2 注意(更新・消える条件)
- **このブランチへ push しても `/h9/` は更新されない**。手動実行し直す(§5)。公開中のものは `ca550be` のビルド。
- **main への push(= 正式版だけのデプロイ)で `/h9/` は消える。** 試遊を続けるときは、手動実行し直す。
- 環境の保護ルールに足されたブランチ(`claude/h9-slow-cruise-ui`)以外のブランチは、デプロイできない。

### 6.3 未確認
- **Pixel 7a 実機の操作感・低 FPS 安全性は未確認**(上の確認は、ソフトウェア描画のヘッドレス Chromium)。縦画面で上部のボタン列と文字が重なって見えるかは実機で未確認。
