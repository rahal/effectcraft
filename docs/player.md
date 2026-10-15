# EffectCraft player (browser, no editor UI)

`apps/effectcraft-player` plays an EffectCraft project in a web page: a `<canvas>` with the
project's frames, Web Audio in sync, and a small JavaScript API to change it (Essential Graphics
controls, any engine command, a template script with its props). It is the engine of
[`effectcraft-web`](web.md) without egui/eframe: an app that previews templates (a video
editor, a template gallery) embeds it the way it would embed a video player.

```sh
cargo xtask player                 # release build (fastest frames, --opt 3) → <target>/player/dist
cargo xtask player --opt z         # smallest module, slower frames (0|1|2|3|s|z: rustc and wasm-opt level)
cargo xtask player --dev           # unoptimised (faster to compile, slow to run)
cargo xtask player --serve 8766    # build, then serve dist (with COOP/COEP) on http://127.0.0.1:8766/
cargo xtask player --split 20      # the module in parts of ≤ 20 MiB (default: only when over 25 MiB, below)
```

Release builds use the cargo profile `wasm-player` (release, fat LTO, `opt-level = 3`); `--opt`
overrides its level and picks the matching wasm-opt pass (`-O3`, `-Oz`…). The frames render on
the viewer's CPU, so the default favours speed: `z` makes the module ⅓ smaller and frames
≈ 30 % slower.

Same tools as the web app ([web.md](web.md): the `wasm32-unknown-unknown` target, the
`wasm-bindgen` CLI at exactly 0.2.129, optional `wasm-opt`). `dist` holds `player.js` (the API),
`worker.js` (frame workers), `effectcraft_player.js` + `effectcraft_player_bg.wasm` (the
wasm-bindgen glue and module) and `index.html` (a demo: pick a `.ecproj`, or a `.jsx` with its
`props.json`, footage and fonts; the controls are generated from the comp's Essential Graphics).

**Module copies.** `effectcraft_player_bg.json` lists the copies of the module that
`cargo xtask player` writes, and `player.js` loads the first one that works
(`player.stats.wasm` says which):

1. `effectcraft_player_bg.wasm.br` (Brotli, ≈ 7.4 MB), where the browser's
   `DecompressionStream` reads Brotli;
2. `effectcraft_player_bg.wasm.gz` (gzip, ≈ 11.6 MB; every current browser);
3. the parts of a split module, else `effectcraft_player_bg.wasm`.

The compressed copies are decompressed in the page while they download, streamed into
`WebAssembly.compileStreaming`. Static hosts don't serve pre-compressed files as such (no
`Content-Encoding`), so this works on any of them, and hosts that don't compress at all download
a quarter of the bytes. They are made with the `brotli` and `gzip` tools when installed
(`brew install brotli`), and skipped otherwise. A copy that fails to load is reported in the
console and the next one is tried.

**Split module.** Static hosts limit the size of one file (Cloudflare Pages: 25 MiB). When the
module is larger (the default `--opt 3`: ≈ 33 MB), `cargo xtask player` also writes it in parts
of at most 20 MiB, `effectcraft_player_bg.0.wasm`, `.1.wasm`… (still `.wasm`: hosts serve them
as `application/wasm` and compress them). `player.js` fetches the parts in parallel and streams
them, in order, into one `WebAssembly.compileStreaming`. `--split MIB` sets the part size;
`--split 0` writes the single file.

## API

```js
import { EffectcraftPlayer } from "./player.js";

const player = await EffectcraftPlayer.create({ canvas, workers: 2, gpu: true });
const info = await player.load({
  project: "template.ecproj",                 // URL, Blob, Uint8Array or ArrayBuffer
  files: { "/Users/me/footage/bg.jpg": file, "Cairo-Bold.ttf": fontUrl },  // under the paths the project names
  comp: "news-short",                         // default: the active, else the first comp
});
// info: {comps, comp, name, width, height, fps, duration, controls}

await player.set("headline", "Hello");        // Essential Graphics control (groups such as `Réglages` included)
await player.set("accent", [0.9, 0.2, 0.3]);  // colour; numbers, booleans, 1-based dropdown index
await player.set("media", fileFromInput);     // a media control: the footage is replaced
await player.execute("prop.set", { comp: "news-short", layer: "headline", path: "text/sourceText", value: "…" });

await player.seek(2.5);                       // draws the frame at 2.5 s
await player.play();                          // from a user gesture (audio); pause(), currentTime, duration, paused
player.addEventListener("timeupdate", (e) => e.detail.time);  // also ready, frame, play, pause, ended, error
const f = await player.renderFrame(1, 1);     // {width, height, rgba (premultiplied), ms, gpu}
player.destroy();
```

| Call | |
|---|---|
| `EffectcraftPlayer.create({canvas, workers = 2, gpu = true, scale, backend = "auto", base})` | compiles the module once (shared with the workers) and starts the frame workers. `scale`: render scale (default: the canvas's displayed width × `devicePixelRatio` over the comp's); `backend` for workers with a GPU: `auto` (CPU or GPU per comp, by measured frame time), `gpu`, `cpu`; `base`: where `worker.js` and the `.wasm` are (default: next to `player.js`) |
| `load({project, files, comp})` | open a project (`.ecproj` JSON); its footage must be in `files` under the paths it names (or be replaced afterwards) |
| `load({script, props, files, comp})` / `runScript(script, props, files)` | build the project with an ExtendScript template on an empty project (`script`: the `.jsx` text or its URL); `props` (object or JSON text) is readable as `props.json`, `files` under their names (`new File("media.jpg")`); `info.output` has its `writeLn` lines |
| `addFiles({path: source})` | add or replace files (a replaced file goes to the workers again) |
| `set(name, value)` | an Essential Graphics control of the comp, by name: property controls take their value, media controls a `Blob`/`File`/bytes (or a path already added) |
| `execute(command, params)` | any engine command, as in `effectcraft-cli exec` / MCP (`commands` lists them); results are the command's |
| `seek(t)` | render and draw the frame at `t` (seconds; snapped to the comp's frame grid); seeks during a render coalesce (only the latest renders) |
| `play()` / `pause()` | playback; the clock is the AudioContext's (`currentTime − outputLatency`) when the comp has audio, else `performance.now()` |
| `renderFrame(t, scale)` | one frame without drawing it |
| `volume` (0–1), `muted` | the output gain (`volumechange` event); the clock and the mix are unchanged |
| `info`, `duration`, `fps`, `currentTime`, `paused`, `stats` | `stats`: `{frames, lastMs, dropped, local, workers: [{gpu}|{cpu}], loadMs, mixMs}` |

`<effectcraft-player src="template.ecproj" comp="main" workers="2">` (defined by importing
`player.js`) wraps the same in a custom element: a canvas that plays on click; `element.ready`
resolves with `element.player`, and the player's events are re-dispatched on the element.

Footage handed over as `blob:` URLs (files the user picked, not uploaded yet) works like any
URL: the player fetches the bytes once into its file table.

## How it works

One wasm module, two roles:

- **Page** (`src/base.rs` `Core`, wrapped by `Player` in `src/lib.rs`): an engine `Session`
  over an in-memory file table (its `Services` and media `Importer`; fonts in the table are
  registered with the text engine), with expressions and scripting. Engine commands, Essential
  Graphics edits and scripts run here, synchronously. The comp's audio is mixed here
  (`effectcraft_render::audio::mix_comp`, the editor's mixdown) into one `AudioBuffer` at the
  context's rate, again only after an edit.
- **Frame workers** (`worker.js` → `workerInit` / `workerFile` / `workerFrame`): the editor's
  frame-worker protocol (`effectcraft_engine::remote`). Before a render, the page sends a worker
  the files it lacks (footage the project reads, fonts) and a sync from its `Mirror`: the whole
  project the first time, then a **diff** from the revision the worker holds (a slider drag or
  a text edit is a few hundred bytes); then the request. The worker's `FrameServer` renders and
  posts premultiplied RGBA8 (transferred). With WebGPU in workers it renders on its own device
  with deferred readbacks: `FrameServer::handle_async` awaits the device between passes. Without
  workers (or `workers: 0`) frames render on the page's CPU.

While playing, each idle worker gets the next frame not asked for yet (up to 8 ahead); every
display frame draws the newest frame that is due and drops the late ones (`stats.dropped`), so
playback keeps the audio's pace and shows fewer frames when rendering is slower than the frame
rate.

## Tests

- Native: `cargo test -p effectcraft-player` (`src/base/tests.rs`: a script building a project
  from `props.json`, script errors, `set` reaching a worker replica by diff with the page's
  pixels, files sent once and again when replaced, `load` of a saved project) and
  `effectcraft-engine` `remote::tests::handle_async_awaits_the_passes`.
- Browser: `apps/effectcraft-player/tests/smoke.mjs` drives headless Chrome (Node ≥ 22, no npm
  packages): load timing and the workers' GPU, the demo frame, `set`, playback to `ended`, and
  with `--example news-short --lang ar` (the samples in `examples/player`, which
  `cargo xtask player` copies next to the demo page) or `--script t.jsx --props props.json` a
  template built in the browser from files handed over as `blob:` URLs (`--files
  name=path,…` adds files, `--patch '{"voice":"voice.mp3"}'` merges props): PNGs at `--times`,
  frame times in a GPU worker, a CPU worker and on the page, and playback with its audio
  (`stats.lagMs`: how far the picture is behind the audio clock).

```sh
examples/player/prepare.sh --fonts   # the samples' fonts (examples/player/README.md)
cargo xtask player --serve 8766 &
node apps/effectcraft-player/tests/smoke.mjs --url http://127.0.0.1:8766/ --out target/player/smoke --example news-short --lang fr --times 1,6,14
```

The demo page opens the sample with `?example=news-short&lang=ar`.

## Measurements (0.10.0, Apple M-series, Chrome headless, 1080×1920, news-short)

| | |
|---|---|
| module (`--opt 3`: fat LTO, wasm-opt `-O3`) | 33.2 MB raw; 7.4 MB `.br`, 11.6 MB `.gz` (the editor's: ≈ 58 MB raw before wasm-opt, docs/web.md) |
| `create` (fetch the `.gz`, decompress, compile, start 2 workers) | ≈ 150 ms (local server) |
| `runScript` (build the comp from props) | ≈ 290 ms |
| frame, GPU worker | ≈ 45 ms (≈ 60 ms wall) |
| frame, CPU worker | ≈ 105 ms |
| frame, page CPU (no workers) | ≈ 140 ms |

With `--opt z` (22.8 MB raw): ≈ 400 ms `runScript`, frames ≈ 50 ms on a GPU worker (≈ 80 ms
wall), ≈ 130 ms on a CPU worker, ≈ 190 ms on the page.

The first frame on a GPU worker compiles its pipelines: ≈ 6 s on a busy machine (a few hundred
ms with CPU workers). Playback at preview size (≈ 0.36 scale) keeps 30 fps with the picture
within one or two frames of the audio clock.

## Gaps

- The first GPU frame waits for the worker's shader pipelines (see above); an app can start
  with `gpu: false` for an instant first frame.

- The whole comp's audio is mixed at once on the page when playback starts after an edit
  (a long comp takes a moment and ≈ 23 MB per minute at 48 kHz).
- Frames are drawn with `putImageData` from RGBA8 read back from the worker (no zero-copy GPU
  path to the canvas, no HDR).
- No disk cache, layer-buffer store or Roto Brush relay (the editor's frame-worker extras).
- Browsers without WebGPU in workers render on the workers' CPU.
