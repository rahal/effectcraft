// Browser smoke test of the EffectCraft player over the Chrome DevTools Protocol.
// No npm dependencies (Node ≥ 22: global WebSocket and fetch).
//
//   cargo xtask player --serve 8766 &
//   node apps/effectcraft-player/tests/smoke.mjs --url http://127.0.0.1:8766/ --out /tmp/ec-player
//   # optionally a template built by a script, its files handed over as blob: URLs:
//   node apps/effectcraft-player/tests/smoke.mjs … --script t.jsx --props props.json --files a.jpg,assets/b.mp3=/abs/b.mp3,Font.ttf [--comp name] [--times 1,5,9]
//
// Steps: load (timing, frame workers and their GPU), the demo project drawn into the canvas, an
// Essential Graphics edit (`set`) reaching the workers, frame times in a GPU worker, a CPU worker
// and on the page, playback with Web Audio (the clock advances, frames are drawn, `ended`), and
// with `--script`: the template built in the browser, frames at `--times` saved as PNGs, its
// frame times and its audio. Writes `report.json` and PNGs; exits non-zero on failure.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const url = arg("url", "http://127.0.0.1:8766/");
const out = arg("out", join(tmpdir(), "effectcraft-player-smoke"));
const chrome = arg("chrome", process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const port = Number(arg("port", "9335"));
const headless = !process.argv.includes("--headed");
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "ec-player-chrome-"));
const proc = spawn(chrome, [
  ...(headless ? ["--headless=new"] : []),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-unsafe-webgpu",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1200,1000",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let nextId = 1;
const waiting = new Map();
const logs = [];

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && waiting.has(msg.id)) {
            waiting.get(msg.id)(msg);
            waiting.delete(msg.id);
          } else if (msg.method === "Runtime.consoleAPICalled") {
            logs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
          } else if (msg.method === "Runtime.exceptionThrown") {
            logs.push("EXCEPTION " + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
          }
        };
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("Chrome did not start");
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))));
}

async function js(expr, timeout = 300000) {
  const wrapped = `(async () => { try { return await (${expr}); } catch (e) { throw new Error(String(e && e.message || e)); } })()`;
  const r = await send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(`${expr.slice(0, 200)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function until(expr, ms = 60000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await js(expr)) return Date.now() - t0;
    await sleep(step);
  }
  throw new Error(`timeout waiting for ${expr}`);
}

const check = (cond, msg) => {
  if (!cond) throw new Error(`check failed: ${msg}`);
};

/// The canvas as a PNG file, and a small digest of its pixels.
async function canvasShot(name) {
  const data = await js(`document.getElementById("view").toDataURL("image/png")`);
  const p = join(out, `${name}.png`);
  writeFileSync(p, Buffer.from(data.split(",")[1], "base64"));
  return p;
}
const digest = `(() => { const c = document.getElementById("view"), x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let h = 0, lit = 0; for (let i = 0; i < x.length; i += 4) { h = (h * 31 + x[i] + 7 * x[i + 1] + 13 * x[i + 2]) >>> 0; if (x[i] + x[i + 1] + x[i + 2] > 60) lit++; }
  return { w: c.width, h: c.height, hash: h, lit: lit / (x.length / 4) }; })()`;

/// Mean ms per frame over `n` frames from `t0` (`opts`: a separate player's options).
const timing = (opts, n, t0, step) => `(async () => {
  const p = ${opts ? `await EffectcraftPlayer.create(${JSON.stringify(opts)})` : "player"};
  if (${!!opts}) await p.load(window.lastLoad);
  await p.renderFrame(${t0}, 1);
  const ms = [];
  for (let i = 1; i <= ${n}; i++) { const t = performance.now(); const f = await p.renderFrame(${t0} + i * ${step}, 1); ms.push({ wall: performance.now() - t, engine: f.ms, gpu: f.gpu }); }
  const s = { workers: p.stats.workers, local: p.stats.local, meanWallMs: ms.reduce((a, m) => a + m.wall, 0) / ms.length, meanEngineMs: ms.reduce((a, m) => a + m.engine, 0) / ms.length, gpu: ms.some((m) => m.gpu) };
  if (${!!opts}) p.destroy();
  return s;
})()`;

const report = { url, steps: {} };
let failed = null;
try {
  await connect();
  await send("Runtime.enable");
  await send("Page.enable");
  const t0 = Date.now();
  await send("Page.navigate", { url });
  await until("window.demoReady === true", 180000, 100);
  report.steps.load = { pageMs: Date.now() - t0, playerMs: await js("player.stats.loadMs"), wasm: await js("player.stats.wasm"),
    manifest: await js(`fetch("effectcraft_player_bg.json").then((r) => (r.ok ? r.json() : null))`), workers: await js("player.stats.workers"), info: await js("player.info") };
  // The module came from the best copy the build made and this browser decompresses.
  const mf = report.steps.load.manifest ?? {};
  const best = mf.br && (await js(`(() => { try { return !!new DecompressionStream("brotli"); } catch { return false; } })()`)) ? "br" : mf.gzip ? "gzip" : mf.parts ? "parts" : "wasm";
  check(report.steps.load.wasm === best, `module loaded from ${report.steps.load.wasm}, expected ${best}`);
  check(report.steps.load.info.width === 1080 && report.steps.load.info.duration === 4, "demo comp 1080 wide, 4 s");
  await js("player.seek(2)");
  const d0 = await js(digest);
  check(d0.lit > 0.001, "the demo frame shows its title");
  report.steps.demo = { digest: d0, png: await canvasShot("demo-2s") };

  // An Essential Graphics edit reaches the workers (as a diff) and the frame changes.
  await js(`player.set("title", "Player")`);
  await js("player.seek(2)");
  const d1 = await js(digest);
  check(d1.hash !== d0.hash, "set() changed the frame");
  report.steps.set = { digest: d1, png: await canvasShot("demo-set") };

  // Playback: the clock follows the audio context, frames are drawn, `ended` fires.
  await js(`(window.played = { frames: player.stats.frames, ended: false }, player.addEventListener("ended", () => (window.played.ended = true)), true)`);
  await js("player.seek(2.5)");
  await js("player.play()");
  await sleep(2500);
  await until("window.played.ended", 10000);
  report.steps.play = { framesDrawn: (await js("player.stats.frames")) - (await js("window.played.frames")), dropped: await js("player.stats.dropped"), time: await js("player.currentTime") };
  check(report.steps.play.framesDrawn >= 3, "frames drawn while playing");

  // A template built by a script (`--script`, or `--example` from examples/player), its files
  // handed over as blob: URLs; `--files` adds files, `--patch` merges JSON into its props.
  const script = arg("script"), example = arg("example");
  if (script || example) {
    const files = (arg("files", "") || "").split(",").filter(Boolean);
    for (const entry of files) {
      // `name=path` (the name the script or project uses) or a path (its file name).
      const [name, f] = entry.includes("=") ? entry.split("=") : [basename(entry), entry];
      const b64 = readFileSync(f).toString("base64");
      await js(`(window.blobs ??= {}, window.blobs[${JSON.stringify(name)}] = URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))])), true)`);
    }
    const patch = arg("patch", "{}");
    if (example) {
      await js(`exampleArgs(${JSON.stringify(example)}, ${JSON.stringify(arg("lang", "fr"))}).then((a) => (window.lastLoad = { ...a, props: { ...a.props, ...${patch} }, files: { ...a.files, ...(window.blobs ?? {}) } }, true))`);
    } else {
      const props = arg("props") ? readFileSync(arg("props"), "utf8") : "{}";
      await js(`(window.lastLoad = { script: ${JSON.stringify(readFileSync(script, "utf8"))}, props: { ...${props}, ...${patch} }, files: window.blobs ?? {}, comp: ${JSON.stringify(arg("comp") ?? null)} ?? undefined }, true)`);
    }
    const label = example ? `${example}-${arg("lang", "fr")}` : basename(script, ".jsx");
    const l0 = Date.now();
    const info = await js("player.load(window.lastLoad)");
    report.steps.template = { buildMs: Date.now() - l0, name: info.name, width: info.width, height: info.height, duration: info.duration, output: info.output, shots: [] };
    const times = (arg("times") || "1").split(",").map(Number);
    for (const t of times) {
      await js(`player.seek(${t})`);
      // Full resolution for the comparison PNGs.
      await js(`player.renderFrame(${t}, 1).then((f) => { const c = document.getElementById("view"); c.width = f.width; c.height = f.height;
        const px = new Uint8ClampedArray(f.rgba.buffer, f.rgba.byteOffset, f.width * f.height * 4); c.getContext("2d").putImageData(new ImageData(px, f.width, f.height), 0, 0); return true; })`);
      report.steps.template.shots.push({ t, png: await canvasShot(`${label}-${t}s`) });
    }
    const n = 10, step = 0.5;
    report.steps.template.frame = {
      defaultWorkers: await js(timing(null, n, 1, step)),
      cpuWorker: await js(timing({ workers: 1, gpu: false }, n, 1, step)),
      gpuWorker: await js(timing({ workers: 1, gpu: true, backend: "gpu" }, n, 1, step)),
      page: await js(timing({ workers: 0 }, 3, 1, step)),
    };
    // Its audio: mix time, then a short playback.
    await js("player.seek(0)");
    const f0 = await js("(player.stats.maxLagMs = 0, [player.stats.frames, player.stats.dropped])");
    await js("player.play()");
    await sleep(3000);
    const a = await js(`({ time: player.currentTime, mixMs: player.stats.mixMs, frames: player.stats.frames - ${f0[0]}, dropped: player.stats.dropped - ${f0[1]},
      audio: player.audioState, lagMs: player.stats.lagMs, maxLagMs: player.stats.maxLagMs })`);
    // Mute and volume act on the output gain only.
    const g = await js("(player.muted = true, [player.audioState.gain, (player.muted = false, player.volume = 0.5, player.audioState.gain)])");
    await js("player.pause()");
    report.steps.template.play = { ...a, gainMutedThenHalf: g };
    check(a.time > 2 && a.time < 4, `the clock ran ~3 s (${a.time})`);
    check(!a.audio.hasAudio || (g[0] === 0 && g[1] === 0.5), `muted / volume reach the gain (${g})`);
  }
} catch (e) {
  failed = e;
}
report.logs = logs.slice(-50);
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
proc.kill();
if (failed) {
  console.error(failed);
  process.exit(1);
}
