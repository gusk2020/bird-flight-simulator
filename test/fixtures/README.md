# test fixture: KFM region sample

`kfm-region-sample-kanto-1900.json` is an unmodified copy of `docs/data/region-sample-kanto-1900.json`
from `gusk2020/kudo-fudo-miseisen`, branch `claude/s43-overhaul` (commit 7bae6c18b426). It is a 41x41-cell (5 km),
200 km square around Tokyo in game-year 1900, about 75 KB, produced by that game's `exportRegion`.

It is used only by unit tests. It is not served by the app or included in the build (`public/` is not used).
Its own `licence` field is the authority and is shown on screen when the file is loaded:
terrain from GEBCO_2026 (GEBCO Compilation Group; attribution required), outlines/cities from Natural Earth
(public domain), town names from 国土数値情報 N03 (PDL1.0). The places and roads in it are the game's fictional
history, not real data of that year.
