// geo-parser.test.js
// Checks the .GEO parser against the two real Brålanda parts, where the right answers
// are known: the net area written in each file's header and the number of holes.
// Also checks the invented example parts, and draws every part for a visual check.

import { loadGEO, parseGEO } from '../src/geo-parser.js';
import { check, near } from './harness.js';

async function testPart(path, expect) {
  const p = await loadGEO('../data/parts/' + path);
  const file = p.fileName;
  const outers = p.contours.filter(c => c.kind === 'outer').length;
  const holes = p.contours.filter(c => c.kind === 'hole').length;
  if (expect.area) {
    check(`${file}: net area is ${expect.area} mm² (±0.01)`, near(p.netArea, expect.area, 0.01), `computed ${p.netArea.toFixed(3)} mm²`);
  }
  check(`${file}: computed area matches the file header`, near(p.netArea, p.header.area, 0.01),
    `computed ${p.netArea.toFixed(3)}, header ${p.header.area.toFixed(3)} mm²`);
  check(`${file}: 1 outer contour + ${expect.holes} holes`, outers === 1 && holes === expect.holes, `found ${outers} outer + ${holes} holes`);
  const t = p.texts[0];
  check(`${file}: marked text "${expect.text}" at ${expect.angle}°`, t && t.text === expect.text && t.angle === expect.angle,
    t ? `"${t.text}" at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}), ${t.angle}°, ${t.height} mm high` : 'no text found');
  check(`${file}: thickness 8 mm, ident "Plåt 8mm" (Windows-1252 read correctly)`, p.info.thickness === 8 && p.info.ident === 'Plåt 8mm',
    `${p.info.thickness} mm, "${p.info.ident}"`);
  if (expect.example) check(`${file}: marked as an invented example`, p.attrs.EXAMPLE === '1', `EXAMPLE=${p.attrs.EXAMPLE}`);
  return p;
}

async function testUnknownElement() {
  const text = new TextDecoder('windows-1252').decode(await (await fetch('../data/parts/1045572.GEO')).arrayBuffer());
  const broken = text.replace(/\nLIN\r?\n/, '\nSPL\n');
  try {
    parseGEO(broken, 'broken.GEO');
    check('Unknown element type stops with a clear message', false, 'no error was raised');
  } catch (e) {
    check('Unknown element type stops with a clear message', /unknown contour element "SPL"/.test(e.message), e.message);
  }
}

// Returns the loaded parts, for the drawings.
export async function testGeoParser() {
  const parts = [];
  parts.push(await testPart('1045572.GEO', { area: 13818.84, holes: 4, text: '1045572', angle: 90 }));
  parts.push(await testPart('1045574.GEO', { area: 62502.80, holes: 3, text: '1045574', angle: 0 }));
  await testUnknownElement();
  const examples = { 'EX-2001': 5, 'EX-2002': 4, 'EX-2003': 7, 'EX-2004': 9, 'EX-2005': 3, 'EX-2006': 3, 'EX-2007': 1, 'EX-2008': 2 };
  for (const [no, holes] of Object.entries(examples)) {
    parts.push(await testPart(`examples/${no}.GEO`, { holes, text: no, angle: 0, example: true }));
  }
  return parts;
}

// A small top-down drawing of each part: outline and holes in one path, holes cut out by the even-odd rule.
export function renderGallery(parts) {
  document.getElementById('gallery').innerHTML = parts.map(p => {
    const { minX, minY, maxX, maxY } = p.bbox;
    const w = maxX - minX, h = maxY - minY, pad = Math.max(w, h) * 0.04;
    const d = p.contours.map(c => 'M' + c.poly.map(q => `${q.x.toFixed(2)},${(-q.y).toFixed(2)}`).join('L') + 'Z').join('');
    const t = p.texts[0];
    const dot = t ? `<circle cx="${t.x}" cy="${-t.y}" r="${pad * 0.6}" class="anchor"/>` : '';
    const real = p.attrs.EXAMPLE !== '1';
    return `<figure>
      <svg viewBox="${minX - pad} ${-maxY - pad} ${w + 2 * pad} ${h + 2 * pad}" role="img" aria-label="Drawing of part ${p.partNo}">
        <path d="${d}" fill-rule="evenodd" class="part"/>${dot}</svg>
      <figcaption><b>${p.partNo}</b> <span class="tag ${real ? 'real' : 'ex'}">${real ? 'REAL' : 'EXAMPLE'}</span><br>
        ${p.name}<br>${w.toFixed(0)} × ${h.toFixed(0)} mm · ${p.contours.length - 1} holes · ${(p.netArea / 100).toFixed(1)} cm²</figcaption>
    </figure>`;
  }).join('');
}
