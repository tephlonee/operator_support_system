// geo-parser.js
// Reads one TRUMPF .GEO part file (plain text, Windows-1252, mm) and returns plain data:
// the part's contours as polylines (outer outline + holes), the marked text, and the exact net area.
// The parsing logic is taken from reference/geo-viewer.html (parseGEO / buildContour), without the 3D code.

const ELEMENT_TYPES = ['LIN', 'ARC', 'CIR'];

// Fetch a .GEO file from the local server and parse it. The files are Windows-1252 ("Plåt"), not UTF-8.
export async function loadGEO(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const text = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
  return parseGEO(text, url.split('/').pop());
}

export function parseGEO(text, fileName = 'part.GEO') {
  const L = text.replace(/\r/g, '').split('\n');
  const T = i => (L[i] ?? '').trim();
  const nums = s => s.split(/\s+/).map(Number);
  const pts = {}, rawContours = [], attrs = {}, rawTexts = [];
  let info = {}, header = {}, process = '';
  let i = 0;
  while (i < L.length) {
    const s = T(i);
    if (s === '#~1') {
      header = { version: T(i + 1), bboxMin: nums(T(i + 4)), bboxMax: nums(T(i + 5)), area: parseFloat(T(i + 6)) };
      i++; continue;
    }
    if (s === '#~11') {
      info = { ident: T(i + 1), name: T(i + 2), order: T(i + 5), material: T(i + 6), thickness: parseFloat(T(i + 7)) };
      i++; continue;
    }
    if (s === '#~3') { process = T(i + 2); i++; continue; }
    if (s === '#~30') {
      i++;
      while (i < L.length && !T(i).startsWith('#~')) {
        const k = L[i].indexOf('@');
        if (k > 0) attrs[L[i].slice(0, k).trim()] = L[i].slice(k + 1).trim();
        i++;
      }
      continue;
    }
    if (s === '#~31') {
      i++;
      while (i < L.length && T(i) !== '##~~') {
        if (T(i) === 'P') {
          const id = parseInt(T(i + 1), 10);
          const c = nums(T(i + 2));
          pts[id] = { x: c[0], y: c[1] };
          i += 3;
        } else i++;
      }
      continue;
    }
    if (s === 'TXT') {
      const hs = nums(T(i + 4));
      rawTexts.push({ pt: parseInt(T(i + 2), 10), height: hs[0], angle: hs[1], text: T(i + 6) });
      i++; continue;
    }
    if (s === '#~33') {
      let j = i + 1;
      while (j < L.length && T(j) === '') j++;
      const hdr = nums(T(j));
      while (j < L.length && T(j) !== '#~331') j++;
      j++;
      const els = [];
      while (j < L.length) {
        const t = T(j);
        if (t === '') { j++; continue; }
        if (t === '##~~' || t.startsWith('#~')) break;
        if (!ELEMENT_TYPES.includes(t)) {
          throw new Error(`${fileName}: unknown contour element "${t}" on line ${j + 1}. Only LIN, ARC and CIR are supported.`);
        }
        const body = []; j++;
        while (j < L.length && T(j) !== '|~') { body.push(T(j)); j++; }
        els.push({ type: t, body });
        j++;
      }
      rawContours.push({ index: hdr[0], flag: hdr[2], els });
      i = j; continue;
    }
    i++;
  }

  if (!Object.keys(pts).length || !rawContours.length) {
    throw new Error(`${fileName}: no points or contours found. Is this a TRUMPF .GEO file?`);
  }
  const contours = rawContours.map(c => buildContour(c, pts, fileName));
  const outers = contours.filter(c => c.kind === 'outer');
  if (!outers.length) throw new Error(`${fileName}: no outer contour (flag 0) found.`);

  const texts = rawTexts.map(t => {
    const p = pts[t.pt];
    if (!p) throw new Error(`${fileName}: text "${t.text}" refers to missing point ${t.pt}.`);
    return { x: p.x, y: p.y, height: t.height, angle: t.angle, text: t.text };
  });

  const xs = outers.flatMap(c => c.poly.map(p => p.x));
  const ys = outers.flatMap(c => c.poly.map(p => p.y));
  const bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  const thickness = isFinite(info.thickness) && info.thickness > 0 ? info.thickness : null;
  const partNo = (texts[0] && texts[0].text) || fileName.replace(/\.geo$/i, '');

  return {
    fileName, partNo,
    name: attrs.BEZCH || info.name || partNo,
    info: { ...info, thickness },
    attrs, header, process, texts, contours, bbox,
    netArea: contours.reduce((s, c) => s + c.area, 0),
  };
}

// Turn a contour's element chain into a polyline, exact length and exact signed area.
function buildContour(c, pts, fileName) {
  if (!c.els.length) throw new Error(`${fileName}: contour ${c.index} has no elements.`);
  const poly = []; let length = 0, area2 = 0, segArea = 0;
  const P = id => { const p = pts[id]; if (!p) throw new Error(`${fileName}: contour ${c.index} refers to missing point ${id}.`); return p; };
  const push = p => { const last = poly[poly.length - 1]; if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) poly.push({ x: p.x, y: p.y }); };
  const chords = [];
  for (const el of c.els) {
    if (el.type === 'LIN') {
      const [a, b] = el.body[1].split(/\s+/).map(Number);
      const A = P(a), B = P(b);
      push(A); push(B); chords.push([A, B]);
      length += Math.hypot(B.x - A.x, B.y - A.y);
    } else {
      const ids = el.body[1].split(/\s+/).map(Number);
      let C, S, E, dir, r;
      if (el.type === 'ARC') {
        C = P(ids[0]); S = P(ids[1]); E = P(ids[2]); dir = parseInt(el.body[2], 10) || 1;
        r = Math.hypot(S.x - C.x, S.y - C.y);
      } else {
        // CIR: center point id, then radius. 1045574.GEO has no direction line here.
        C = P(ids[0]); r = parseFloat(el.body[2]); dir = parseInt(el.body[3], 10) || 1;
        if (!(r > 0)) throw new Error(`${fileName}: circle in contour ${c.index} has no valid radius.`);
        S = E = { x: C.x + r, y: C.y };
      }
      const a0 = Math.atan2(S.y - C.y, S.x - C.x);
      const a1 = Math.atan2(E.y - C.y, E.x - C.x);
      let sweep = a1 - a0;
      if (dir > 0) { while (sweep <= 1e-12) sweep += 2 * Math.PI; }
      else { while (sweep >= -1e-12) sweep -= 2 * Math.PI; }
      const n = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 64)));
      push(S);
      for (let k = 1; k <= n; k++) {
        const a = a0 + sweep * k / n;
        push(k === n ? E : { x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
      }
      chords.push([S, E]);
      length += r * Math.abs(sweep);
      segArea += 0.5 * r * r * (sweep - Math.sin(sweep));
    }
  }
  const first = poly[0], last = poly[poly.length - 1];
  if (poly.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) poly.pop();
  for (const [A, B] of chords) area2 += A.x * B.y - B.x * A.y;
  let area = area2 / 2 + segArea;

  // Outer contours count positive, holes negative. A CIR has no direction, so a round hole
  // comes out positive (as in 1045574.GEO); the contour's own outer/hole flag decides instead.
  const kind = c.flag === 1 ? 'hole' : 'outer';
  if ((kind === 'outer') !== (area > 0)) { poly.reverse(); area = -area; }
  return { index: c.index, kind, poly, length, area };
}
