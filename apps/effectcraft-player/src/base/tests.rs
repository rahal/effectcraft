use super::*;
use effectcraft_engine::remote::{FrameReply, FrameServer};

/// A template script: reads props.json, builds comp "t" with a text layer `headline` and a red
/// solid, publishes the text as the Essential Graphics control `headline`.
const SCRIPT: &str = r#"
var f = new File("props.json"); f.open("r"); var v = JSON.parse(f.read()); f.close();
var comp = app.project.items.addComp("t", 160, 90, 1, 2, 30);
comp.layers.addSolid([1, 0, 0], "bg", 160, 90, 1);
var l = comp.layers.addText(v.headline); l.name = "headline";
l.property("Source Text").addToMotionGraphicsTemplateAs(comp, "headline");
writeLn("built " + comp.numLayers);
"#;

fn built() -> (Core, ItemId) {
    let mut c = Core::default();
    let info = c.run_script(SCRIPT, Some(r#"{"headline": "Hello"}"#)).unwrap();
    assert_eq!(info["output"], json!(["built 2"]), "{info}");
    assert_eq!(
        (info["width"].as_u64(), info["height"].as_u64(), info["fps"].as_f64(), info["duration"].as_f64()),
        (Some(160), Some(90), Some(30.0), Some(2.0))
    );
    assert_eq!(info["controls"][0]["name"], "headline", "{info}");
    let comp = c.comp(Some("t")).unwrap();
    (c, comp)
}

#[test]
fn a_script_builds_the_project_from_props() {
    let (c, comp) = built();
    let (w, h, px) = c.frame(comp, 0.5, 0.5);
    assert_eq!((w, h, px.len()), (80, 45, 80 * 45 * 4));
    // The red solid shows in the bottom-right corner, the white text elsewhere.
    assert_eq!(&px[px.len() - 4..], &[255, 0, 0, 255]);
    assert!(px.chunks(4).any(|p| p == [255, 255, 255, 255]));
}

#[test]
fn script_errors_name_the_line() {
    let mut c = Core::default();
    let e = c.run_script("var a = 1;\nnull.x;", None).unwrap_err();
    assert!(e.contains(":2:"), "{e}");
    // Reading a file the player wasn't given fails cleanly.
    assert!(c.run_script(r#"var f = new File("missing.json"); f.open("r"); JSON.parse(f.read());"#, None).is_err());
    // A template without its props says what is missing, even after one that had props.
    let (mut c, _) = built();
    let e = c.run_script(SCRIPT, None).unwrap_err();
    assert!(e.contains("props.json missing"), "{e}");
}

#[test]
fn set_changes_an_essential_control_and_workers_follow_by_diff() {
    let (mut c, comp) = built();
    let mut w = FrameServer::new(c.session.footage.clone(), c.session.expr.clone());
    let render = |c: &mut Core, w: &mut FrameServer, id: u64| {
        let (_, sync) = c.sync(0);
        if let Some(m) = sync {
            assert!(w.handle(serde_json::from_str(&m).unwrap()).is_empty());
        }
        let out = w.handle(serde_json::from_str(&c.render_msg(id, comp, 1.0, 0.5, "cpu")).unwrap());
        let (FrameReply::Frame { .. }, Some(px)) = &out[0] else { panic!("{:?}", out[0].0) };
        px.clone()
    };
    let before = render(&mut c, &mut w, 1);
    assert_eq!(before, c.frame(comp, 1.0, 0.5).2, "the worker renders what the page would");
    assert!(c.sync(0).1.is_none(), "up to date");
    c.set(comp, "headline", json!("A much longer headline")).unwrap();
    let (_, sync) = c.sync(0);
    let sync = sync.unwrap();
    assert!(sync.contains("\"patch\""), "an edit travels as a diff");
    w.handle(serde_json::from_str(&sync).unwrap());
    let out = w.handle(serde_json::from_str(&c.render_msg(2, comp, 1.0, 0.5, "cpu")).unwrap());
    let after = out[0].1.clone().unwrap();
    assert_ne!(after, before);
    assert_eq!(after, c.frame(comp, 1.0, 0.5).2);
    assert!(c.set(comp, "nope", json!(1)).is_err());
}

#[test]
fn workers_get_footage_and_fonts_once_and_again_when_replaced() {
    let (mut c, _) = built();
    c.add_file("a.ttf", Arc::from(&b"not a font"[..]));
    let (files, sync) = c.sync(3);
    assert_eq!((files, sync.is_some()), (vec!["a.ttf".to_string()], true));
    assert_eq!(c.sync(3).0, Vec::<String>::new());
    c.add_file("./a.ttf", Arc::from(&b"still not"[..]));
    assert_eq!(c.sync(3).0, vec!["a.ttf".to_string()]);
    // A new project: the worker gets it whole.
    c.run_script(SCRIPT, Some(r#"{"headline": "x"}"#)).unwrap();
    assert!(c.sync(3).1.unwrap().contains("\"project\""));
    c.forget(3);
    assert_eq!(c.sync(3).0, vec!["a.ttf".to_string()]);
}

#[test]
fn load_opens_a_saved_project_and_mix_is_silent_without_audio() {
    let (c, _) = built();
    let json = c.session.project.to_json();
    let mut d = Core::default();
    let info = d.load(json.as_bytes()).unwrap();
    let comp = d.comp(Some("t")).unwrap();
    assert_eq!(info["comps"].as_array().map(Vec::len), Some(1));
    assert_eq!(d.frame(comp, 1.0, 0.5).2, c.frame(c.comp(Some("t")).unwrap(), 1.0, 0.5).2);
    assert!(d.mix(comp, 48_000).is_empty());
    assert!(d.load(b"{not json").is_err());
}
