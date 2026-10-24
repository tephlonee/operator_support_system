// sheet-view.js
// Draws the cut sheet from above as SVG: every part in its real position, filled with its pallet's colour
// and labelled with its part number where the laser marks it. Shows the part being worked on (yellow ring),
// the suggested part when another one is selected (dashed ring), each part's status (picked = grey,
// missing = dashed red outline, scrap = red hatching), and reports taps on parts. While sorting one pallet
// at a time, the parts of the other pallets are greyed out. Look-alike parts get a red marker on the
// feature that tells them apart. Zooms in smoothly when the current part would be too small to see or
// tap on this screen, with an overview map in the corner. The operator can also zoom by hand (buttons,
// mouse wheel, keys) and, in "move" mode (hand cursor), drag the view with the mouse or a finger; that
// view is kept while the next part is in it. It knows nothing about picking rules.
// Also draws single part pictures (the part card, the look-alike comparison).
//
// Three coordinate systems:
//   part  — mm, the part's own .GEO coordinates
//   sheet — mm, origin at the sheet's bottom-left corner, y up (the nest layout)
//   view  — mm, y down (SVG), turned/mirrored so the screen matches the operator's view of the sheet

import * as M from './matrix.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD_MM = 40;            // margin around the parts in the view
const LABEL_PX = [12, 24];    // smallest and largest part-number label on screen, in px
const CHAR_W = 0.6;           // average character width as a share of the font size
const HIT_PAD_PX = 5;         // tap area reaches this far past a part's box (into the gap to its neighbours)
const NEXT_HIT_PX = 72;       // the highlighted part can always be tapped on at least this square
const MARKER_PX = 9;          // radius of a look-alike marker on the sheet, in px
// Auto-zoom: a part counts as small when its box on screen is under SMALL_PX (long side, short side).
// The view then zooms so its long side becomes about ZOOM_TARGET_PX, but at most MAX_ZOOM times,
// so the neighbouring parts stay in view for orientation.
const SMALL_PX = [90, 40];
const ZOOM_TARGET_PX = 200;
const MAX_ZOOM = 3;
const ZOOM_MS = 450;
// Zooming by hand: each button press zooms 1.5×, up to 8× closer than the whole view.
const STEP_ZOOM = 1.5;
const MAX_MANUAL_ZOOM = 8;
const STEP_MS = 250;
const WHEEL_END_MS = 400;     // a wheel zoom counts as finished (one log row) after this long without wheel events
const DRAG_PX = 8;            // a drag in move mode is logged as a pan only after it has moved this far

// A view box [x, y, w, h] zoomed k times (k > 1 = closer) around the point `at` (view mm), which stays
// at the same place on the screen. Never wider than the overview, never more than maxZoom times closer,
// and never moved past the overview's edges.
export function zoomViewBox(vb, k, at, overview, maxZoom = MAX_MANUAL_ZOOM) {
  const w = Math.min(overview[2], Math.max(overview[2] / maxZoom, vb[2] / k));
  const s = w / vb[2];
  return clampViewBox([at.x - (at.x - vb[0]) * s, at.y - (at.y - vb[1]) * s, w, vb[3] * s], overview);
}

// Keep a view box inside the overview (centred on an axis where it is as big as the overview).
export function clampViewBox([x, y, w, h], [ox, oy, ow, oh]) {
  const fit = (v, size, o, osize) => size >= osize ? o + (osize - size) / 2 : Math.min(o + osize - size, Math.max(o, v));
  return [fit(x, w, ox, ow), fit(y, h, oy, oh), w, h];
}

// sheet → view, for a station orientation { rotation: 0/90/180/270 counter-clockwise, mirror: true/false }.
// The picture is turned first and then mirrored, so "mirror" always flips left↔right on the screen.
export function viewMatrix({ rotation = 0, mirror = false } = {}) {
  return M.multiply(M.FLIP_Y, M.multiply(mirror ? M.MIRROR_X : M.IDENTITY, M.rotation(rotation)));
}

// Which sheet edge ('bottom' | 'top' | 'left' | 'right', in sheet terms) is shown at the bottom of the screen.
// When the screen matches the operator's view, that is the edge nearest the operator.
export function nearEdge(orientation) {
  const V = viewMatrix(orientation);
  const outward = { bottom: { x: 0, y: -1 }, top: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  for (const [edge, n] of Object.entries(outward)) {
    if (V.b * n.x + V.d * n.y > 0.5) return edge; // points down on the screen
  }
  return 'bottom';
}

export class SheetView {
  constructor(svg) {
    this.svg = svg;
    this.job = null;
    this.orientation = { rotation: 0, mirror: false };
    this.fit = 'parts';        // 'parts': zoom to the parts; 'sheet': show the whole sheet (used while setting up the station)
    this.tapsEnabled = true;
    this.status = new Map();
    this.currentUid = null;
    this.suggestedUid = null;
    this.tapHandler = null;
    this.zoomSmall = true;           // station setting: zoom in on small parts
    this.zoomSuspendedFor = null;    // the operator asked to see the whole view for this part
    this.minimap = null;             // optional overview map, shown while zoomed in
    this.onZoomChange = null;        // fn(isZoomed, { canZoomIn, canZoomOut })
    this.manualBox = null;           // the view the operator zoomed to by hand (null: automatic)
    this.onUserZoom = null;          // fn({ action: 'in' | 'out' | 'fit', via }) once per finished zoom, for the test log
    this.wheel = null;               // the wheel zoom going on: { k, timer }
    this.panMode = false;            // "move" mode: dragging moves the view, taps pick nothing
    this.onPanMode = null;           // fn(on) when the mode changes
    this.drag = null;                // the drag going on in move mode
    this.animation = 0;
    this.isDim = () => false;        // uid → true for parts of other pallets (greyed out)
    this.markers = new Map();        // uid → [{ x, y, r }] look-alike markers, in the part's own mm
    // Fill colour of a part (ui.js sets this from the pallet plan) and the second label line under the
    // part number (ui.js replaces this to show the pallet and translated status words).
    this.colorOf = () => '#9aa5ab';
    this.secondLine = (part) => part.pallet ?? '';
    svg.addEventListener('click', e => {
      const hit = e.target.closest('[data-hit]');
      if (hit && this.tapHandler && this.tapsEnabled && !this.panMode) this.tapHandler(hit.dataset.hit);
    });
    svg.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    svg.addEventListener('pointerdown', e => this.onDragStart(e));
    svg.addEventListener('pointermove', e => this.onDragMove(e));
    svg.addEventListener('pointerup', e => this.onDragEnd(e));
    svg.addEventListener('pointercancel', e => this.onDragEnd(e));
    // On resize the pixels per mm change, so the zoom decision and all pixel-sized things are redone.
    new ResizeObserver(() => { if (this.overview) this.updateZoom(false); }).observe(svg);
  }

  // svg: an element for the overview map (shows the whole parts area and the zoomed-in window).
  setMinimap(svg) { this.minimap = svg; }

  setZoomSmall(on) {
    this.zoomSmall = !!on;
    if (this.overview) this.updateZoom(true);
  }

  // Show the whole view for the current part (the operator tapped the overview map or "Fit").
  showOverview() {
    this.manualBox = null;
    this.zoomSuspendedFor = this.currentUid;
    this.updateZoom(true);
  }

  // Zoom by hand. via: 'button' | 'key' (logged at once) or 'wheel' (logged when the wheel stops).
  zoomIn(via = 'button') { this.zoomBy(STEP_ZOOM, null, via); }
  zoomOut(via = 'button') { this.zoomBy(1 / STEP_ZOOM, null, via); }
  fitView(via = 'button') {
    if (!this.overview) return;
    this.showOverview();
    this.onUserZoom?.({ action: 'fit', via });
  }

  // Zoom k times around `at` (view mm; default the middle of what is shown). Zooming all the way out
  // is the same as "Fit": the whole view, without auto-zoom for this part.
  zoomBy(k, at, via) {
    if (!this.overview) return;
    const wheel = via === 'wheel';
    // Buttons start from where the view is going (so quick presses add up), the wheel from what is shown.
    const from = this.manualBox || (wheel ? this.viewBox : this.targetViewBox());
    const box = zoomViewBox(from, k, at || { x: from[0] + from[2] / 2, y: from[1] + from[3] / 2 }, this.overview);
    if (box[2] >= this.overview[2] - 1e-6) { this.manualBox = null; this.zoomSuspendedFor = this.currentUid; }
    else this.manualBox = box;
    this.updateZoom(!wheel, STEP_MS);
    if (!wheel) { this.onUserZoom?.({ action: k > 1 ? 'in' : 'out', via }); return; }
    clearTimeout(this.wheel?.timer);
    const total = (this.wheel?.k ?? 1) * k;
    this.wheel = { k: total, timer: setTimeout(() => { this.wheel = null; this.onUserZoom?.({ action: total > 1 ? 'in' : 'out', via }); }, WHEEL_END_MS) };
  }

  // Mouse wheel or a two-finger trackpad pinch (the browser reports it as a wheel with Ctrl): zoom
  // around the pointer. Never scrolls or zooms the page itself.
  onWheel(e) {
    if (!this.overview || !this.viewBox) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1); // lines/pages → px
    const k = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(this.svg.getScreenCTM().inverse());
    this.zoomBy(k, { x: p.x, y: p.y }, 'wheel');
  }

  // Move mode (hand cursor) on or off. Off again for every new job, so a screen is never left in a
  // mode where taps do nothing.
  setPanMode(on) {
    this.panMode = !!on;
    this.drag = null;
    this.svg.classList.toggle('is-pan', this.panMode);
    this.svg.classList.remove('is-dragging');
    this.onPanMode?.(this.panMode);
  }

  // Dragging in move mode: the sheet follows the pointer (mouse, finger or pen), within the limits.
  onDragStart(e) {
    if (!this.panMode || !this.viewBox || this.drag || e.button !== 0) return;
    e.preventDefault();
    this.svg.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: this.viewBox, moved: false, frame: 0 };
    this.svg.classList.add('is-dragging');
  }

  onDragMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    const rect = this.svg.getBoundingClientRect();
    const scale = Math.min(rect.width / d.from[2], rect.height / d.from[3]); // screen px per mm
    const box = clampViewBox([d.from[0] - dx / scale, d.from[1] - dy / scale, d.from[2], d.from[3]], this.overview);
    if (box[2] >= this.overview[2] - 1e-6) return; // the whole view is shown: nothing to move
    this.manualBox = box;
    // Redraw at most once per screen frame.
    if (!d.frame) d.frame = requestAnimationFrame(() => { d.frame = 0; this.updateZoom(false); });
  }

  onDragEnd(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.svg.classList.remove('is-dragging');
    cancelAnimationFrame(d.frame);
    if (!d.moved || !this.manualBox) return;
    this.updateZoom(false);
    this.onUserZoom?.({ action: 'pan', via: e.pointerType || 'mouse' });
  }

  show(job) {
    this.job = job;
    this.zoomSuspendedFor = null;
    this.setPanMode(false);
    this.render();
  }

  // No job open: an empty sheet area.
  clear() {
    cancelAnimationFrame(this.animation);
    this.job = null; this.partEls = null; this.overview = null; this.viewBox = null; this.manualBox = null;
    this.currentUid = this.suggestedUid = null;
    this.markers = new Map();
    this.svg.replaceChildren();
    this.setPanMode(false);
    if (this.minimap) this.minimap.replaceChildren();
    if (this.onZoomChange) this.onZoomChange(false);
  }

  setOrientation(orientation) {
    this.orientation = { ...this.orientation, ...orientation };
    if (this.job) this.render();
  }

  setFit(fit) {
    this.fit = fit === 'sheet' ? 'sheet' : 'parts';
    this.svg.classList.toggle('is-whole-sheet', this.fit === 'sheet');
    if (this.job) this.render();
  }

  // status: Map uid → 'open' | 'picked' | 'missing' | 'scrap'
  // currentUid: the part being worked on (yellow ring); suggestedUid: the suggested part (dashed ring if different)
  // isDim: uid → true for parts that are not on the pallet being sorted now (drawn grey)
  setState(status, currentUid, suggestedUid = currentUid, isDim = this.isDim) {
    // A view zoomed by hand stays while the new current part is in it; otherwise the view glides
    // back to the automatic one, so the yellow ring is never off screen.
    if (this.manualBox && currentUid && currentUid !== this.currentUid && !this.isInView(currentUid, this.manualBox)) this.manualBox = null;
    this.status = status;
    this.currentUid = currentUid;
    this.suggestedUid = suggestedUid;
    this.isDim = isDim;
    if (!this.partEls) return;
    for (const [uid, g] of this.partEls) {
      const dim = uid !== currentUid && this.isDim(uid);
      g.setAttribute('class', `part is-${this.status.get(uid) || 'open'}${uid === currentUid ? ' is-current' : ''}${dim ? ' is-dim' : ''}`);
    }
    if (currentUid !== this.zoomSuspendedFor) this.zoomSuspendedFor = null;
    this.updateZoom(true);
  }

  // Where the view should be: the overview, or zoomed in around a small current part.
  targetViewBox() {
    const ov = this.overview;
    const uid = this.currentUid;
    if (this.manualBox) return this.manualBox;
    if (this.fit === 'sheet' || !this.zoomSmall || !uid || uid === this.zoomSuspendedFor) return ov;
    const rect = this.svg.getBoundingClientRect();
    const scale = Math.min(rect.width / ov[2], rect.height / ov[3]);
    if (!(scale > 0)) return ov;
    const b = this.partBox(uid);
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (Math.max(w, h) * scale >= SMALL_PX[0] && Math.min(w, h) * scale >= SMALL_PX[1]) return ov;
    const k = Math.min(MAX_ZOOM, ZOOM_TARGET_PX / (Math.max(w, h) * scale));
    if (k < 1.2) return ov;
    // Always centred on the part, so it never ends up under the overview map in the corner.
    const vw = ov[2] / k, vh = ov[3] / k;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return [cx - vw / 2, cy - vh / 2, vw, vh];
  }

  // A part's box in view mm.
  partBox(uid) {
    const p = this.job.parts.find(q => q.uid === uid);
    const T = M.multiply(viewMatrix(this.orientation), p.matrix);
    return M.bounds(M.boxCorners(p.geo.bbox).map(q => M.apply(T, q)));
  }

  // Is the whole part on screen when the view box is vb?
  isInView(uid, vb) {
    if (!this.job) return false;
    const b = this.partBox(uid), v = this.visibleBox(vb);
    return b.minX >= v.x && b.maxX <= v.x + v.width && b.minY >= v.y && b.maxY <= v.y + v.height;
  }

  // What is really on screen for a view box: the screen area is usually wider (or taller) than the
  // view box, so more is visible than the box itself.
  visibleBox([x, y, w, h]) {
    const rect = this.svg.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return { x, y, width: w, height: h };
    if (rect.width / rect.height > w / h) { const w2 = h * rect.width / rect.height; x -= (w2 - w) / 2; w = w2; }
    else { const h2 = w * rect.height / rect.width; y -= (h2 - h) / 2; h = h2; }
    return { x, y, width: w, height: h };
  }

  // Move the view to where it should be: smoothly (animate, in ms) or at once.
  updateZoom(animate, ms = ZOOM_MS) {
    const target = this.targetViewBox();
    const zoomed = target !== this.overview;
    this.drawMinimap(target, zoomed);
    if (this.onZoomChange) {
      this.onZoomChange(zoomed, { canZoomIn: target[2] > this.overview[2] / MAX_MANUAL_ZOOM + 1e-6, canZoomOut: zoomed });
    }
    cancelAnimationFrame(this.animation);
    const from = this.viewBox;
    const same = from && from.every((v, i) => Math.abs(v - target[i]) < 0.5);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || same || reduce || !from) {
      this.setViewBox(target);
      this.layoutOverlay();
      return;
    }
    this.layoutOverlay(); // rings and tap areas for the new part right away
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out
      this.setViewBox(from.map((v, i) => v + (target[i] - v) * e));
      if (k < 1) this.animation = requestAnimationFrame(step);
      else this.layoutOverlay(); // labels and tap areas sized for the new zoom
    };
    this.animation = requestAnimationFrame(step);
  }

  setViewBox(vb) {
    this.viewBox = vb;
    this.svg.setAttribute('viewBox', vb.join(' '));
  }

  // The overview map: the whole parts area (the sheet drawing is reused with <use>) and the zoomed-in window.
  drawMinimap(target, zoomed) {
    const map = this.minimap;
    if (!map) return;
    map.setAttribute('viewBox', this.overview.join(' '));
    if (!zoomed) { map.replaceChildren(); return; }
    const r = this.visibleBox(target); // the marked window is what is really on screen
    map.replaceChildren(
      el('use', { href: '#sheet-layer' }),
      el('rect', { ...r, class: 'zoom-window-back' }),
      el('rect', { ...r, class: 'zoom-window' }),
    );
  }

  // fn(uid) is called when a part is tapped or clicked.
  onPartTap(fn) { this.tapHandler = fn; }

  // Look-alike markers: Map uid → [{ x, y, r }] in the part's own mm. Shown on open, highlighted parts.
  setMarkers(markers) {
    this.markers = markers || new Map();
    this.layoutOverlay();
  }

  // Colours changed (new pallet plan, or a pallet was added while sorting): redraw the parts.
  recolor() {
    if (!this.partEls) return;
    for (const p of this.job.parts) this.partEls.get(p.uid)?.firstChild?.setAttribute('fill', this.colorOf(p));
    this.layoutOverlay();
  }

  render() {
    const { job, svg } = this;
    const V = viewMatrix(this.orientation);

    // Normally fit the view to the area that has parts on it, so small parts get as big as possible.
    // While setting up the station, show the whole sheet so its edges and corners can be matched.
    const sheetBox = { minX: 0, minY: 0, maxX: job.size.w, maxY: job.size.h };
    const boxes = this.fit === 'sheet' ? [sheetBox] : job.parts.map(p => p.bbox);
    const used = M.bounds(boxes.flatMap(M.boxCorners).map(q => M.apply(V, q)));
    this.overview = [used.minX - PAD_MM, used.minY - PAD_MM, used.maxX - used.minX + 2 * PAD_MM, used.maxY - used.minY + 2 * PAD_MM];
    this.viewBox = null; // the next zoom update jumps straight to the right view
    this.manualBox = null;
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Red diagonal hatching for scrapped parts (in part mm, so it turns with the part).
    const defs = el('defs');
    const hatch = el('pattern', { id: 'scrap-hatch', patternUnits: 'userSpaceOnUse', width: 24, height: 24, patternTransform: 'rotate(45)' });
    hatch.append(el('rect', { width: 24, height: 24, class: 'hatch-bg' }), el('rect', { width: 9, height: 24, class: 'hatch-line' }));
    defs.append(hatch);

    const sheetLayer = el('g', { id: 'sheet-layer', class: 'sheet-layer', transform: M.toSVG(V) });
    sheetLayer.append(
      el('rect', { class: 'sheet', x: 0, y: 0, width: job.size.w, height: job.size.h }),
      el('path', { class: 'origin', d: 'M0,0 L80,0 L0,80 Z' }), // marks the sheet's (0,0) corner
    );
    this.partEls = new Map();
    for (const p of job.parts) {
      const g = el('g', { class: 'part', transform: M.toSVG(p.matrix), 'data-uid': p.uid });
      g.append(el('path', { d: outlinePath(p.geo), fill: this.colorOf(p), 'fill-rule': 'evenodd' }));
      if (p.boxOnly) g.classList.add('is-box-only');   // no .GEO file yet: only its box is known
      sheetLayer.append(g);
      this.partEls.set(p.uid, g);
    }
    this.ringLayer = el('g', { class: 'rings' });
    this.markerLayer = el('g', { class: 'markers' });
    this.labelLayer = el('g', { class: 'labels' });
    this.hitLayer = el('g', { class: 'hits' });
    svg.replaceChildren(defs, sheetLayer, this.ringLayer, this.markerLayer, this.labelLayer, this.hitLayer);
    this.setState(this.status, this.currentUid, this.suggestedUid);
  }

  // Everything sized in screen pixels: labels, the ring around the next part, and tap areas.
  // Redone when the window resizes, because the number of pixels per mm changes.
  layoutOverlay() {
    if (!this.job || !this.labelLayer || !this.viewBox) return;
    const rect = this.svg.getBoundingClientRect();
    const scale = Math.min(rect.width / this.viewBox[2], rect.height / this.viewBox[3]); // screen px per mm
    if (!(scale > 0)) return;
    const V = viewMatrix(this.orientation);
    const labels = [], hits = [], rings = [], markers = [];
    let currentHit = null;

    for (const p of this.job.parts) {
      const T = M.multiply(V, p.matrix);
      const box = M.bounds(M.boxCorners(p.geo.bbox).map(q => M.apply(T, q)));
      const status = this.status.get(p.uid) || 'open';
      const dim = p.uid !== this.currentUid && this.isDim(p.uid);

      // Label: upright, as close to the laser marking as possible, but inside the part's box.
      const at = M.apply(T, markCenter(p.geo));
      const fitW = 0.9 * (box.maxX - box.minX) * scale / (p.partNo.length * CHAR_W);
      const fitH = (box.maxY - box.minY) * scale / 2.4;
      const px = Math.max(LABEL_PX[0], Math.min(LABEL_PX[1], fitW, fitH));
      const fs = px / scale; // font size in view mm
      const halfW = p.partNo.length * CHAR_W * fs / 2, halfH = 1.05 * fs;
      const x = clampInside(at.x, box.minX + halfW, box.maxX - halfW);
      const y = clampInside(at.y, box.minY + halfH, box.maxY - halfH);
      const g = el('g', { class: `label is-${status}${dim ? ' is-dim' : ''}`, 'stroke-width': 3 / scale });
      g.append(
        el('text', { x, y: y - 0.45 * fs, 'font-size': fs }, p.partNo),
        el('text', { x, y: y + 0.6 * fs, 'font-size': 0.8 * fs }, this.secondLine(p, status)),
      );
      labels.push(g);

      // Rings: solid and pulsing around the current part; dashed around the suggested part if that is another one.
      const m = 10 / scale;
      const r = { x: box.minX - m, y: box.minY - m, width: box.maxX - box.minX + 2 * m, height: box.maxY - box.minY + 2 * m, rx: 10 / scale };
      if (p.uid === this.currentUid) {
        rings.push(el('g', { class: 'ring-current' }, null, [el('rect', { ...r, class: 'ring-back' }), el('rect', { ...r, class: 'ring-front' })]));
      } else if (p.uid === this.suggestedUid) {
        rings.push(el('g', { class: 'ring-suggested' }, null, [el('rect', { ...r, class: 'ring-back' }), el('rect', { ...r, class: 'ring-front' })]));
      }

      // Look-alike markers: a small red ring on each feature that tells this part from its look-alike.
      // Small and the same size on screen (the part card and the setup screen show the full circles).
      if (status === 'open' && !dim) {
        for (const m of this.markers.get(p.uid) || []) {
          const c = M.apply(T, m);
          const r = MARKER_PX / scale;
          markers.push(el('circle', { cx: c.x, cy: c.y, r, class: 'marker-back', 'stroke-width': 7 / scale }),
            el('circle', { cx: c.x, cy: c.y, r, class: 'marker', 'stroke-width': 4 / scale }));
        }
      }

      // Tap area: the part's box plus a few pixels; the current part gets a large one, drawn on top.
      const pad = HIT_PAD_PX / scale;
      const hb = { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad };
      if (p.uid === this.currentUid) currentHit = hitRect(growTo(hb, NEXT_HIT_PX / scale), p.uid);
      else hits.push(hitRect(hb, p.uid));
    }
    this.labelLayer.replaceChildren(...labels);
    this.ringLayer.replaceChildren(...rings);
    this.markerLayer.replaceChildren(...markers);
    this.hitLayer.replaceChildren(...hits, ...(currentHit ? [currentHit] : []));
  }
}

// A close-up of one part, turned the same way as on the sheet, with a yellow ring where the number is
// marked and the marked text drawn at its true size, position and angle. markers: look-alike features
// ({ x, y, r } in the part's own mm), circled in red.
export function drawPartDetail(svg, part, color, orientation, markers = []) {
  const T = M.multiply(viewMatrix(orientation), part.matrix);
  const outline = part.geo.contours.filter(c => c.kind === 'outer').flatMap(c => c.poly);
  const box = M.bounds(outline.map(q => M.apply(T, q)));
  const w = box.maxX - box.minX, h = box.maxY - box.minY, pad = 0.06 * Math.max(w, h);
  const vb = [box.minX - pad, box.minY - pad, w + 2 * pad, h + 2 * pad];
  svg.setAttribute('viewBox', vb.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / vb[2], rect.height / vb[3]) || 1;

  const shape = el('g', { transform: M.toSVG(T) });
  shape.append(el('path', { class: 'detail-part', d: outlinePath(part.geo), fill: color, 'fill-rule': 'evenodd' }));
  const nodes = [shape];
  const t = part.geo.texts[0];
  if (t) {
    const c = M.apply(T, markCenter(part.geo));
    const len = t.text.length * CHAR_W * t.height;
    const r = Math.max(len / 2 + t.height, 16 / scale);
    nodes.push(el('circle', { class: 'mark-ring-back', cx: c.x, cy: c.y, r }), el('circle', { class: 'mark-ring', cx: c.x, cy: c.y, r }));
    // Text runs along its angle from the anchor. FLIP_Y turns the glyphs upright again; if the whole
    // transform mirrors, flip the glyphs back inside the same box so they stay readable.
    let tm = M.multiply(T, M.multiply(M.translation(t.x, t.y), M.multiply(M.rotation(t.angle), M.FLIP_Y)));
    if (tm.a * tm.d - tm.b * tm.c < 0) tm = M.multiply(tm, M.multiply(M.translation(len, 0), M.MIRROR_X));
    nodes.push(el('text', { class: 'mark-text', transform: M.toSVG(tm), x: 0, y: 0, 'font-size': t.height / 0.72 }, t.text));
  }
  for (const m of markers) {
    const c = M.apply(T, m), r = Math.max(m.r, 14 / scale);
    nodes.push(el('circle', { class: 'marker-back', cx: c.x, cy: c.y, r, 'stroke-width': 8 / scale }),
      el('circle', { class: 'marker', cx: c.x, cy: c.y, r, 'stroke-width': 5 / scale }));
  }
  svg.replaceChildren(...nodes);
}

// A picture of one part in its own .GEO coordinates (seen from above, not turned), for the setup screens
// and the look-alike comparison. markers: features circled in red ({ x, y, r } in the part's mm).
export function drawPartPicture(svg, geo, { fill = '#9aa5ab', markers = [] } = {}) {
  const b = geo.bbox, w = b.maxX - b.minX, h = b.maxY - b.minY, pad = 0.08 * Math.max(w, h);
  const vb = [b.minX - pad, -b.maxY - pad, w + 2 * pad, h + 2 * pad];
  svg.setAttribute('viewBox', vb.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / vb[2], rect.height / vb[3]) || 1;
  const g = el('g', { transform: M.toSVG(M.FLIP_Y) });
  g.append(el('path', { class: `detail-part${geo.boxOnly ? ' is-box-only' : ''}`, d: outlinePath(geo), fill, 'fill-rule': 'evenodd' }));
  for (const m of markers) {
    const r = Math.max(m.r, 10 / scale);
    g.append(el('circle', { class: 'marker-back', cx: m.x, cy: m.y, r, 'stroke-width': 7 / scale }),
      el('circle', { class: 'marker', cx: m.x, cy: m.y, r, 'stroke-width': 4 / scale }));
  }
  svg.replaceChildren(g);
}

// Centre of the laser-marked text on the part (anchor = start of the text baseline).
// Parts without marked text use the middle of their box.
function markCenter(geo) {
  const t = geo.texts[0];
  if (!t) return { x: (geo.bbox.minX + geo.bbox.maxX) / 2, y: (geo.bbox.minY + geo.bbox.maxY) / 2 };
  const a = t.angle * Math.PI / 180, len = t.text.length * CHAR_W * t.height;
  return {
    x: t.x + Math.cos(a) * len / 2 - Math.sin(a) * t.height / 2,
    y: t.y + Math.sin(a) * len / 2 + Math.cos(a) * t.height / 2,
  };
}

// Keep v between lo and hi; if the range is empty (label wider than the part), use its middle.
const clampInside = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));

// Grow a box around its centre until it is at least `min` wide and high.
function growTo(b, min) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const hw = Math.max(b.maxX - b.minX, min) / 2, hh = Math.max(b.maxY - b.minY, min) / 2;
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
}

const hitRect = (b, uid) => el('rect', { class: 'hit', 'data-hit': uid, x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY });

// One SVG path with the outline and all holes; the even-odd fill rule leaves the holes open.
const pathCache = new WeakMap();
function outlinePath(geo) {
  if (!pathCache.has(geo)) {
    pathCache.set(geo, geo.contours.map(c => 'M' + c.poly.map(q => `${+q.x.toFixed(3)},${+q.y.toFixed(3)}`).join('L') + 'Z').join(''));
  }
  return pathCache.get(geo);
}

function el(tag, attrs = {}, text, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  node.append(...children);
  return node;
}
