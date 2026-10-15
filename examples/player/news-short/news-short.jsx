// news-short for EffectCraft (After Effects-style ExtendScript): port of ../index.html (same props, same timing), run by renderer/src/engines.ts.
// Reads props.json (renderer-staged, media paths already work-dir relative, settings merged in) and builds the comp "news-short".
// ES5 only (ExtendScript). Props contract = the vn-schema in ../index.html (D-T5).
function readJson(p) { var f = new File(p); f.open("r"); var s = f.read(); f.close(); return JSON.parse(s); }
function hex(h) { return [parseInt(h.substr(1, 2), 16) / 255, parseInt(h.substr(3, 2), 16) / 255, parseInt(h.substr(5, 2), 16) / 255]; }
function num(x, lo, hi, d) { return (x == null || x === "" || isNaN(Number(x))) ? d : Math.min(hi, Math.max(lo, Number(x))); }
function off(x) { return x === false || x === "false"; }

var v = readJson("props.json");
var W = 1080, H = 1920, FPS = 30, PAD = 70, BW = W - 2 * PAD;
var SLOTS = [4.8, 2.6, 2.6, 3.5, 1.5]; // headline, bullet1-3, outro (= meta.voice.scenes slots)
var VIDEO = /\.(mp4|webm|mov)(\?.*)?$/i;
var FONT = "Cairo", ACC = hex(/^#[0-9a-fA-F]{6}$/.test(v.accent || "") ? v.accent : "#e63946"), WHITE = [1, 1, 1];
var rtl = v.dir === "rtl", SX = rtl ? 80 : -80;
var T = v.transitions === "rapide" ? 0.6 : 1; // tween durations only: positions and total length never change

// scene starts from props.scenes (voice-driven) else the default slots
var aligned = false;
if (v.scenes && v.scenes.length === SLOTS.length) { aligned = true; for (var q = 0; q < SLOTS.length; q++) if (!(v.scenes[q] > 0)) aligned = false; }
var sc = aligned ? v.scenes : SLOTS, st = [], TOTAL = 0;
for (var i = 0; i < sc.length; i++) { st.push(TOTAL); TOTAL += sc[i]; }

var comp = app.project.items.addComp("news-short", W, H, 1, TOTAL, FPS);

function tr(l, n) { return l.property("Transform").property(n); }
function ease(p) { // power2.out-ish: only the last key eases in (the tween starts fast, lands soft)
  try {
    var d = p.value instanceof Array ? Math.min(p.value.length, 2) : 1, e = [];
    for (var j = 0; j < d; j++) e.push(new KeyframeEase(0, 80));
    p.setTemporalEaseAtKey(p.numKeys, e, e);
  } catch (err) {}
}
function tween(l, name, t0, dur, a, b) { var p = tr(l, name); p.setValueAtTime(t0, a); p.setValueAtTime(t0 + dur, b); ease(p); }
function opacityOut(l, at, dur) { var p = tr(l, "Opacity"); p.setValueAtTime(at, p.value); p.setValueAtTime(at + dur, 0); }

// vnAnim.plan (templates/news-short/assets/anim.js): entry start, optional exit fade
function plan(path, s0, s1, at, dur) {
  var c = v.anim && v.anim[path] ? v.anim[path] : {}, k = v.marks ? v.marks[path] : null;
  var voiced = c.voice === true && k && k.length === 2 && k[1] > k[0];
  var cs = num(c.start, 0, 1e9, undefined), ce = num(c.end, 0, 1e9, undefined);
  var start = cs !== undefined ? s0 + cs : voiced ? k[0] : at;
  var stop = voiced ? k[1] : ce !== undefined ? s0 + ce : undefined;
  start = Math.min(Math.max(start, s0), s1);
  if (stop !== undefined) stop = Math.min(Math.max(stop, start + dur), s1);
  return { start: start, outAt: stop !== undefined ? Math.max(start + dur, stop - 0.25) : undefined };
}
// scene entry (slide + fade, each layer fades itself: a null's opacity does not reach its children) with the optional visibility window
function reveal(path, parts, s0, s1, at, dur) { // parts: [{l, max}] (opacity targets); returns the plan so the caller can slide its layer from p.start
  var p = plan(path, s0, s1, at, dur);
  for (var n = 0; n < parts.length; n++) {
    tween(parts[n].l, "Opacity", p.start, dur, 0, parts[n].max);
    if (p.outAt !== undefined) opacityOut(parts[n].l, p.outAt, 0.25);
  }
  return p;
}

// real static Cairo weights (../assets/Cairo-*.ttf from ../prepare.sh, OFL, found through EFFECTCRAFT_FONT_DIRS), selected by PostScript name; the variable cairo.ttf is regular only here
var FONTS = { 400: "Cairo", 600: "Cairo-SemiBold", 700: "Cairo-Bold", 800: "Cairo-Bold", 900: "Cairo-Black" };
function text(str, size, weight, lh, box, center) {
  // the engine runs the bidi algorithm with an LTR base: RLE...PDF (U+202B/U+202C) makes an RTL text order its Arabic/Latin/digit runs right-to-left
  // (checked on "المصدر: Example – مثال…" and digits/Latin in a sentence; RLM alone, or RLI/PDI, only fix a trailing "."; RLI/PDI also work but RLE is simpler)
  if (rtl) str = "‫" + str + "‬";
  var l = box ? comp.layers.addBoxText(box, str) : comp.layers.addText(str);
  var p = l.property("Source Text"), d = p.value;
  d.font = FONTS[weight] || FONT; d.fontSize = size; d.fillColor = WHITE; d.applyFill = true; d.leading = Math.round(size * lh);
  d.justification = center ? ParagraphJustification.CENTER_JUSTIFY : rtl ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY;
  p.setValue(d);
  return l;
}
function rect(name, w, h, color, opacity, radius) {
  var l = comp.layers.addShape(); l.name = name;
  var g = l.property("Contents").addProperty("ADBE Vector Group").property("Contents");
  var r = g.addProperty("ADBE Vector Shape - Rect");
  r.property("Size").setValue([w, h]); r.property("Position").setValue([w / 2, h / 2]); r.property("Roundness").setValue(radius || 0);
  g.addProperty("ADBE Vector Graphic - Fill").property("Color").setValue(color);
  if (opacity != null) tr(l, "Opacity").setValue(opacity);
  tr(l, "Anchor Point").setValue([0, 0]);
  return l;
}
function at(l, x, y) { tr(l, "Position").setValue([x, y]); }
function rectOf(l) { return l.sourceRectAtTime(0, false); }
function place(l, x, y) { var r = rectOf(l); at(l, x - r.left, y - r.top); } // ink rect top-left at (x, y), whatever the justification
function nul(name, parent) { var n = comp.layers.addNull(TOTAL); n.name = name; tr(n, "Anchor Point").setValue([0, 0]); at(n, 0, 0); /* a null's anchor defaults to its centre */ if (parent) n.parent = parent; return n; }

// ── background: image or video, cover + crop (focal point, zoom; static or keyframes) on top of the slow zoom 1 -> 1.15 ──
var isVideo = v.mediaType ? v.mediaType === "video" : VIDEO.test(v.media || "");
var bgItem = app.project.importFile(new ImportOptions(new File(v.media)));
var bg = comp.layers.add(bgItem); bg.name = "bg";
var cover = Math.max(W / bgItem.width, H / bgItem.height);
if (isVideo) {
  // the renderer already cut the file to trim.start..trim.end: freeze its last frame to the end of the comp
  try { bg.audioEnabled = false; } catch (e) {}
  bg.timeRemapEnabled = true;
  var remap = bg.property("Time Remap");
  remap.setValueAtTime(TOTAL, remap.keyValue(remap.numKeys));
  bg.outPoint = TOTAL;
}
// vnCrop: [{t,x,y,zoom}] sorted, never empty (static {x,y,zoom} = one key at 0)
function crop(c) {
  function one(o, t) { return { t: t, x: num(o.x, 0, 1, 0.5), y: num(o.y, 0, 1, 0.5), zoom: num(o.zoom, 1, 3, 1) }; }
  if (c && c.length) { var ks = []; for (var n = 0; n < c.length; n++) if (c[n] && typeof c[n] === "object") ks.push(one(c[n], num(c[n].t, 0, 86400, 0))); ks.sort(function (a, b) { return a.t - b.t; }); if (ks.length) return ks; }
  else if (c && typeof c === "object") return [one(c, 0)];
  return [one({}, 0)];
}
var keys = crop(v.crop && v.crop["9x16"]);
function camAt(t) { // hold before the first / after the last key, power1.inOut between
  if (t <= keys[0].t) return keys[0];
  for (var n = 1; n < keys.length; n++) {
    if (t <= keys[n].t) {
      var a = keys[n - 1], b = keys[n], p = (t - a.t) / Math.max(0.001, b.t - a.t);
      p = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, zoom: a.zoom + (b.zoom - a.zoom) * p };
    }
  }
  return keys[keys.length - 1];
}
// the editor formula: object-fit cover, object-position and scale origin at the focal point, scale = zoom x slow zoom
function frame(t) {
  var c = camAt(t), s = c.zoom * (1 + 0.15 * t / TOTAL);
  var sw = bgItem.width * cover, sh = bgItem.height * cover, ox = W * c.x, oy = H * c.y;
  var cx = (W - sw) * c.x + sw / 2, cy = (H - sh) * c.y + sh / 2;
  return { pos: [ox + (cx - ox) * s, oy + (cy - oy) * s], scale: cover * s * 100 };
}
var times = [0, TOTAL];
if (keys.length > 1) { times = []; for (var tt = 0; tt < TOTAL; tt += 0.1) times.push(tt); times.push(TOTAL); } // sampled: the move is not linear in t
for (var n = 0; n < times.length; n++) {
  var f = frame(times[n]);
  tr(bg, "Position").setValueAtTime(times[n], f.pos);
  tr(bg, "Scale").setValueAtTime(times[n], [f.scale, f.scale]);
}

// shade: the CSS gradient (black .35 -> .15 @30% -> .85 @70% -> .95) as 3 Multiply ramps, grey = 1 - alpha
var bands = [[0, 0.3, 0.65, 0.85], [0.3, 0.7, 0.85, 0.15], [0.7, 1, 0.15, 0.05]];
for (var bi = 0; bi < bands.length; bi++) {
  var y0 = Math.round(bands[bi][0] * H), bh = Math.round(bands[bi][1] * H) - y0, g0 = bands[bi][2], g1 = bands[bi][3];
  var shade = comp.layers.addSolid([0, 0, 0], "shade" + bi, W, bh, 1);
  var ramp = shade.property("Effects").addProperty("ADBE Ramp");
  ramp.property("Start of Ramp").setValue([W / 2, 0]); ramp.property("Start Color").setValue([g0, g0, g0]);
  ramp.property("End of Ramp").setValue([W / 2, bh]); ramp.property("End Color").setValue([g1, g1, g1]);
  shade.blendingMode = BlendingMode.MULTIPLY;
  at(shade, W / 2, y0 + bh / 2);
}

// ── top bar: brand + category pill (fade + drop in); in RTL the order is mirrored ──
var top = nul("top");
var topY = 94, pillH = 72; // pill = 34px text line box + 2 x 8px padding in the HTML
if (!off(v.showBrand)) {
  var brand = text(v.brand || "", 44, 800, 1.3); brand.parent = top;
  var bR = rectOf(brand);
  at(brand, (rtl ? W - PAD : PAD) - (rtl ? bR.left + bR.width : bR.left), topY + pillH / 2 - bR.top - bR.height / 2);
  tween(brand, "Opacity", 0, 0.5 * T, 0, 100);
}
if (!off(v.showCategory)) {
  var cat = text(v.category || "", 34, 700, 1.3), cr = rectOf(cat), pw = cr.width + 56;
  var pill = rect("pill", pw, pillH, ACC, null, pillH / 2);
  pill.parent = top; cat.parent = top;
  var px = rtl ? PAD : W - PAD - pw;
  at(pill, px, topY);
  at(cat, px + 28 - cr.left, topY + pillH / 2 - cr.top - cr.height / 2);
  tween(cat, "Opacity", 0, 0.5 * T, 0, 100); tween(pill, "Opacity", 0, 0.5 * T, 0, 100);
  pill.moveAfter(cat);
}
tween(top, "Position", 0, 0.5 * T, [0, -30], [0, 0]);

// ── content block (headline, rule, bullets) moves up 380 px before the bullets ──
var content = nul("content");
tween(content, "Position", st[1] - 0.5, 0.6 * T, [0, 0], [0, -380]);
var y = 720;
var head = text(v.headline || "", num(v.headlineSize, 1, 400, 82), 800, 1.25, [BW, 420]); head.parent = content;
// the HTML block is lines x line-height tall (ink rects are shorter) and its first ink sits ~0.27em below the line-box top (measured against HyperFrames)
var hsize = num(v.headlineSize, 1, 400, 82), hlead = Math.round(hsize * 1.25);
var hr = rectOf(head), hx = PAD + BW / 2, hy = y + 0.27 * hsize - hr.top, hlines = Math.max(1, Math.round(hr.height / hlead)); // box text anchors at the box centre
at(head, hx + SX, hy);
var hp = reveal("headline", [{ l: head, max: 100 }], 0, st[1], 0.3, 0.8 * T);
tween(head, "Position", hp.start, 0.8 * T, [hx + SX, hy], [hx, hy]);
y += hlines * hlead + 36;
var rule = rect("rule", 200, 10, ACC); rule.parent = content;
at(rule, rtl ? PAD + BW : PAD, y);
if (rtl) tr(rule, "Anchor Point").setValue([200, 0]);
tween(rule, "Scale", 1.0, 0.6 * T, [0, 100], [100, 100]);
y += 10 + 56;
var bul = [v.bullet1, v.bullet2, v.bullet3], bsize = num(v.bulletSize, 1, 400, 46);
for (var b = 0; b < 3; b++) {
  var tw = BW - 70; // border 10 + padding 30 + 30
  var blead = Math.round(bsize * 1.4);
  var bt = text(bul[b] || "", bsize, 600, 1.4, [tw, 400]), br = rectOf(bt), bh2 = Math.max(1, Math.round(br.height / blead)) * blead + 44;
  var boxl = rect("b" + (b + 1) + "-bg", BW, bh2, WHITE, 10, 12);
  var bar = rect("b" + (b + 1) + "-bar", 10, bh2, ACC);
  var grp = nul("b" + (b + 1));
  boxl.parent = grp; bar.parent = grp; bt.parent = grp;
  at(boxl, PAD, y); at(bar, rtl ? PAD + BW - 10 : PAD, y);
  at(bt, (rtl ? PAD + 30 : PAD + 40) + tw / 2, y + 22 + 0.13 * bsize - br.top);
  boxl.moveAfter(bt); bar.moveAfter(bt);
  var bp = reveal("bullet" + (b + 1), [{ l: bt, max: 100 }, { l: bar, max: 100 }, { l: boxl, max: 10 }], st[1 + b], st[2 + b], st[1 + b], 0.6 * T);
  tween(grp, "Position", bp.start, 0.6 * T, [SX, 0], [0, 0]);
  grp.parent = content;
  y += bh2 + 28;
}

// ── source + progress bar ──
if (!off(v.showSource)) {
  var src = text(v.source || "", 30, 400, 1.3);
  var sr = rectOf(src);
  at(src, (rtl ? W - PAD - sr.width : PAD) - sr.left, H - 120 - sr.height - 8 - sr.top);
  tween(src, "Opacity", 1.5, 0.5 * T, 0, 80);
}
if (!off(v.showProgress)) {
  var prog = rect("progress", W, 14, ACC); at(prog, rtl ? W : 0, H - 14);
  if (rtl) tr(prog, "Anchor Point").setValue([W, 0]);
  tr(prog, "Scale").setValueAtTime(0, [0, 100]); tr(prog, "Scale").setValueAtTime(TOTAL, [100, 100]);
}

// ── outro: accent card + brand pop ──
var outro = comp.layers.addSolid(ACC, "outro", W, H, 1, sc[4]); outro.startTime = st[4];
tween(outro, "Opacity", st[4], 0.4 * T, 0, 100);
var ob = text(v.brand || "", 120, 900, 1.3, null, true);
ob.inPoint = st[4];
var obr = rectOf(ob);
at(ob, W / 2 - obr.left - obr.width / 2, H / 2 - obr.top - obr.height / 2);
tween(ob, "Scale", st[4], 0.6 * T, [85, 85], [100, 100]);
tween(ob, "Opacity", st[4], 0.4 * T, 0, 100);

// ── voice-over: renderer-aligned track (props.scenes) from 0 over the whole timeline, a manual upload keeps the 0.3s offset ──
if (v.voice) {
  var vo = comp.layers.add(app.project.importFile(new ImportOptions(new File(v.voice))));
  vo.name = "voice"; vo.startTime = aligned ? 0 : 0.3;
  vo.outPoint = Math.min(vo.outPoint, aligned ? TOTAL : TOTAL - 1.8 + 0.3);
}

writeLn("built " + comp.numLayers + " layers, " + TOTAL + "s");
