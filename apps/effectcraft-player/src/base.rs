//! The player's portable core: an engine session over an in-memory file table, the frame
//! workers' replicas ([`Mirror`] per worker) and the audio mix. No browser types: the wasm glue
//! (`lib.rs`) wraps it, and the tests here run it natively.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use effectcraft_engine::Session;
use effectcraft_engine::offload::footage_files;
use effectcraft_engine::project::{ItemId, ItemKind, Project};
use effectcraft_engine::remote::{FrameMsg, Mirror, rgba8_premultiplied};
use effectcraft_engine::render::{Backend, RenderOpts, Renderer};
use effectcraft_engine::time::Tick;
use effectcraft_media::MediaPool;
use serde_json::{Value, json};

/// Where [`Core::load`] puts the project and [`Core::run_script`] the props (relative: scripts
/// read files in the project's folder, the table's root).
pub const PROJECT: &str = "project.ecproj";
pub const PROPS: &str = "props.json";

/// Table paths are relative to its root, the scripts' working folder: scripts make relative
/// names absolute against the current directory (none in the browser; natively, the tests').
fn key(p: &str) -> String {
    let cwd = std::env::current_dir().ok().map(|d| format!("{}/", d.to_string_lossy()));
    let p = cwd.as_deref().and_then(|d| p.strip_prefix(d)).unwrap_or(p);
    p.strip_prefix("./").unwrap_or(p).to_string()
}

fn is_font(p: &str) -> bool {
    let p = p.to_ascii_lowercase();
    [".ttf", ".otf", ".ttc"].iter().any(|e| p.ends_with(e))
}

/// The file table: path → (bytes, version). A replaced file gets a new version, so workers that
/// had the old one get it again.
#[derive(Default)]
pub struct Files {
    map: RwLock<HashMap<String, (Arc<[u8]>, u64)>>,
}

impl Files {
    /// Store a file; `true` when the path is new.
    pub fn put(&self, path: &str, data: Arc<[u8]>) -> bool {
        let mut m = self.map.write().unwrap_or_else(|e| e.into_inner());
        let version = m.values().map(|v| v.1).max().unwrap_or(0) + 1;
        m.insert(key(path), (data, version)).is_none()
    }

    pub fn get(&self, path: &str) -> Option<(Arc<[u8]>, u64)> {
        self.map.read().unwrap_or_else(|e| e.into_inner()).get(&key(path)).cloned()
    }

    pub fn remove(&self, path: &str) {
        self.map.write().unwrap_or_else(|e| e.into_inner()).remove(&key(path));
    }

    pub fn fonts(&self) -> Vec<String> {
        self.map.read().unwrap_or_else(|e| e.into_inner()).keys().filter(|p| is_font(p)).cloned().collect()
    }
}

struct Table(Arc<Files>);

impl effectcraft_engine::Services for Table {
    fn read_file(&self, path: &str) -> std::io::Result<Vec<u8>> {
        self.0.get(path).map(|d| d.0.to_vec()).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("{path}: not given to the player")))
    }
    /// Writes (a script saving the project…) stay in the table.
    fn write_file(&self, path: &str, data: &[u8]) -> std::io::Result<()> {
        self.0.put(path, data.into());
        Ok(())
    }
    fn exists(&self, path: &str) -> bool {
        self.0.get(path).is_some()
    }
    fn stamp(&self, _: &str) -> Option<(u64, u128)> {
        None
    }
    fn store_file(&self, path: &str, data: &[u8]) -> std::io::Result<()> {
        self.write_file(path, data)
    }
    fn list_dir(&self, _: &str) -> Vec<String> {
        vec![]
    }
    fn is_dir(&self, _: &str) -> bool {
        false
    }
}

/// Media import from the table (the media pool decodes the bytes).
struct Importer {
    files: Arc<Files>,
    pool: Arc<MediaPool>,
}

impl effectcraft_engine::Importer for Importer {
    fn probe(&self, path: &str) -> Result<effectcraft_engine::project::Footage, String> {
        let (bytes, _) = self.files.get(path).ok_or_else(|| format!("{path}: not given to the player (add it to `files`)"))?;
        self.pool.add_bytes(path, bytes.clone());
        effectcraft_media::probe_bytes(path, bytes).map_err(|e| e.to_string())
    }
}

/// A file for an engine instance: the table, the media pool and, for fonts, the font database.
pub fn ingest(files: &Files, pool: &MediaPool, path: &str, data: Arc<[u8]>) {
    let new = files.put(path, data.clone());
    if is_font(path) {
        if new {
            effectcraft_engine::text::fonts::add_font_data(data.to_vec());
        }
    } else {
        pool.add_bytes(path, data);
    }
}

pub struct Core {
    pub session: Session,
    pub files: Arc<Files>,
    pub pool: Arc<MediaPool>,
    /// Each frame worker's replica and files.
    workers: HashMap<u32, Mirror>,
}

impl Default for Core {
    fn default() -> Self {
        let files = Arc::new(Files::default());
        let pool = Arc::new(MediaPool::new());
        let session = Core::session(&files, &pool);
        Core { session, files, pool, workers: HashMap::new() }
    }
}

fn comp_json(p: &Project, id: ItemId) -> Value {
    let (Some(item), Some(c)) = (p.item(id), p.comp(id)) else { return Value::Null };
    json!({"id": id.0, "name": item.name, "width": c.width, "height": c.height, "fps": c.frame_rate.as_f64(), "duration": c.duration.seconds()})
}

impl Core {
    fn session(files: &Arc<Files>, pool: &Arc<MediaPool>) -> Session {
        let mut s = Session {
            services: Arc::new(Table(files.clone())),
            footage: pool.clone(),
            importer: Some(Arc::new(Importer { files: files.clone(), pool: pool.clone() })),
            expr: Some(Arc::new(effectcraft_expr::Expressions)),
            expr_check: Some(effectcraft_expr::check_syntax),
            ..Default::default()
        };
        effectcraft_script::install(&mut s);
        // Scripts read files in the project's folder: the table's root.
        s.path = Some(PROJECT.into());
        s
    }

    /// A fresh session (same files): the workers get the whole project again.
    fn reset(&mut self) {
        self.session = Core::session(&self.files, &self.pool);
        for w in self.workers.values_mut() {
            w.reset();
        }
    }

    pub fn add_file(&self, path: &str, data: Arc<[u8]>) {
        ingest(&self.files, &self.pool, path, data);
    }

    /// Open a project (`.ecproj` JSON); its footage must be in the table under the paths it
    /// names (or be replaced later).
    pub fn load(&mut self, project: &[u8]) -> Result<Value, String> {
        self.reset();
        self.files.put(PROJECT, project.into());
        self.session.execute("file.open", json!({"path": PROJECT})).map_err(|e| e.to_string())?;
        Ok(self.info(None))
    }

    /// Build the project with a template script on an empty project, `props` (JSON) readable
    /// as `props.json` (path A: the script reads it, imports its media from the table).
    pub fn run_script(&mut self, code: &str, props: Option<&str>) -> Result<Value, String> {
        self.reset();
        // No props: drop the last template's, so the script can't read them.
        match props {
            Some(p) => _ = self.files.put(PROPS, p.as_bytes().into()),
            None => self.files.remove(PROPS),
        }
        let out = effectcraft_script::run_code(&mut self.session, code, "template.jsx");
        if let Some(e) = &out.error {
            // A script reading props.json that was never given sees an empty file: say so.
            let hint = if self.files.get(PROPS).is_none() && code.contains(PROPS) { " (props.json missing: pass `props`)" } else { "" };
            return Err(format!("{}:{}:{}: {}{hint}", e.file, e.line.unwrap_or(0), e.column.unwrap_or(0), e.message));
        }
        let mut info = self.info(None);
        info["output"] = json!(out.output);
        Ok(info)
    }

    pub fn execute(&mut self, cmd: &str, params: Value) -> Result<Value, String> {
        self.session.execute_checked(cmd, params).map_err(|e| e.to_string())
    }

    /// The comp named `name`, else the active one, else the first.
    pub fn comp(&self, name: Option<&str>) -> Option<ItemId> {
        let p = &self.session.project;
        let comps = || p.items.iter().filter(|(_, i)| matches!(i.kind, ItemKind::Comp(_))).map(|(id, i)| (*id, i.name.as_str()));
        match name.filter(|n| !n.is_empty()) {
            Some(n) => comps().find(|c| c.1 == n).map(|c| c.0),
            None => self.session.active_comp_id().or_else(|| comps().next().map(|c| c.0)),
        }
    }

    /// `{comps, comp, width, height, fps, duration, controls, revision}` (`comp` and its size:
    /// `comp`, else the active / first one; `controls`: its Essential Graphics controls).
    pub fn info(&mut self, comp: Option<ItemId>) -> Value {
        let p = &self.session.project;
        let comps: Vec<Value> = p.items.iter().filter(|(_, i)| matches!(i.kind, ItemKind::Comp(_))).map(|(id, _)| comp_json(p, *id)).collect();
        let main = comp.filter(|c| p.comp(*c).is_some()).or_else(|| self.comp(None));
        let mut v = main.map(|c| comp_json(p, c)).unwrap_or_else(|| json!({}));
        let controls = main.and_then(|c| self.session.execute("essential.list", json!({"comp": c.0})).ok()).map(|l| l["controls"].clone()).unwrap_or(json!([]));
        v["comp"] = main.map(|c| json!(c.0)).unwrap_or(Value::Null);
        v["comps"] = json!(comps);
        v["controls"] = controls;
        v["revision"] = json!(self.session.revision);
        v
    }

    /// Set the Essential Graphics control `name` of `comp`: a property control takes its value
    /// (text, number, colour, checkbox, 1-based dropdown index); a media control takes a table
    /// path (the footage is replaced). Groups (`Réglages`) are searched too.
    pub fn set(&mut self, comp: ItemId, name: &str, value: Value) -> Result<Value, String> {
        let list = self.execute("essential.list", json!({"comp": comp.0}))?;
        fn find<'a>(cs: &'a Value, name: &str) -> Option<&'a Value> {
            cs.as_array()?.iter().find_map(|c| if c["kind"] == "group" { find(&c["children"], name) } else { (c["name"] == name).then_some(c) })
        }
        let c = find(&list["controls"], name).ok_or_else(|| format!("no Essential Graphics control `{name}`"))?.clone();
        match c["kind"].as_str() {
            Some("property") | Some("mirror") => {
                self.execute("prop.set", json!({"comp": comp.0, "layer": c["layer"], "path": format!("@{}", c["prop"]), "value": value}))
            }
            Some("media") => self.execute("file.replaceFootage", json!({"item": c["item"], "path": value})),
            k => Err(format!("control `{name}` ({k:?}) has no value")),
        }
    }

    fn opts(scale: f64, backend: &str) -> RenderOpts {
        let backend = match backend {
            "gpu" => Backend::Gpu,
            "auto" => Backend::Auto,
            _ => Backend::Cpu,
        };
        RenderOpts { scale: scale.clamp(0.05, 1.0), backend, ..Default::default() }
    }

    /// A frame rendered here (CPU): `(width, height, premultiplied RGBA8)`.
    pub fn frame(&self, comp: ItemId, t: f64, scale: f64) -> (u32, u32, Vec<u8>) {
        let s = &self.session;
        let mut r = Renderer::new(&s.project, s.footage.as_ref(), Core::opts(scale, "cpu"));
        r.expr = s.expr.as_deref();
        let img = r.comp_frame(comp, Tick::from_seconds_f64(t));
        (img.width, img.height, rgba8_premultiplied(&img))
    }

    /// What worker `w` needs before rendering the current revision: the files it lacks
    /// (footage the project reads, fonts) and the project sync (JSON [`FrameMsg`]; `None` when
    /// it is up to date). Marks them sent.
    pub fn sync(&mut self, w: u32) -> (Vec<String>, Option<String>) {
        let wk = self.workers.entry(w).or_default();
        let files = &self.files;
        let send = wk.files(footage_files(&self.session.project).into_iter().chain(files.fonts()), |p| files.get(p).map(|f| f.1));
        let msg = wk.sync(self.session.revision, &self.session.project).map(|m| serde_json::to_string(&m).unwrap_or_default());
        (send, msg)
    }

    /// Worker `w` lost its replica (it asked for a resync, or restarted).
    pub fn forget(&mut self, w: u32) {
        self.workers.remove(&w);
    }

    /// The render request (JSON [`FrameMsg::Render`]) for the current revision.
    pub fn render_msg(&self, id: u64, comp: ItemId, t: f64, scale: f64, backend: &str) -> String {
        let m = FrameMsg::Render {
            id,
            revision: self.session.revision,
            comp,
            time: Tick::from_seconds_f64(t),
            opts: Box::new(Core::opts(scale, backend)),
            disk: None,
            layers: false,
            prefetch: vec![],
        };
        serde_json::to_string(&m).unwrap_or_default()
    }

    /// The whole comp's audio at `rate` Hz, interleaved stereo (empty when it has none).
    // shortcut: mixes the whole comp at once (≈ 23 MB per minute at 48 kHz); mix in blocks if long comps matter.
    pub fn mix(&self, comp: ItemId, rate: u32) -> Vec<f32> {
        let s = &self.session;
        let Some(c) = s.project.comp(comp) else { return vec![] };
        if !effectcraft_engine::render::audio::comp_has_audio(&s.project, comp) {
            return vec![];
        }
        let frames = (c.duration.seconds().max(0.0) * rate as f64).ceil() as usize;
        effectcraft_engine::render::audio::mix_comp(&s.project, s.footage.as_ref(), s.expr.as_deref(), comp, Tick::ZERO, frames, rate)
    }
}

#[cfg(test)]
mod tests;
