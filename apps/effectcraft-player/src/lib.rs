//! An embeddable EffectCraft player for the browser: the engine without the editor UI.
//!
//! One wasm module, two roles (`web/player.js` drives both, see docs/player.md):
//!
//! - **Page** — `Player`: an engine session over an in-memory file table ([`base::Core`]):
//!   load a project or build it with a template script, run engine commands, set Essential
//!   Graphics controls, mix the audio, and prepare what each frame worker needs (the files it
//!   lacks, the project as a diff from the revision it holds, render requests). Frames can also
//!   render here, on the CPU (no workers). [`base`] is that portable core.
//! - **Frame worker** — `workerInit` / `workerFile` / `workerFrame`: the engine's
//!   `FrameServer` (the editor's frame workers' protocol, `effectcraft_engine::remote`), on the
//!   worker's own WebGPU device where the browser has one (deferred readbacks, frames in
//!   passes), else its CPU.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod base;

#[cfg(target_arch = "wasm32")]
mod web {
    use std::cell::RefCell;
    use std::sync::Arc;

    use effectcraft_engine::project::ItemId;
    use effectcraft_engine::remote::{FrameMsg, FrameReply, FrameServer};
    use effectcraft_media::MediaPool;
    use wasm_bindgen::prelude::*;

    use crate::base::{Core, Files, ingest};

    fn js_err(e: impl std::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    fn parse(json: &str) -> Result<serde_json::Value, JsValue> {
        if json.is_empty() { Ok(serde_json::Value::Null) } else { serde_json::from_str(json).map_err(js_err) }
    }

    /// The page's player (results are JSON strings; `web/player.js` parses them).
    #[wasm_bindgen]
    pub struct Player {
        core: Core,
    }

    #[wasm_bindgen]
    impl Player {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Player {
            Player { core: Core::default() }
        }

        /// Add or replace a file (footage, fonts, props): the bytes stay in the player's table.
        #[wasm_bindgen(js_name = addFile)]
        pub fn add_file(&self, path: &str, bytes: &[u8]) {
            self.core.add_file(path, bytes.into());
        }

        pub fn load(&mut self, project: &[u8]) -> Result<String, JsValue> {
            self.core.load(project).map(|v| v.to_string()).map_err(js_err)
        }

        #[wasm_bindgen(js_name = runScript)]
        pub fn run_script(&mut self, code: &str, props: Option<String>) -> Result<String, JsValue> {
            self.core.run_script(code, props.as_deref()).map(|v| v.to_string()).map_err(js_err)
        }

        pub fn execute(&mut self, cmd: &str, params: &str) -> Result<String, JsValue> {
            self.core.execute(cmd, parse(params)?).map(|v| v.to_string()).map_err(js_err)
        }

        pub fn info(&mut self, comp: Option<u32>) -> String {
            self.core.info(comp.map(|c| ItemId(c as u64))).to_string()
        }

        /// The comp `name` (else the active / first one): its id.
        pub fn comp(&self, name: Option<String>) -> Option<u32> {
            self.core.comp(name.as_deref()).map(|c| c.0 as u32)
        }

        pub fn set(&mut self, comp: u32, name: &str, value: &str) -> Result<String, JsValue> {
            self.core.set(ItemId(comp as u64), name, parse(value)?).map(|v| v.to_string()).map_err(js_err)
        }

        pub fn revision(&self) -> f64 {
            self.core.session.revision as f64
        }

        /// A frame rendered on the page's CPU: premultiplied RGBA8, `width` and `height` first
        /// (two little-endian u32).
        pub fn frame(&self, comp: u32, t: f64, scale: f64) -> Vec<u8> {
            let (w, h, px) = self.core.frame(ItemId(comp as u64), t, scale);
            let mut out = Vec::with_capacity(px.len() + 8);
            out.extend_from_slice(&w.to_le_bytes());
            out.extend_from_slice(&h.to_le_bytes());
            out.extend_from_slice(&px);
            out
        }

        /// What worker `w` needs first: `[paths of the files to send, sync message or undefined]`.
        pub fn sync(&mut self, w: u32) -> js_sys::Array {
            let (files, msg) = self.core.sync(w);
            let paths: js_sys::Array = files.iter().map(|p| JsValue::from_str(p)).collect();
            js_sys::Array::of2(&paths, &msg.map(JsValue::from).unwrap_or(JsValue::UNDEFINED))
        }

        pub fn forget(&mut self, w: u32) {
            self.core.forget(w);
        }

        #[wasm_bindgen(js_name = fileBytes)]
        pub fn file_bytes(&self, path: &str) -> Option<Vec<u8>> {
            self.core.files.get(path).map(|d| d.0.to_vec())
        }

        #[wasm_bindgen(js_name = renderMsg)]
        pub fn render_msg(&self, id: f64, comp: u32, t: f64, scale: f64, backend: &str) -> String {
            self.core.render_msg(id as u64, ItemId(comp as u64), t, scale, backend)
        }

        /// The comp's whole audio mix, interleaved stereo at `rate` Hz (empty without audio).
        pub fn mix(&self, comp: u32, rate: u32) -> Vec<f32> {
            self.core.mix(ItemId(comp as u64), rate)
        }
    }

    impl Default for Player {
        fn default() -> Self {
            Player::new()
        }
    }

    // ------------------------------------------------------------ frame worker side

    struct Worker {
        files: Files,
        pool: Arc<MediaPool>,
        server: Option<FrameServer>,
    }

    thread_local! {
        static WORKER: RefCell<Option<Worker>> = const { RefCell::new(None) };
    }

    /// Set up the frame worker: its frame server, on its own WebGPU device when `gpu` and the
    /// browser has WebGPU in workers. Resolves with the adapter's name, or `{cpu: why}` JSON.
    #[wasm_bindgen(js_name = workerInit)]
    pub async fn worker_init(gpu: bool) -> String {
        let pool = Arc::new(MediaPool::new());
        let mut server = FrameServer::new(pool.clone(), Some(Arc::new(effectcraft_expr::Expressions)));
        let info = if gpu {
            match effectcraft_gpu::Gpu::request_deferred().await {
                Ok(g) => {
                    let name = effectcraft_engine::render::Accelerator::name(&g);
                    server.set_accel(Some(Arc::new(g)));
                    serde_json::json!({"gpu": name})
                }
                Err(e) => serde_json::json!({"cpu": e}),
            }
        } else {
            serde_json::json!({"cpu": "GPU off"})
        };
        WORKER.with(|w| *w.borrow_mut() = Some(Worker { files: Files::default(), pool, server: Some(server) }));
        info.to_string()
    }

    #[wasm_bindgen(js_name = workerFile)]
    pub fn worker_file(path: &str, bytes: &[u8]) {
        WORKER.with(|w| {
            if let Some(w) = w.borrow().as_ref() {
                ingest(&w.files, &w.pool, path, bytes.into());
            }
        });
    }

    /// Handle one frame message (JSON `FrameMsg`); resolves with the replies as
    /// `[[json, pixels | undefined], …]`. Messages are handled one at a time (the server leaves
    /// its slot while a frame awaits the GPU).
    #[wasm_bindgen(js_name = workerFrame)]
    pub async fn worker_frame(json: String) -> js_sys::Array {
        let out = js_sys::Array::new();
        let msg: FrameMsg = match serde_json::from_str(&json) {
            Ok(m) => m,
            Err(e) => {
                let r = FrameReply::Resync { error: format!("bad message: {e}") };
                out.push(&js_sys::Array::of1(&JsValue::from_str(&serde_json::to_string(&r).unwrap_or_default())));
                return out;
            }
        };
        let Some(mut server) = WORKER.with(|w| w.borrow_mut().as_mut().and_then(|w| w.server.take())) else {
            let r = FrameReply::Resync { error: "worker not initialised".into() };
            out.push(&js_sys::Array::of1(&JsValue::from_str(&serde_json::to_string(&r).unwrap_or_default())));
            return out;
        };
        let replies = server.handle_async(msg).await;
        WORKER.with(|w| {
            if let Some(w) = w.borrow_mut().as_mut() {
                w.server = Some(server);
            }
        });
        for (r, px) in replies {
            let j = JsValue::from_str(&serde_json::to_string(&r).unwrap_or_default());
            let px = px.map(|p| JsValue::from(js_sys::Uint8Array::from(&p[..]))).unwrap_or(JsValue::UNDEFINED);
            out.push(&js_sys::Array::of2(&j, &px));
        }
        out
    }
}

#[cfg(target_arch = "wasm32")]
pub use web::*;
