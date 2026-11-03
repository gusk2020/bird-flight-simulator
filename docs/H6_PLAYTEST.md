# H6: GitHub だけで Pixel 7a から試遊する(準備済み・未実行)

**まだ何も公開していません。** リポジトリの作成・Pages の設定・トークンの作成は、あなた(ユーザー)の操作と承認が要ります。
main、いまの公開版(Pages)、セーブデータには触れない作りです。URL は、あなたが設定して初めて決まります(ここに書いてある URL はありません)。

## 仕組み
- `.github/workflows/playtest-publish.yml`(手動実行のみ): 選んだブランチをビルドし、**試遊専用の別リポジトリ**の `gh-pages` ブランチへ送る。
- 送り先が未設定・このリポジトリ自身のときは、何も送らず止まる。
- 試遊専用リポジトリの Pages が公開するので、現在の公開版とは別の URL になる。

## Android(Chrome か GitHub アプリ)でやること(最小・約10分)
1. GitHub で新しいリポジトリを作る(例 `vind-ving-playtest`)。Pages を無料で使うには **Public** が必要。中身はビルド済みのゲームだけで、ソースは入らない。空のままで作成。
2. そのリポジトリで Settings → Pages → Source を「Deploy from a branch」、Branch を `gh-pages` / `(root)` にする(最初の送信のあとで選べるようになる)。
3. GitHub の Settings → Developer settings → Fine-grained tokens で、**試遊専用リポジトリだけ**を選び、権限は Contents: Read and write にしたトークンを作る。
4. この repo(bird-flight-simulator)の Settings → Secrets and variables → Actions で、Secret `PLAYTEST_TOKEN` に上のトークン、Variable `PLAYTEST_REPO` に `gusk2020/vind-ving-playtest`(作ったリポジトリ名)を登録する。
5. この repo の Actions → `playtest-publish` → Run workflow → ブランチ `claude/h6-tap` で実行。
6. 数分後、`https://gusk2020.github.io/<試遊専用リポジトリ名>/` を Pixel 7a で開く(最初のみ Pages の反映に数分かかる)。

やらなくてよい場合: 手順 1〜4 のうち、あなたが承認するまで私は何も作りません。
もっと手軽な代替: `playtest-build`(Actions の artifact)はスマホでは遊べません。Codespaces のポート共有は一時的な URL で遊べますが、利用枠を使います。

## 試遊前に自動で確かめたこと
unit(482件)・sim・build・実タッチを含む browser 試験(g1〜g13)・360分相当の endurance。実機ではありません。

## Pixel 7a で試すこと(すべて実機未確認)
1. ◯を押す: 画面のどこに出ても(縁を含む)、押したら着地が始まる、または「安全に降りられません」と出る。無反応にならない。
2. 風あり(既定)で、看板・電柱への自動着地。外したら1回だけ回り込んでやり直す。
3. 片手(右/左)の上下◎、急制動・旋回・微速前進、離陸、歩行、休息、羽づくろい、水浴び、オート周遊。
4. 道路・草地・水たまりが点滅しない(昼・夕・夜・天気の変わり目)。
