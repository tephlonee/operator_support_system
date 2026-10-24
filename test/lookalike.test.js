// lookalike.test.js
// Checks the look-alike check against the example parts, which were made as near-duplicates on purpose:
// EX-2001/EX-2002 (one corner hole fewer), EX-2003/EX-2004 (6 vs 8 bolt holes), EX-2005/EX-2006 (mirror
// images: right-hand and left-hand L-bracket), EX-2007/EX-2008 (1 vs 2 holes). Clearly different parts
// must not be flagged.

import { loadGEO } from '../src/geo-parser.js';
import { compareParts, findLookAlikes } from '../src/lookalike.js';
import { sideOf } from '../src/setup-view.js';
import { check } from './harness.js';

const BASE = '../data/parts/';
const FILES = { '1045572': '1045572.GEO', '1045574': '1045574.GEO' };
for (let i = 1; i <= 8; i++) FILES[`EX-200${i}`] = `examples/EX-200${i}.GEO`;

export async function testLookAlike() {
  const geos = new Map(await Promise.all(Object.entries(FILES).map(async ([no, f]) => [no, await loadGEO(BASE + f)])));
  const t0 = performance.now();
  const pairs = findLookAlikes(geos);
  const ms = performance.now() - t0;
  const key = p => `${p.a}/${p.b}`;
  check('Look-alikes: exactly the four near-duplicate pairs are found', pairs.map(key).join(' ') === 'EX-2001/EX-2002 EX-2003/EX-2004 EX-2005/EX-2006 EX-2007/EX-2008',
    `${pairs.map(key).join(', ')} (${Math.round(ms)} ms for ${geos.size} parts)`);
  const get = k => pairs.find(p => key(p) === k);

  // One hole fewer: one region, a hole on EX-2001, at the missing corner (370, 220).
  const p12 = get('EX-2001/EX-2002');
  const r = p12.regions[0];
  check('One hole fewer: one difference, "EX-2001 has a hole here", at the right corner',
    p12.regions.length === 1 && r.kind === 'hole' && r.has === 'A' && Math.hypot(r.a.x - 370, r.a.y - 220) < 3 && !p12.mirrored && !p12.sameOutline,
    `${r.kind} on ${r.has} at (${r.a.x}, ${r.a.y}), overlap ${p12.overlap}`);

  // 6 vs 8 bolt holes: the bolt holes that do not line up, on both parts.
  const p34 = get('EX-2003/EX-2004');
  check('6 vs 8 bolt holes: holes found on both parts', p34.regions.some(x => x.has === 'A') && p34.regions.some(x => x.has === 'B') && p34.regions.every(x => x.kind === 'hole'),
    `${p34.regions.filter(x => x.has === 'A').length} on EX-2003, ${p34.regions.filter(x => x.has === 'B').length} on EX-2004`);

  // Mirror images: detected as such; the feature is on opposite sides.
  const p56 = get('EX-2005/EX-2006');
  const sideA = sideOf(geos.get('EX-2005'), p56.regions.find(x => x.has === 'A').a);
  const sideB = sideOf(geos.get('EX-2006'), p56.regions.find(x => x.has === 'B').b);
  check('Mirror images: EX-2005/EX-2006 are reported as mirrored, with the feature on opposite sides',
    p56.mirrored && p56.overlap >= 0.98 && ((sideA === 'left' && sideB === 'right') || (sideA === 'right' && sideB === 'left')), `EX-2005: ${sideA}, EX-2006: ${sideB}`);

  // Clearly different parts.
  const far = compareParts(geos.get('1045572'), geos.get('EX-2001'));
  check('Different parts are not look-alikes, with the reason', !far.lookAlike && /size/.test(far.reason), far.reason);
  const same = compareParts(geos.get('EX-2001'), geos.get('EX-2001'));
  check('A part compared with itself: same outline, no differences', same.lookAlike && same.sameOutline && !same.regions.length, `overlap ${same.overlap}`);
  // A part turned 90° is still recognised (the comparison tries every way of laying it down).
  const turned = { ...geos.get('EX-2002'), contours: geos.get('EX-2002').contours.map(c => ({ ...c, poly: c.poly.map(p => ({ x: -p.y, y: p.x })) })) };
  const tb = turned.contours.flatMap(c => c.poly);
  turned.bbox = { minX: Math.min(...tb.map(p => p.x)), minY: Math.min(...tb.map(p => p.y)), maxX: Math.max(...tb.map(p => p.x)), maxY: Math.max(...tb.map(p => p.y)) };
  const tc = compareParts(geos.get('EX-2001'), turned);
  check('A look-alike drawn turned 90° is still found, with the same one difference', tc.lookAlike && tc.regions.length === 1 && tc.fit.rot !== 0, `fit ${tc.fit.rot}°, ${tc.regions.length} region`);
}
