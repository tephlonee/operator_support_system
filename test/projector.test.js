// projector.test.js
// Checks the geometry of the laser projector concept (src/projector-3d.js): the outline drawn a few mm
// inside a part really lies inside it, and the line length per pallet is computed and adds up.

import { loadJob } from '../src/nest-loader.js';
import { insetPolygon, outerOnSheet, pieceLines, pointInPolygon, distanceToEdges, pathLength,
         proposedPallets, palletLines, budgetCheck } from '../src/projector-3d.js';
import { check } from './harness.js';
import { EXAMPLE_JOB, J14_JOB } from './fixtures.js';

export async function testProjector() {
  // The real part 1045572 (from J14): its outline 3 mm inside the outer contour.
  const j14 = await loadJob(J14_JOB);
  const piece = j14.parts.find(p => p.partNo === '1045572');
  const [outer] = outerOnSheet(piece);
  const lines = pieceLines(piece, { inset: 3 });
  const pts = lines.paths.flatMap(p => p.points);
  const inside = pts.every(p => pointInPolygon(p, outer));
  const minGap = Math.min(...pts.map(p => distanceToEdges(p, outer)));
  check('Projector: the inset outline of 1045572 lies inside its outer contour, 3 mm in',
    lines.paths.length === 1 && inside && minGap > 2.99, `${pts.length} points, all inside: ${inside}, closest to the cut line ${minGap.toFixed(2)} mm`);
  const outerLen = pathLength(outer), inLen = lines.length;
  check('Projector: the inset outline is a little shorter than the part outline',
    inLen < outerLen && inLen > outerLen - 8 * 2 * 3, `${inLen.toFixed(1)} mm vs ${outerLen.toFixed(1)} mm`);
  check('Projector: a part narrower than twice the inset gets no outline', insetPolygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 50 }, { x: 0, y: 50 }], 3) === null, '');

  // Every piece of the example sheet (turned and mirrored parts included): outline inside, or a cross inside.
  const ex = await loadJob(EXAMPLE_JOB);
  const bad = ex.parts.filter(p => {
    const o = outerOnSheet(p)[0], l = pieceLines(p, { inset: 3 }), c = pieceLines(p, { mode: 'cross' });
    return !l.paths.length || ![...l.paths, ...c.paths].flatMap(q => q.points).every(q => pointInPolygon(q, o));
  });
  check('Projector: every example piece gets an inset outline and a cross, both inside the piece', !bad.length,
    bad.length ? bad.map(p => p.uid).join(', ') : `${ex.parts.length} pieces`);

  // Line length per pallet, and all pallets together.
  const { pallets, palletOf } = proposedPallets(ex);
  const per = pallets.map(pl => palletLines(ex, palletOf, pl.id, { inset: 3 }));
  const all = ex.parts.reduce((s, p) => s + pieceLines(p, { inset: 3 }).length, 0);
  check('Projector: the outline length per pallet is the sum of its pieces',
    per.every(r => r.length > 0 && Math.abs(r.length - r.pieces.reduce((s, q) => s + q.length, 0)) < 1e-6),
    pallets.map((pl, i) => `${pl.name}: ${(per[i].length / 1000).toFixed(2)} m`).join(' · '));
  check('Projector: the pallets together give the total for the whole sheet',
    Math.abs(per.reduce((s, r) => s + r.length, 0) - all) < 1e-6 && per.reduce((s, r) => s + r.pieces.length, 0) === ex.parts.length,
    `${(all / 1000).toFixed(2)} m for ${ex.parts.length} pieces`);
  const b = budgetCheck(all, 15);
  check('Projector: the budget check compares metres of line with the projector budget',
    Math.abs(b.metres - all / 1000) < 1e-9 && b.over === all / 1000 > 15, `${b.metres.toFixed(2)} m of 15 m → ${(b.ratio * 100).toFixed(0)} %`);
}
