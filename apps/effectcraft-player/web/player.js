// EffectCraft player: an EffectCraft project (or a template script + props) in a <canvas>,
// played with Web Audio. No editor UI. See docs/player.md.
//
//   import { EffectcraftPlayer } from "./player.js";
//   const p = await EffectcraftPlayer.create({ canvas });
//   await p.load({ project: "template.ecproj", files: { "media.jpg": blob } });
//   await p.set("headline", "Hello"); await p.seek(2); p.play();
//
// The page holds the engine session (src/base.rs); frames render in frame workers
// (worker.js), each with a replica of the project kept up to date by diffs and, where the
// browser has WebGPU in workers, its own GPU device. Without workers frames render on the page.
import init, { Player as Core } from "./effectcraft_player.js";

let compiled = null;
/// Which copy of the module loaded: "br", "gzip", "parts" or "wasm" (`stats.wasm`).
let source = null;

/// Whether this browser's `DecompressionStream` reads `format` (gzip: everywhere; brotli: newer).
function decompresses(format) {
  try {
    return typeof DecompressionStream !== "undefined" && !!new DecompressionStream(format);
  } catch {
    return false;
  }
}

/// The module, compiled once for the page and its workers. `effectcraft_player_bg.json` (from
/// `cargo xtask player`) lists the copies: a Brotli or gzip one, decompressed here while it
/// downloads (static hosts don't serve pre-compressed files as such), else the parts of a split
/// build (for hosts that limit file sizes), fetched in parallel and streamed to the compiler in
/// order, else the one `.wasm`.
function wasmModule(base) {
  compiled ??= (async () => {
    const m = await fetch(new URL("effectcraft_player_bg.json", base)).then((r) => (r.ok ? r.json() : null), () => null);
    for (const [key, format] of [["br", "brotli"], ["gzip", "gzip"]]) {
      if (!m?.[key] || !decompresses(format)) continue;
      try {
        const r = await fetch(new URL(m[key], base));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const mod = await WebAssembly.compileStreaming(new Response(r.body.pipeThrough(new DecompressionStream(format)), { headers: { "content-type": "application/wasm" } }));
        source = key;
        return mod;
      } catch (e) {
        console.warn(`effectcraft-player: ${m[key]} didn't load (${e.message}), trying the next copy`);
      }
    }
    source = m?.parts?.length ? "parts" : "wasm";
    if (!m?.parts?.length) return WebAssembly.compileStreaming(fetch(new URL("effectcraft_player_bg.wasm", base)));
    const parts = m.parts.map((p) => fetch(new URL(p, base)).then((r) => {
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return r;
    }));
    let k = 0, reader = null;
    const stream = new ReadableStream({
      async pull(c) {
        for (;;) {
          if (!reader) {
            if (k >= parts.length) return c.close();
            reader = (await parts[k++]).body.getReader();
          }
          const { done, value } = await reader.read();
          if (!done) return c.enqueue(value);
          reader = null;
        }
      },
    });
    return WebAssembly.compileStreaming(new Response(stream, { headers: { "content-type": "application/wasm" } }));
  })();
  return compiled;
}

/// Bytes of a Uint8Array, ArrayBuffer, Blob/File or URL (blob: URLs included).
async function bytesOf(src) {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (typeof Blob !== "undefined" && src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
  if (typeof src === "string" || src instanceof URL) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("expected a Uint8Array, ArrayBuffer, Blob or URL");
}

async function textOf(src) {
  // A one-line URL or path to a .jsx/.js is fetched; anything else is the script itself.
  if (typeof src === "string" && (src.includes("\n") || !/^(blob:|https?:)|\.jsx?$/.test(src.trim()))) return src;
  return new TextDecoder().decode(await bytesOf(src));
}

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm",
  "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac" };

/// Premultiplied RGBA8 (the engine's) → the canvas's straight alpha, in place.
function unpremultiply(px) {
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i];
    if (a !== 255 && a !== 0) {
      const k = 255 / a;
      px[i - 3] = Math.min(255, px[i - 3] * k);
      px[i - 2] = Math.min(255, px[i - 2] * k);
      px[i - 1] = Math.min(255, px[i - 1] * k);
    }
  }
  return px;
}

export class EffectcraftPlayer extends EventTarget {
  /// `canvas`: where frames are drawn. `workers`: frame workers (0 = render on the page).
  /// `gpu`: workers open their own WebGPU device where they can. `scale`: render scale
  /// (default: the canvas's displayed size). `backend`: "auto" | "gpu" | "cpu" for GPU workers.
  static async create(opts = {}) {
    const p = new EffectcraftPlayer(opts);
    await p.#start();
    return p;
  }

  #o; #core = null; #canvas; #ctx2d = null;
  #workers = []; #pending = new Map(); #nextId = 0;
  #info = null; #comp = null;
  #time = 0; #playing = false; #raf = 0;
  #seekTarget = null; #seeking = null;
  #cache = new Map(); #asked = new Set(); #cacheRev = -1;
  #audio = null; #mixRev = -1; #mixComp = -1; #buffer = null; #source = null; #clock0 = 0; #t0 = 0;
  #mediaN = 0;
  #gain = null; #volume = 1; #muted = false;
  stats = { frames: 0, lastMs: 0, dropped: 0, local: 0, workers: [] };

  constructor({ canvas = null, workers = 2, gpu = true, scale = null, backend = "auto", base = import.meta.url } = {}) {
    super();
    this.#o = { workers, gpu, scale, backend, base };
    this.#canvas = canvas;
  }

  async #start() {
    const t0 = performance.now();
    const module = await wasmModule(this.#o.base);
    this.stats.wasm = source;
    await init({ module_or_path: module });
    this.#core = new Core();
    const n = typeof Worker === "undefined" ? 0 : this.#o.workers;
    const ready = [];
    for (let i = 0; i < n; i++) ready.push(this.#startWorker(i, module));
    await Promise.allSettled(ready);
    this.stats.loadMs = performance.now() - t0;
  }

  #startWorker(index, module) {
    const worker = new Worker(new URL("worker.js", this.#o.base), { type: "module", name: `effectcraft-player-${index}` });
    const w = { index, worker, busy: false, alive: true, gpu: null };
    this.#workers.push(w);
    return new Promise((resolve) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") {
          w.gpu = m.info.gpu ?? null;
          w.cpu = m.info.cpu ?? null;
          this.stats.workers[index] = m.info;
          resolve();
        } else if (m.type === "replies") {
          for (const [json, px] of m.replies) this.#reply(w, JSON.parse(json), px);
        }
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        w.alive = false;
        this.#core.forget(index);
        for (const [id, p] of this.#pending) if (p.w === w) { this.#pending.delete(id); p.reject(new Error(e.message || "frame worker failed")); }
        this.#emit("error", { error: e.message || "frame worker failed" });
        resolve();
      };
      worker.postMessage({ type: "init", module, gpu: this.#o.gpu });
    });
  }

  #reply(w, r, px) {
    if (r.type === "resync") {
      this.#core.forget(w.index);
      return;
    }
    if (r.type !== "frame" && r.type !== "failed") return;
    const p = this.#pending.get(r.id);
    if (!p) return;
    this.#pending.delete(r.id);
    w.busy = false;
    if (r.type === "failed") {
      if (r.stale) this.#core.forget(w.index);
      p.reject(new Error(r.error));
    } else {
      p.resolve({ width: r.width, height: r.height, rgba: px, ms: r.ms, gpu: r.gpu, passes: r.passes });
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ------------------------------------------------------------------ content

  /// Add or replace files: `{path: Blob | Uint8Array | ArrayBuffer | URL}` (footage under the
  /// paths the project names, fonts (.ttf/.otf) used by its text, anything a script reads).
  async addFiles(files = {}) {
    for (const [path, src] of Object.entries(files)) this.#core.addFile(path, await bytesOf(src));
  }

  /// Load a project (`.ecproj` JSON: URL, Blob, bytes) or build one with a template `script`
  /// (`.jsx` text or URL) reading `props` (object or JSON) as `props.json`. Resolves with
  /// `{comps, comp, name, width, height, fps, duration, controls}` for `comp` (a name; default:
  /// the active or first comp).
  async load({ project, script, props, files = {}, comp } = {}) {
    try {
      await this.addFiles(files);
      if (script != null) {
        const p = props == null ? undefined : typeof props === "string" ? props : JSON.stringify(props);
        this.#info = JSON.parse(this.#core.runScript(await textOf(script), p));
      } else {
        this.#info = JSON.parse(this.#core.load(await bytesOf(project)));
      }
      this.#comp = this.#core.comp(comp ?? undefined) ?? null;
      if (this.#comp == null) throw new Error(comp ? `no composition "${comp}"` : "the project has no composition");
      this.#info = { ...this.#info, ...JSON.parse(this.#core.info(this.#comp)) };
      this.#time = 0;
      this.#mixRev = -1;
      this.#emit("ready", this.info);
      await this.seek(0);
      return this.info;
    } catch (e) {
      this.#emit("error", { error: String(e) });
      throw e;
    }
  }

  /// Build with a template script (path A): `runScript(jsx, props, files)`.
  runScript(script, props, files) {
    return this.load({ script, props, files });
  }

  /// An engine command (same ids and params as effectcraft-cli / MCP): `prop.set`,
  /// `file.replaceFootage`, `essential.list`… The frame on screen follows.
  async execute(cmd, params = {}) {
    const r = JSON.parse(this.#core.execute(cmd, JSON.stringify(params)));
    this.#changed();
    return r;
  }

  /// Set the Essential Graphics control `name` (groups included): text, number, colour
  /// `[r,g,b]` 0–1, boolean, dropdown index (1-based); a media control takes a Blob/File/bytes
  /// (or the path of a file already added).
  async set(name, value) {
    if (typeof Blob !== "undefined" && value instanceof Blob || value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const ext = value.name?.match(/\.[^./]+$/)?.[0] ?? EXT[value.type] ?? "";
      const path = `media/${name}-${++this.#mediaN}${ext}`;
      this.#core.addFile(path, await bytesOf(value));
      value = path;
    }
    const r = JSON.parse(this.#core.set(this.#comp, name, JSON.stringify(value)));
    this.#changed();
    return r;
  }

  #changed() {
    this.#info = { ...this.#info, ...JSON.parse(this.#core.info(this.#comp ?? undefined)) };
    if (!this.#playing) this.seek(this.#time).catch(() => {});
  }

  get info() {
    const i = this.#info ?? {};
    return { comps: i.comps, comp: this.#comp, name: i.name, width: i.width, height: i.height, fps: i.fps, duration: i.duration, controls: i.controls, output: i.output };
  }
  get duration() { return this.#info?.duration ?? 0; }
  get fps() { return this.#info?.fps ?? 30; }
  get currentTime() { return this.#time; }
  set currentTime(t) { this.seek(t); }
  /// Output volume 0–1 and mute (the mix itself is unchanged; the clock keeps running).
  get volume() { return this.#volume; }
  set volume(v) { this.#volume = Math.min(1, Math.max(0, Number(v) || 0)); this.#applyGain(); this.#emit("volumechange", { volume: this.#volume, muted: this.#muted }); }
  get muted() { return this.#muted; }
  set muted(m) { this.#muted = !!m; this.#applyGain(); this.#emit("volumechange", { volume: this.#volume, muted: this.#muted }); }
  #applyGain() { if (this.#gain) this.#gain.gain.value = this.#muted ? 0 : this.#volume; }
  get paused() { return !this.#playing; }

  // ------------------------------------------------------------------ frames

  /// The render scale: the option, else the canvas's displayed width over the comp's.
  #scale() {
    if (this.#o.scale) return this.#o.scale;
    const w = this.#canvas?.clientWidth ? this.#canvas.clientWidth * (globalThis.devicePixelRatio || 1) : this.#info?.width;
    return Math.min(1, Math.max(0.1, w / (this.#info?.width || w || 1)));
  }

  /// `{state, sampleRate, outputLatency, hasAudio, playing}` of the audio output.
  get audioState() {
    const a = this.#audio;
    return { state: a?.state ?? null, sampleRate: a?.sampleRate ?? null, outputLatency: a?.outputLatency ?? a?.baseLatency ?? null, hasAudio: !!this.#buffer, playing: !!this.#source, gain: this.#gain?.gain.value ?? null };
  }

  #idle() {
    return this.#workers.find((w) => w.alive && !w.busy && (w.gpu || w.cpu));
  }

  /// Render the frame at `t` (seconds): in an idle frame worker, else on the page.
  /// Resolves with `{width, height, rgba (premultiplied), ms, gpu}`.
  renderFrame(t, scale = this.#scale()) {
    const w = this.#idle();
    if (!w) {
      if (this.#workers.some((w) => w.alive && w.busy)) return new Promise((r) => setTimeout(r, 4)).then(() => this.renderFrame(t, scale));
      const t0 = performance.now();
      const out = this.#core.frame(this.#comp, t, scale);
      const dv = new DataView(out.buffer, out.byteOffset);
      this.stats.local++;
      return Promise.resolve({ width: dv.getUint32(0, true), height: dv.getUint32(4, true), rgba: out.subarray(8), ms: performance.now() - t0, gpu: false });
    }
    w.busy = true;
    const [paths, sync] = this.#core.sync(w.index);
    for (const p of paths) {
      const bytes = this.#core.fileBytes(p); // a fresh copy: hand it over instead of cloning it
      w.worker.postMessage({ type: "file", path: p, bytes }, bytes ? [bytes.buffer] : []);
    }
    if (sync) w.worker.postMessage({ type: "frame", json: sync });
    const id = ++this.#nextId;
    const backend = w.gpu ? this.#o.backend : "cpu";
    w.worker.postMessage({ type: "frame", json: this.#core.renderMsg(id, this.#comp, t, scale, backend) });
    return new Promise((resolve, reject) => this.#pending.set(id, { w, resolve, reject }));
  }

  #draw(f, t) {
    if (!this.#canvas) return;
    if (this.#canvas.width !== f.width || this.#canvas.height !== f.height) {
      this.#canvas.width = f.width;
      this.#canvas.height = f.height;
    }
    this.#ctx2d ??= this.#canvas.getContext("2d");
    const px = new Uint8ClampedArray(f.rgba.buffer, f.rgba.byteOffset, f.width * f.height * 4);
    this.#ctx2d.putImageData(new ImageData(unpremultiply(px), f.width, f.height), 0, 0);
    this.stats.frames++;
    this.stats.lastMs = f.ms;
    this.#emit("frame", { time: t, ms: f.ms, gpu: f.gpu });
  }

  #snap(t) {
    const d = this.duration, fps = this.fps;
    const k = Math.floor(Math.min(Math.max(0, t), Math.max(0, d - 1 / fps)) * fps + 1e-6);
    return k / fps;
  }

  /// Show the frame at `t`. Seeks while one renders coalesce: only the latest is rendered.
  async seek(t) {
    this.#time = Math.min(Math.max(0, t), this.duration);
    if (this.#playing) {
      this.#restartAudio();
      return;
    }
    this.#seekTarget = this.#time;
    if (this.#seeking) return this.#seeking;
    this.#seeking = (async () => {
      try {
        while (this.#seekTarget != null) {
          const st = this.#seekTarget;
          this.#seekTarget = null;
          const f = await this.renderFrame(this.#snap(st));
          if (this.#playing) break;
          this.#draw(f, st);
          this.#emit("timeupdate", { time: st });
        }
      } catch (e) {
        this.#emit("error", { error: String(e) });
      } finally {
        this.#seeking = null;
      }
    })();
    return this.#seeking;
  }

  // ------------------------------------------------------------------ playback

  #now() {
    if (this.#source && this.#audio) return this.#t0 + this.#audio.currentTime - this.#clock0 - (this.#audio.outputLatency || this.#audio.baseLatency || 0);
    return this.#t0 + (performance.now() - this.#clock0) / 1000;
  }

  #restartAudio() {
    this.#source?.stop();
    this.#source = null;
    this.#t0 = this.#time;
    if (this.#audio && this.#buffer) {
      const s = this.#audio.createBufferSource();
      s.buffer = this.#buffer;
      if (!this.#gain) {
        this.#gain = this.#audio.createGain();
        this.#gain.connect(this.#audio.destination);
        this.#applyGain();
      }
      s.connect(this.#gain);
      this.#clock0 = this.#audio.currentTime;
      s.start(0, this.#time);
      this.#source = s;
    } else {
      this.#clock0 = performance.now();
    }
  }

  /// The comp's mix, again only after an edit.
  #mix() {
    const rev = this.#core.revision();
    if (this.#mixRev === rev && this.#mixComp === this.#comp) return;
    this.#mixRev = rev;
    this.#mixComp = this.#comp;
    this.#buffer = null;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    this.#audio ??= new AC();
    const rate = this.#audio.sampleRate;
    const t0 = performance.now();
    const pcm = this.#core.mix(this.#comp, rate);
    this.stats.mixMs = performance.now() - t0;
    if (!pcm.length) return;
    const n = pcm.length / 2;
    const b = this.#audio.createBuffer(2, n, rate);
    const l = b.getChannelData(0), r = b.getChannelData(1);
    for (let i = 0; i < n; i++) { l[i] = pcm[2 * i]; r[i] = pcm[2 * i + 1]; }
    this.#buffer = b;
  }

  /// Play from the current time (from the start once ended). Call it from a user gesture so
  /// the browser lets audio start.
  async play() {
    if (this.#playing || !this.#info) return;
    if (this.#time >= this.duration - 1 / this.fps) this.#time = 0;
    this.#mix();
    await this.#audio?.resume?.();
    this.#playing = true;
    this.#restartAudio();
    this.#emit("play", { time: this.#time });
    this.#raf = requestAnimationFrame(() => this.#tick());
  }

  pause() {
    if (!this.#playing) return;
    this.#time = Math.min(this.#now(), this.duration);
    this.#playing = false;
    cancelAnimationFrame(this.#raf);
    this.#source?.stop();
    this.#source = null;
    this.#emit("pause", { time: this.#time });
  }

  /// One display frame while playing: ask idle workers for the next frames, show the newest
  /// one due, drop what's late.
  #tick() {
    if (!this.#playing) return;
    const fps = this.fps, d = this.duration;
    const t = this.#now();
    if (t >= d) {
      this.#time = d;
      this.pause();
      this.#emit("ended", { time: d });
      return;
    }
    this.#time = t;
    const rev = this.#core.revision();
    if (rev !== this.#cacheRev) { this.#cache.clear(); this.#asked.clear(); this.#cacheRev = rev; }
    const now = Math.floor(t * fps + 1e-6), last = Math.ceil(d * fps) - 1;
    let k = now;
    while (this.#idle() && k <= last && k < now + 8) {
      if (!this.#asked.has(k)) {
        const idx = k;
        this.#asked.add(idx);
        this.renderFrame(idx / fps).then((f) => { if (this.#cacheRev === rev) this.#cache.set(idx, f); }, () => this.#asked.delete(idx));
      }
      k++;
    }
    if (!this.#workers.some((w) => w.alive)) {
      // On the page: render the frame due (the clock skips what doesn't fit).
      if (!this.#asked.has(now)) { this.#asked.add(now); this.renderFrame(now / fps).then((f) => { if (this.#cacheRev === rev) this.#cache.set(now, f); }, () => this.#asked.delete(now)); }
    }
    let best = -1;
    for (const i of this.#cache.keys()) if (i <= now && i > best) best = i;
    if (best >= 0) {
      this.#draw(this.#cache.get(best), best / fps);
      // How far the picture is behind the (audio) clock: < 1 frame when rendering keeps up.
      this.stats.lagMs = (t - best / fps) * 1000;
      this.stats.maxLagMs = Math.max(this.stats.maxLagMs ?? 0, this.stats.lagMs);
      for (const i of [...this.#cache.keys()]) if (i <= best) { this.#cache.delete(i); if (i < best) this.stats.dropped++; }
    }
    for (const i of [...this.#asked]) if (i < now && !this.#cache.has(i) && i < best) this.#asked.delete(i);
    this.#emit("timeupdate", { time: t });
    this.#raf = requestAnimationFrame(() => this.#tick());
  }

  destroy() {
    this.pause();
    for (const w of this.#workers) w.worker.terminate();
    this.#workers = [];
    this.#audio?.close?.();
    this.#core?.free();
    this.#core = null;
  }
}

/// `<effectcraft-player src="template.ecproj" comp="main" workers="2">`: a canvas that plays
/// the project; click toggles playback. `element.player` is the EffectcraftPlayer (for
/// `set`, `execute`, events) once `element.ready` resolves.
export class EffectcraftPlayerElement extends (globalThis.HTMLElement ?? class {}) {
  static observedAttributes = ["src"];
  player = null;
  ready = null;
  connectedCallback() {
    if (this.ready) return;
    // Moving the element disconnects and reconnects it: the shadow root stays, the player is new.
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:inline-block;position:relative}canvas{width:100%;height:100%;display:block;object-fit:contain;background:#000}</style><canvas></canvas>`;
    const canvas = root.querySelector("canvas");
    canvas.addEventListener("click", () => (this.player?.paused ? this.player.play() : this.player?.pause()));
    const ready = EffectcraftPlayer.create({ canvas, workers: Number(this.getAttribute("workers") ?? 2) }).then(async (p) => {
      if (this.ready !== ready) return p.destroy(); // disconnected while starting
      this.player = p;
      for (const t of ["ready", "timeupdate", "play", "pause", "ended", "error"]) p.addEventListener(t, (e) => this.dispatchEvent(new CustomEvent(t, { detail: e.detail })));
      if (this.getAttribute("src")) await p.load({ project: this.getAttribute("src"), comp: this.getAttribute("comp") ?? undefined });
      return p;
    });
    this.ready = ready;
  }
  attributeChangedCallback(name, old, src) {
    if (name === "src" && old != null && src && this.player) this.player.load({ project: src, comp: this.getAttribute("comp") ?? undefined }).catch(() => {});
  }
  disconnectedCallback() {
    const ready = this.ready;
    this.ready = this.player = null;
    ready?.then((p) => p?.destroy(), () => {});
  }
}

if (globalThis.customElements && !customElements.get("effectcraft-player")) customElements.define("effectcraft-player", EffectcraftPlayerElement);
