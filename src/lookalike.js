// lookalike.js
// Finds the parts in a job that are easy to mix up ("look-alikes") and works out where they differ,
// using only the outlines from the .GEO files (no camera). No screen code.
//
// How it works, in plain terms:
//   1. Quick check: two parts can only be look-alikes if their size, area and number of holes are close.
//   2. Overlap: lay one part on top of the other in every way it could be turned over or round
//      (0/90/180/270°, with and without mirroring), lined up at each corner and at the centre,
//      and keep the position where they cover each other best. The share of shared material
//      (intersection ÷ union) is the overlap. Above LIMITS.overlap the pair counts as look-alikes.
//   3. Difference: in that position, the material that only one of the two has is the distinguishing
//      feature: an extra hole, a notch, a longer leg. Each separate patch becomes one "region",
//      stored in both parts' own coordinates, so the screen can circle it on either part.
//   4. Mirror: if the best fit needs mirroring and is (almost) perfect, the parts are mirror images.
//      The feature is then taken from the best fit without mirroring, which is how the operator
//      would hold them side by side, so the screen can say on which side the feature sits.
//
// The outlines are compared on a fine grid (about GRID_CELLS cells along the long side, never finer
// than MIN_CELL_MM). That is the same idea as a polygon overlay (e.g. Shapely's intersection and
// difference) but needs no library, and is exact enough to find and circle features of a few mm.

export const LIMITS = Object.freeze({
  size: 0.8,        // both box sides within 80 % of each other (after turning)
  area: 0.75,       // net areas within 75 % of each other
  holes: 3,         // at most this many holes more or fewer
  overlap: 0.85,    // intersection ÷ union in the best position: look-alike from here
  mirror: 0.98,     // a mirrored fit this good means "mirror image"
  same: 0.995,      // a fit this good without mirroring means "same outline"
});
const GRID_CELLS = 360;
const MIN_CELL_MM = 0.5;

// Turning over and round: x' = a·x + c·y, y' = b·x + d·y. det < 0 means mirrored.
const SYMMETRIES = [
  { a: 1, b: 0, c: 0, d: 1, rot: 0, mirror: false },
  { a: 0, b: 1, c: -1, d: 0, rot: 90, mirror: false },
  { a: -1, b: 0, c: 0, d: -1, rot: 180, mirror: false },
  { a: 0, b: -1, c: 1, d: 0, rot: 270, mirror: false },
  { a: -1, b: 0, c: 0, d: 1, rot: 0, mirror: true },
  { a: 0, b: -1, c: -1, d: 0, rot: 90, mirror: true },
  { a: 1, b: 0, c: 0, d: -1, rot: 180, mirror: true },
  { a: 0, b: 1, c: 1, d: 0, rot: 270, mirror: true },
];
const ANCHORS = ['min-min', 'max-max', 'min-max', 'max-min', 'centre'];

// The parts of a parsed .GEO file this module needs.
export function shapeOf(geo) {
  const outers = geo.contours.filter(c => c.kind === 'outer').map(c => c.poly);
  const holes = geo.contours.filter(c => c.kind === 'hole').map(c => c.poly);
  const b = geo.bbox;
  return { outers, holes, bbox: b, w: b.maxX - b.minX, h: b.maxY - b.minY, area: geo.netArea, holeCount: holes.length };
}

// Compare two parsed .GEO files. Returns { lookAlike, overlap, mirrored, sameOutline, regions, reason }.
export function compareParts(geoA, geoB) {
  const A = shapeOf(geoA), B = shapeOf(geoB);
  const reason = quickCheck(A, B);
  if (reason) return { lookAlike: false, overlap: 0, mirrored: false, sameOutline: false, regions: [], reason };

  let best = null, bestProper = null, bestSideBySide = null;
  for (const s of SYMMETRIES) {
    for (const anchor of ANCHORS) {
      const fit = { ...placeB(A, B, s, anchor), sym: s, anchor };
      fit.overlap = overlapOf(A, B, fit);
      if (!best || fit.overlap > best.overlap + 1e-9) best = fit;
      if (!s.mirror && (!bestProper || fit.overlap > bestProper.overlap + 1e-9)) bestProper = fit;
      // Held the same way up, side by side (not mirrored, not turned a quarter): how an operator compares them.
      if (!s.mirror && s.rot % 180 === 0 && (!bestSideBySide || fit.overlap > bestSideBySide.overlap + 1e-9)) bestSideBySide = fit;
    }
  }
  // Mirror image: the mirrored fit is (almost) perfect and clearly better than any fit without mirroring.
  const mirrored = best.sym.mirror && best.overlap >= LIMITS.mirror && best.overlap - bestProper.overlap > 0.005;
  const lookAlike = best.overlap >= LIMITS.overlap;
  const shown = mirrored ? bestSideBySide : best;
  const regions = lookAlike ? differenceRegions(A, B, shown) : [];
  return {
    lookAlike, overlap: round(best.overlap, 4), mirrored,
    sameOutline: lookAlike && !mirrored && best.overlap >= LIMITS.same && !regions.length, // only the marked number tells them apart
    fit: { rot: shown.sym.rot, mirror: shown.sym.mirror, anchor: shown.anchor },
    regions,
    reason: lookAlike ? '' : `overlap ${round(best.overlap, 3)} < ${LIMITS.overlap}`,
  };
}

// All look-alike pairs among the part numbers of a job. geos: Map partNo → parsed .GEO (null = no outline).
export function findLookAlikes(geos) {
  const nos = [...geos.keys()].filter(no => geos.get(no)).sort();
  const pairs = [];
  nos.forEach((a, i) => nos.slice(i + 1).forEach(b => {
    const c = compareParts(geos.get(a), geos.get(b));
    if (c.lookAlike) pairs.push({ a, b, ...c });
  }));
  return pairs;
}

// ---------- step 1: quick check ----------

function quickCheck(A, B) {
  const [la, sa] = [Math.max(A.w, A.h), Math.min(A.w, A.h)];
  const [lb, sb] = [Math.max(B.w, B.h), Math.min(B.w, B.h)];
  if (ratio(la, lb) < LIMITS.size || ratio(sa, sb) < LIMITS.size) return `size ${r0(A.w)}×${r0(A.h)} vs ${r0(B.w)}×${r0(B.h)} mm`;
  if (ratio(A.area, B.area) < LIMITS.area) return `area ${r0(A.area)} vs ${r0(B.area)} mm²`;
  if (Math.abs(A.holeCount - B.holeCount) > LIMITS.holes) return `holes ${A.holeCount} vs ${B.holeCount}`;
  return '';
}

// ---------- step 2: lay B on A ----------

// Where B goes: turned/mirrored by s, then moved so the chosen corner (or centre) of its box meets A's.
function placeB(A, B, s, anchor) {
  const tb = boxOf(boxCorners(B.bbox).map(p => turn(s, p)));
  const pick = (box, which, axis) => which === 'min' ? box[`min${axis}`] : box[`max${axis}`];
  let tx, ty;
  if (anchor === 'centre') {
    tx = (A.bbox.minX + A.bbox.maxX) / 2 - (tb.minX + tb.maxX) / 2;
    ty = (A.bbox.minY + A.bbox.maxY) / 2 - (tb.minY + tb.maxY) / 2;
  } else {
    const [wx, wy] = anchor.split('-');
    tx = pick(A.bbox, wx, 'X') - pick(tb, wx, 'X');
    ty = pick(A.bbox, wy, 'Y') - pick(tb, wy, 'Y');
  }
  return { tx, ty };
}

const turn = (s, p) => ({ x: s.a * p.x + s.c * p.y, y: s.b * p.x + s.d * p.y });
const placeOnA = (fit, p) => { const q = turn(fit.sym, p); return { x: q.x + fit.tx, y: q.y + fit.ty }; };
// From A's coordinates back to B's own: undo the move, then the turn (inverse of an orthogonal matrix = transpose).
function backToB(fit, p) {
  const x = p.x - fit.tx, y = p.y - fit.ty, s = fit.sym;
  return { x: s.a * x + s.b * y, y: s.c * x + s.d * y };
}

function overlapOf(A, B, fit) {
  const g = gridFor(A, B, fit);
  const ra = raster([...A.outers, ...A.holes], g);
  const rb = raster([...B.outers, ...B.holes].map(poly => poly.map(p => placeOnA(fit, p))), g);
  let both = 0, either = 0;
  for (let i = 0; i < ra.length; i++) { both += ra[i] & rb[i]; either += ra[i] | rb[i]; }
  return either ? both / either : 0;
}

// ---------- step 3: where they differ ----------

function differenceRegions(A, B, fit) {
  const g = gridFor(A, B, fit);
  const bPolys = poly => poly.map(p => placeOnA(fit, p));
  const ra = raster([...A.outers, ...A.holes], g);
  const rb = raster([...B.outers, ...B.holes].map(bPolys), g);
  const outerA = raster(A.outers, g);              // inside A's outline (holes included)
  const outerB = raster(B.outers.map(bPolys), g);
  const cellArea = g.cell * g.cell;
  const minArea = Math.max(6 * cellArea, 0.002 * Math.min(A.area, B.area));
  const regions = [];
  for (const [mine, theirs, outerTheirs, owner] of [[ra, rb, outerB, 'A'], [rb, ra, outerA, 'B']]) {
    const only = open(mine.map((v, i) => v & ~theirs[i] & 1), g);
    for (const cells of components(only, g)) {
      const area = cells.length * cellArea;
      if (area < minArea) continue;
      // Material only `owner` has. If that spot is inside the other part's outline, the other part
      // has a hole (or cut-out) there; otherwise `owner` simply reaches further (longer, an extra tab).
      const inside = cells.filter(i => outerTheirs[i]).length / cells.length;
      const holeOnOther = inside > 0.5;
      const pts = cells.map(i => ({ x: g.x0 + (i % g.nx + 0.5) * g.cell, y: g.y0 + (Math.floor(i / g.nx) + 0.5) * g.cell }));
      const box = boxOf(pts);
      const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      const r = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2 + g.cell;
      const other = owner === 'A' ? 'B' : 'A';
      regions.push({
        kind: holeOnOther ? 'hole' : 'extra',          // 'hole': `has` has a hole here; 'extra': `has` has extra material here
        has: holeOnOther ? other : owner,              // which part shows the feature
        area: round(area, 1),
        a: { ...roundPt(c), r: round(r, 2) },          // centre and radius in A's own coordinates
        b: { ...roundPt(backToB(fit, c)), r: round(r, 2) },   // the same spot in B's own coordinates
      });
    }
  }
  return regions.sort((p, q) => q.area - p.area);
}

// Morphological opening (shrink by one cell, then grow back): removes slivers one cell thin,
// which come from sampling slanted edges, not from real features.
function open(mask, g) {
  const at = (m, x, y) => x >= 0 && y >= 0 && x < g.nx && y < g.ny ? m[y * g.nx + x] : 0;
  const shrink = new Uint8Array(mask.length), grow = new Uint8Array(mask.length);
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    shrink[y * g.nx + x] = at(mask, x, y) & at(mask, x - 1, y) & at(mask, x + 1, y) & at(mask, x, y - 1) & at(mask, x, y + 1);
  }
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    grow[y * g.nx + x] = at(shrink, x, y) | at(shrink, x - 1, y) | at(shrink, x + 1, y) | at(shrink, x, y - 1) | at(shrink, x, y + 1);
  }
  return grow;
}

// Groups of touching cells (4-neighbourhood), each a list of cell indices.
function components(mask, g) {
  const seen = new Uint8Array(mask.length), out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells = [], stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(); cells.push(i);
      const x = i % g.nx, y = Math.floor(i / g.nx);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= g.nx || ny >= g.ny) continue;
        const j = ny * g.nx + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push(cells);
  }
  return out;
}

// ---------- the grid ----------

// A grid covering A and B in its placed position, a cell or two of margin all round.
function gridFor(A, B, fit) {
  const pb = boxOf(boxCorners(B.bbox).map(p => placeOnA(fit, p)));
  const box = { minX: Math.min(A.bbox.minX, pb.minX), minY: Math.min(A.bbox.minY, pb.minY), maxX: Math.max(A.bbox.maxX, pb.maxX), maxY: Math.max(A.bbox.maxY, pb.maxY) };
  const cell = Math.max(MIN_CELL_MM, Math.max(box.maxX - box.minX, box.maxY - box.minY) / GRID_CELLS);
  const x0 = box.minX - 2 * cell, y0 = box.minY - 2 * cell;
  return { x0, y0, cell, nx: Math.ceil((box.maxX - box.minX) / cell) + 4, ny: Math.ceil((box.maxY - box.minY) / cell) + 4 };
}

// 1 where the cell centre is inside the polygons (even-odd rule: a hole inside an outline is outside),
// filled one row at a time.
function raster(polys, g) {
  const out = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    const y = g.y0 + (j + 0.5) * g.cell;
    const xs = [];
    for (const poly of polys) {
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k], q = poly[(k + 1) % poly.length];
        if ((p.y <= y) !== (q.y <= y)) xs.push(p.x + (y - p.y) * (q.x - p.x) / (q.y - p.y));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) out[j * g.nx + i] ^= 1;
    }
  }
  return out;
}

// ---------- small helpers ----------

const ratio = (p, q) => Math.min(p, q) / Math.max(p, q);
const r0 = v => Math.round(v);
const round = (v, n) => +v.toFixed(n);
const roundPt = p => ({ x: round(p.x, 2), y: round(p.y, 2) });
const boxCorners = b => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
function boxOf(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
