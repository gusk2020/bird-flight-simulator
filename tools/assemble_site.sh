#!/usr/bin/env bash
# GitHub Pages に載せるサイト(1 つのアーティファクト)を組み立てる: ルート / = 正式版(main のビルド)、/h9/ = 試遊版(H9 のビルド)。
#   tools/assemble_site.sh <main の dist> <H9 の dist | none> <出力先> [H9 の ref] [H9 の SHA] [main の SHA] [実行の URL]
# 守ること: ルートは main のビルドそのまま(1 バイトも変えない。最後に diff で確かめる)。h9/ は新しく足すだけ。ビルド情報は h9/build-info.json にだけ置く(ルートに新しいファイルを足さない)。
# H9 が none のときは、正式版だけのサイトを組み立てる(今までの pages.yml と同じ内容)。
set -euo pipefail
MAIN="${1:?main dist}"; H9="${2:?h9 dist or none}"; OUT="${3:?out dir}"; REF="${4:-}"; H9SHA="${5:-}"; MAINSHA="${6:-}"; RUN="${7:-}"
[ -f "$MAIN/index.html" ] || { echo "main の dist に index.html がありません。組み立てません。"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"; cp -a "$MAIN"/. "$OUT"/
if [ "$H9" != "none" ]; then
  [ -f "$H9/index.html" ] || { echo "H9 の dist に index.html がありません。"; exit 1; }
  [ ! -e "$OUT/h9" ] || { echo "main のビルドに h9 がすでにあります。衝突するので止めます。"; exit 1; }
  if grep -Eo '(src|href)="/[^"]*"' "$H9/index.html"; then echo "H9 の index.html に絶対パスの参照があります。/h9/ 配下では白画面になります。"; exit 1; fi
  mkdir "$OUT/h9"; cp -a "$H9"/. "$OUT/h9/"
  printf '{\n "game": "Vind Ving",\n "stage": "H9 playtest (served at /h9/)",\n "h9_source_repo": "gusk2020/bird-flight-simulator",\n "h9_source_ref": "%s",\n "h9_source_sha": "%s",\n "root_source": "main",\n "root_source_sha": "%s",\n "built_at_utc": "%s",\n "workflow_run": "%s"\n}\n' \
    "$REF" "$H9SHA" "$MAINSHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUN" > "$OUT/h9/build-info.json"
fi
# ルートが main のビルドと完全に同じか(h9/ を除いて、ファイルの内容・一覧が一致するか)
if diff -rq "$MAIN" "$OUT" --exclude=h9; then echo "root == main build (byte-identical)"; else echo "ルートが main のビルドと一致しません。止めます。"; exit 1; fi
echo "assembled: $(find "$OUT" -type f | wc -l) files"
