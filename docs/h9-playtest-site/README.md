# Vind Ving H9 試遊サイト(試遊専用リポジトリ)

このリポジトリは、**Vind Ving の H9 版を Pixel 7a などのスマホで試遊するためだけ**の公開先です。中身はワークフロー 1 つで、ゲームのソースは入っていません
(ソースは gusk2020/bird-flight-simulator。このリポジトリのワークフローが、そのブランチを取得してビルドし、このリポジトリの GitHub Pages に公開します)。

- 公開される URL: `https://gusk2020.github.io/<このリポジトリ名>/`(最初のデプロイ後に Pages が反映するまで数分)
- どの版か: `https://gusk2020.github.io/<このリポジトリ名>/build-info.json` に、元のブランチと SHA が出ます。**H9 を試すときは、ここを先に開いて確かめてください。**
- 更新: Actions → `deploy-h9-playtest` → Run workflow(ブランチ名は既定のまま)。
- 元のゲームの main・既存の公開サイト・セーブデータには触れません(別リポジトリ・別 URL・ブラウザの保存領域もオリジンが別)。
