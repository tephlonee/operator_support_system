// projector-3d.js
// The geometry behind the laser projector concept (tools/projector-3d.html), with no 3D and no screen code:
// which lines a projector would draw for one pallet, and how long they are.
//
// For each piece of the active pallet the projector draws its outline a few mm INSIDE the part's outer
// contour: the cut line itself is a gap the beam would fall through. Instead of an outline it can draw
// a small cross in the middle of the piece. The total line length per image matters, because a galvo
// projector redraws the whole image many times a second: the longer the lines, the more the image flickers.
//
// All in mm, in sheet coordinates (origin bottom-left), using the placement from nest-loader.js.
// This is a concept, not an optical simulation.

import * as M from './matrix.js';
import { PalletPlan } from './plan.js';
import { t } from './i18n.js';

// ---------- small polygon helpers ----------

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

export function pathLength(poly, closed = true) {
  let s = 0;
  const n = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += Math.hypot(b.x - a.x, b.y - a.y); }
  return s;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Shortest distance from a point to the polygon's edges.
export function distanceToEdges(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const u = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy)));
  }
  return best;
}

// Counter-clockwise, without repeated or collinear points.
function clean(poly) {
  let pts = poly.filter((p, i) => { const q = poly[(i + 1) % poly.length]; return Math.hypot(q.x - p.x, q.y - p.y) > 1e-3; });
  if (signedArea(pts) < 0) pts = [...pts].reverse();
  return pts.filter((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-6;
  });
}

// ---------- the inset outline ----------

// The outline moved `d` mm inwards. Each edge is moved along its inward normal and neighbours are joined
// where their moved lines meet. Edges that would turn round (a rounded corner or a notch smaller than the
// inset) are dropped and their neighbours joined directly, so small features are simply smoothed away.
// Returns null when nothing is left (a part narrower than twice the inset).
export function insetPolygon(poly, d) {
  const pts = clean(poly);
  if (pts.length < 3) return null;
  if (!(d > 0)) return pts;
  let lines = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length], len = Math.hypot(b.x - a.x, b.y - a.y);
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    return { p: { x: a.x - dir.y * d, y: a.y + dir.x * d }, dir };   // inward = left of a CCW edge
  });
  const meet = (l1, l2) => {
    const cross = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;
    if (Math.abs(cross) < 1e-9) return { ...l2.p };
    const s = ((l2.p.x - l1.p.x) * l2.dir.y - (l2.p.y - l1.p.y) * l2.dir.x) / cross;
    return { x: l1.p.x + s * l1.dir.x, y: l1.p.y + s * l1.dir.y };
  };
  for (let guard = 0; guard < pts.length * 2 && lines.length >= 3; guard++) {
    const verts = lines.map((l, i) => meet(lines[(i - 1 + lines.length) % lines.length], l));
    // An edge turned round: its end lies behind its start along its own direction.
    let worst = -1, worstT = -1e-9;
    lines.forEach((l, i) => {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const tt = (b.x - a.x) * l.dir.x + (b.y - a.y) * l.dir.y;
      if (tt < worstT) { worstT = tt; worst = i; }
    });
    if (worst < 0) return signedArea(verts) > 0 ? verts : null;
    lines = lines.filter((_, i) => i !== worst);
  }
  return null;
}

// ---------- what the projector draws for one piece ----------

// The piece's outer contour(s) on the sheet, counter-clockwise.
export function outerOnSheet(part) {
  return part.geo.contours.filter(c => c.kind === 'outer').map(c => clean(c.poly.map(q => M.apply(part.matrix, q))));
}

// A point well inside the polygon: the middle of the longest horizontal chord through the centre of its box.
export function innerPoint(poly) {
  const b = M.bounds(poly), y = (b.minY + b.maxY) / 2 + 1e-6, xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    if ((a.y > y) !== (c.y > y)) xs.push(a.x + (y - a.y) * (c.x - a.x) / (c.y - a.y));
  }
  xs.sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  return best ? { x: (best[0] + best[1]) / 2, y } : { x: (b.minX + b.maxX) / 2, y };
}

// A cross in the middle of the piece: two lines, each at most 60 mm and at most a third of the piece's size.
export function crossMarker(poly) {
  const b = M.bounds(poly), c = innerPoint(poly);
  const r = Math.min(30, (b.maxX - b.minX) / 6, (b.maxY - b.minY) / 6);
  return [[{ x: c.x - r, y: c.y }, { x: c.x + r, y: c.y }], [{ x: c.x, y: c.y - r }, { x: c.x, y: c.y + r }]];
}

// The lines for one piece: { paths: [{ points, closed }], length } in mm.
// mode 'outline' = the outer contour moved `inset` mm inwards; 'cross' = a cross in the middle.
export function pieceLines(part, { inset = 3, mode = 'outline' } = {}) {
  const paths = [];
  for (const outer of outerOnSheet(part)) {
    if (mode === 'cross') crossMarker(outer).forEach(points => paths.push({ points, closed: false }));
    else { const points = insetPolygon(outer, inset); if (points) paths.push({ points, closed: true }); }
  }
  return { uid: part.uid, paths, length: paths.reduce((s, p) => s + pathLength(p.points, p.closed), 0) };
}

// ---------- pallets ----------

// The pallets as the app proposes them for this job (one per order), with number, colour and name,
// and which pallet every piece goes to.
export function proposedPallets(job) {
  const plan = new PalletPlan(job);
  plan.propose();
  const of = plan.assignPieces();
  const pallets = plan.view.map(p => ({ id: p.id, num: p.num, key: p.key, hex: p.hex, ink: p.ink,
    name: t('palletLabel', { colour: t(`colour_${p.key}`), num: p.num }) }));
  return { pallets, palletOf: uid => of.get(uid) };
}

// Everything the projector draws for one pallet: { pieces: [pieceLines], length } (mm).
export function palletLines(job, palletOf, palletId, opts) {
  const pieces = job.parts.filter(p => palletOf(p.uid) === palletId).map(p => pieceLines(p, opts));
  return { pieces, length: pieces.reduce((s, p) => s + p.length, 0) };
}

// The image against the projector's budget (metres of line it can draw without visible flicker).
export function budgetCheck(lengthMm, budgetM) {
  const ratio = budgetM > 0 ? lengthMm / 1000 / budgetM : Infinity;
  return { metres: lengthMm / 1000, ratio, over: ratio > 1 };
}
