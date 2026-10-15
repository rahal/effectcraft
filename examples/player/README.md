# Player samples

A script-built news template: `news-short.jsx` reads `props.json` from its folder and builds the comp `news-short` (1080×1920). Texts are invented samples; `media.jpg` is a generated gradient (the Essential Graphics media control). No voice or music.

| Folder | Files |
|---|---|
| `news-short/` | `news-short.jsx`, `props-fr.json`, `props-ar.json` (RTL), `media.jpg` |
| `assets/` | the Cairo fonts, downloaded by `prepare.sh` (not in git) |

## Prepare

The fonts and the built projects are not in the repository; `prepare.sh` makes them:

```sh
examples/player/prepare.sh          # fonts + news-short/news-short.ecproj (from props-fr.json)
examples/player/prepare.sh ar       # the project from props-ar.json
examples/player/prepare.sh --fonts  # fonts only (enough for the player demo)
```

- **Fonts:** `assets/Cairo-SemiBold.ttf`, `Cairo-Bold.ttf`, `Cairo-Black.ttf`, the static instances Google Fonts serves (the scripts select them by these PostScript names), and `assets/Cairo-OFL.txt`. Cairo: The Cairo Project Authors, https://github.com/Gue3bara/Cairo, SIL Open Font License 1.1. Files already there are kept.
- **Project:** the `.jsx` run by `effectcraft-cli` on an empty project in its folder, with `EFFECTCRAFT_FONT_DIRS=assets`. The CLI is built with cargo (release), or set `EFFECTCRAFT_CLI=/path/to/effectcraft-cli`. The built project is overwritten.

Both outputs are gitignored.

## Try it

Player demo (`docs/player.md`): run `prepare.sh --fonts`, then `cargo xtask player --serve 8766` and open http://127.0.0.1:8766/?example=news-short&lang=ar (or `lang=fr`). Or pick the files on the page: the `.jsx`, one `props-*.json`, `media.jpg` and the fonts, or a built `.ecproj` with its files.

Desktop / CLI, after `prepare.sh`:

```sh
cd examples/player/news-short
EFFECTCRAFT_FONT_DIRS=../assets effectcraft-cli render-frame --project news-short.ecproj --comp news-short --time 3 --out f.png
```
