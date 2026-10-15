// An EffectCraft player frame worker (src/lib.rs `workerInit` / `workerFile` / `workerFrame`,
// the engine's FrameServer). The page sends the compiled module, then footage/font files and
// frame messages (project syncs as diffs, render requests); the worker replies with the frames
// (pixels transferred). With a WebGPU device of its own a frame renders in passes, awaiting the
// device's readbacks between them; messages are handled one at a time, in order.
import init, * as ec from "./effectcraft_player.js";

let ready = null;
let queue = Promise.resolve();

async function handle(m) {
  if (m.type === "file") ec.workerFile(m.path, m.bytes);
  else if (m.type === "frame") {
    const replies = await ec.workerFrame(m.json);
    if (replies.length) postMessage({ type: "replies", replies }, replies.flatMap(([, px]) => (px ? [px.buffer] : [])));
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    ready = (async () => {
      await init({ module_or_path: m.module });
      const info = await ec.workerInit(!!m.gpu && !!self.navigator?.gpu);
      postMessage({ type: "ready", info: JSON.parse(info) });
    })();
    // Re-raised outside the promise so the page's `onerror` sees a failed start.
    ready.catch((err) => setTimeout(() => { throw err; }));
    return;
  }
  queue = queue.then(() => ready).then(() => handle(m)).catch((err) => setTimeout(() => { throw err; }));
};
