// nest-loader.js
// The one place that knows the job formats: which sheet, which orders, and where each part sits.
// Two formats are read:
//   • TRUMPF .LST (the NC program list from TruTops Boost, e.g. data/jobs/J14.LST): the real format.
//     It has the sheet size and material, every part's position and angle on the sheet, and the order
//     each part belongs to. The part outlines come from the .GEO files in data/parts/.
//   • The temporary JSON in data/jobs/ (described in CLAUDE.md), used for the invented example sheet.
// The rest of the app only uses the job object that loadJob() returns, so nothing else has to change
// when another format is added. Which pallet a part goes to is NOT in the job any more: the operator
// decides that at the start of the job (see plan.js).

import { loadGEO } from './geo-parser.js';
import * as M from './matrix.js';

export const JOB_INDEX = 'data/jobs/index.json';

// The jobs the operator can choose from: [{ file, url, title, note }]. data/jobs/index.json lists them.
export async function loadJobIndex(url = JOB_INDEX) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the job list ${url} (HTTP ${res.status})`);
  const list = await res.json();
  if (!Array.isArray(list.jobs)) throw new Error(`${url}: no "jobs" list`);
  return list.jobs.map(j => ({ ...j, url: new URL(j.file, new URL(url, location.href)).href }));
}

export async function loadJob(url, { loadPart = loadGEO } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load job ${url} (HTTP ${res.status})`);
  // Part files live in data/parts/, next to data/jobs/.
  const partsBase = new URL('../parts/', new URL(url, location.href)).href;
  if (/\.lst$/i.test(url)) return jobFromLST(await res.text(), partsBase, loadPart, url.split('/').pop());
  let json;
  try { json = await res.json(); } catch (e) { throw new Error(`${url} is not valid JSON: ${e.message}`); }
  return jobFromJSON(json, partsBase, loadPart);
}

// Where a part lands on the sheet: mirror about its own Y axis, then rotate counter-clockwise
// about its own origin, then move its origin to (x, y). Sheet origin is the bottom-left corner.
export function placementMatrix(x, y, rot = 0, mirror = false) {
  return M.multiply(M.translation(x, y), M.multiply(M.rotation(rot), mirror ? M.MIRROR_X : M.IDENTITY));
}

// ---------- the temporary JSON format ----------

export async function jobFromJSON(json, partsBase, loadPart = loadGEO) {
  const need = (ok, msg) => { if (!ok) throw new Error(`Job ${json.sheet ?? '(no name)'}: ${msg}`); };
  need(Array.isArray(json.size) && json.size.length === 2, 'missing "size": [width, height] in mm');
  need(Array.isArray(json.parts) && json.parts.length, 'no parts');
  // Older job files gave each part a pallet with an order; the order is what counts now.
  const palletOrder = new Map((json.pallets || []).map(p => [p.id, p.order]));
  const uids = new Set();
  for (const p of json.parts) {
    need(p.uid && !uids.has(p.uid), `part id "${p.uid}" is missing or used twice`);
    uids.add(p.uid);
    need(typeof (p.order ?? palletOrder.get(p.pallet)) === 'string', `part ${p.uid} has no order`);
    need(typeof p.geo === 'string' && p.geo, `part ${p.uid} has no .GEO file`);
    need(isFinite(p.x) && isFinite(p.y), `part ${p.uid} has no valid x, y position`);
  }
  const files = [...new Set(json.parts.map(p => p.geo))];
  const geoByFile = new Map(await Promise.all(files.map(async f => [f, await loadPart(partsBase + f)])));
  const placed = json.parts.map(p => ({
    uid: p.uid, partNo: p.partNo, order: p.order ?? palletOrder.get(p.pallet),
    x: p.x, y: p.y, rot: p.rot || 0, mirror: !!p.mirror, geo: geoByFile.get(p.geo),
  }));
  return makeJob({
    id: json.sheet, size: { w: json.size[0], h: json.size[1] }, thickness: json.thickness, material: json.material,
    example: json.example === true, note: json.note || '', source: 'json',
  }, placed);
}

// ---------- TRUMPF .LST ----------

// Read an .LST file into its tables: { NAME: { columns: Map(id → column index), rows: [[values]] } }.
// A table starts with BEGIN_NAME and ends with ENDE_NAME. "MM,AT" lines name the columns (each has a
// fixed number, e.g. 60 = Position X), "DA" lines are the rows, and a line starting with "* " continues
// the line before it. Text values are in single quotes.
export function parseLST(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const tables = {};
  let table = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('BEGIN_')) { table = { columns: new Map(), rows: [] }; tables[line.slice(6).trim()] = table; continue; }
    if (line.startsWith('ENDE_')) { table = null; continue; }
    if (!table) continue;
    let full = line;
    while (i + 1 < lines.length && lines[i + 1].startsWith('* ')) full += lines[++i].slice(2);
    if (full.startsWith('MM,AT,')) {
      const v = splitLST(full);
      table.columns.set(Number(v[3]), table.columns.size);
    } else if (full.startsWith('DA,')) {
      table.rows.push(splitLST(full).slice(1));
    }
  }
  return tables;
}

// Split one LST line at the commas, keeping commas inside 'quoted text'. Numbers stay strings.
function splitLST(line) {
  const out = []; let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === "'") { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// The columns used here, by their fixed TRUMPF number.
const LST = {
  sheet: { table: 'SHEET_TECH', x: 20, y: 30, z: 40, material: 240 },
  parts: { table: 'PARTS_IN_PROGRAM', partNo: 30, geoFile: 50, count: 60, area: 90, dimX: 130, dimY: 140 },
  pos: { table: 'PARTS_IN_PROGRAM_POS', n: 10, partNo: 30, x: 60, y: 70, dimX: 80, dimY: 90, angle: 100, mirror: 330 },
  orders: { table: 'PARTORDER_IN_PRODORDER', n: 10, partNo: 30, order: 40 },
  job: { table: 'FERTIGUNG_AUFTRAG_TMP', name: 10, program: 40 },
};
export const LST_COLUMNS = LST;

// Integrity check of one parsed .GEO against its own header and the job file. A damaged file can still
// parse (a garbled coordinate gives a slightly wrong outline), so the exact area is the real test:
//   • the net area worked out from the outline must equal the area in the GEO header (±0.01 mm²)
//   • and the area and size the .LST gives for the part (±0.05, the LST rounds to 2 decimals)
// Returns '' when the file is fine, otherwise the reason in plain words.
export function geoProblem(geo, lst = {}) {
  const net = geo.netArea;
  if (isFinite(geo.header?.area) && Math.abs(net - geo.header.area) > 0.01) {
    return `outline area ${net.toFixed(2)} mm² does not match the ${(+geo.header.area).toFixed(2)} mm² in its header`;
  }
  if (isFinite(lst.area) && lst.area > 0 && Math.abs(net - lst.area) > 0.05) {
    return `outline area ${net.toFixed(2)} mm² does not match the ${lst.area.toFixed(2)} mm² in the job file`;
  }
  const w = geo.bbox.maxX - geo.bbox.minX, h = geo.bbox.maxY - geo.bbox.minY;
  const fits = (a, b) => Math.abs(w - a) <= 0.05 && Math.abs(h - b) <= 0.05;
  if (lst.w > 0 && lst.h > 0 && !fits(lst.w, lst.h) && !fits(lst.h, lst.w)) {
    return `size ${w.toFixed(1)} × ${h.toFixed(1)} mm does not match ${lst.w} × ${lst.h} mm in the job file`;
  }
  return '';
}

export async function jobFromLST(text, partsBase, loadPart = loadGEO, fileName = 'job.LST') {
  const t = parseLST(text);
  const need = (ok, msg) => { if (!ok) throw new Error(`${fileName}: ${msg}`); };
  const get = (spec, row, key) => { const k = t[spec.table].columns.get(spec[key]); return k == null ? undefined : row[k]; };
  for (const spec of [LST.sheet, LST.parts, LST.pos, LST.orders]) need(t[spec.table]?.rows.length, `table ${spec.table} is missing or empty`);

  const sheetRow = t[LST.sheet.table].rows[0];
  const size = { w: +get(LST.sheet, sheetRow, 'x'), h: +get(LST.sheet, sheetRow, 'y') };
  need(size.w > 0 && size.h > 0, 'no sheet size in SHEET_TECH');
  const orderOf = new Map(t[LST.orders.table].rows.map(r => [get(LST.orders, r, 'n'), get(LST.orders, r, 'order')]));

  // One .GEO per part number. If a file is missing, the part is still shown as its box (from the LST),
  // clearly marked, so the job can be sorted while the file is being fetched from the programmer.
  // The same happens when a file fails the integrity check (geoProblem): a damaged outline is never drawn.
  const partRows = t[LST.parts.table].rows;
  const geos = new Map(await Promise.all(partRows.map(async r => {
    const partNo = get(LST.parts, r, 'partNo');
    const file = get(LST.parts, r, 'geoFile') || `${partNo}.geo`;
    const dims = { w: +get(LST.parts, r, 'dimX'), h: +get(LST.parts, r, 'dimY') };
    let geo;
    try { geo = await loadGeoAnyCase(partsBase, file, loadPart); }
    catch { return [partNo, boxOnlyGeo(partNo, file, dims)]; }
    const problem = geoProblem(geo, { area: +get(LST.parts, r, 'area'), ...dims });
    return [partNo, problem ? boxOnlyGeo(partNo, file, dims, problem) : geo];
  })));

  const placed = t[LST.pos.table].rows.map(r => {
    const n = get(LST.pos, r, 'n'), partNo = get(LST.pos, r, 'partNo');
    const geo = geos.get(partNo);
    need(geo, `part ${partNo} (no. ${n}) is not in PARTS_IN_PROGRAM`);
    const rot = +get(LST.pos, r, 'angle') || 0, mirror = get(LST.pos, r, 'mirror') === '1';
    // The LST gives the lower-left corner of the part's box on the sheet; find where its origin goes.
    const b = M.bounds(M.boxCorners(geo.bbox).map(q => M.apply(placementMatrix(0, 0, rot, mirror), q)));
    return {
      uid: `${fileName.replace(/\.lst$/i, '')}-${String(n).padStart(2, '0')}`, partNo, order: orderOf.get(n) || '?',
      x: +get(LST.pos, r, 'x') - b.minX, y: +get(LST.pos, r, 'y') - b.minY, rot, mirror, geo,
    };
  });
  const jobRow = t[LST.job.table]?.rows[0];
  const missing = [...geos.values()].filter(g => g.boxOnly && !g.suspect).map(g => g.partNo);
  const suspect = [...geos.values()].filter(g => g.suspect).map(g => g.partNo);
  return makeJob({
    id: (jobRow && get(LST.job, jobRow, 'name')) || fileName.replace(/\.lst$/i, ''),
    size, thickness: +get(LST.sheet, sheetRow, 'z'), material: get(LST.sheet, sheetRow, 'material') || '',
    example: false, source: 'lst',
    note: [missing.length ? `No .GEO file yet for ${missing.join(', ')}: shown as its box only.` : '',
      suspect.length ? `Damaged .GEO file for ${suspect.join(', ')}: shown as its box only.` : ''].filter(Boolean).join(' '),
  }, placed);
}

// LST files name the geometry "1045572.geo"; the files on disk may be "1045572.GEO".
async function loadGeoAnyCase(base, file, loadPart) {
  try { return await loadPart(base + file); }
  catch (e) {
    const other = file.replace(/\.geo$/i, m => (m === '.geo' ? '.GEO' : '.geo'));
    if (other === file) throw e;
    return loadPart(base + other);
  }
}

// A stand-in for a part whose .GEO file is missing (or damaged: `suspect` says why): its box from the LST,
// flagged so the screen says so.
export function boxOnlyGeo(partNo, fileName, { w, h }, suspect = '') {
  const poly = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  return {
    fileName, partNo, name: partNo, boxOnly: true, suspect, info: {}, attrs: {}, header: {}, process: '', texts: [],
    contours: [{ index: 1, kind: 'outer', poly, length: 2 * (w + h), area: w * h }],
    bbox: { minX: 0, minY: 0, maxX: w, maxY: h }, netArea: w * h,
  };
}

// ---------- the job object the app uses ----------

function makeJob(head, placed) {
  const warnings = [];
  const parts = placed.map(p => {
    if (!p.geo.boxOnly && p.partNo !== p.geo.partNo) warnings.push(`${p.uid}: job says part ${p.partNo}, but ${p.geo.fileName} is marked ${p.geo.partNo}`);
    const matrix = placementMatrix(p.x, p.y, p.rot, p.mirror);
    const outline = p.geo.contours.filter(c => c.kind === 'outer').flatMap(c => c.poly);
    return {
      ...p, matrix,
      bbox: M.bounds(outline.map(q => M.apply(matrix, q))), // the part's box on the sheet, in mm
      isExample: p.geo.attrs?.EXAMPLE === '1',
      boxOnly: !!p.geo.boxOnly,
    };
  });
  // One parsed .GEO per part number (used for the look-alike check and the part pictures).
  const geos = new Map(parts.map(p => [p.partNo, p.geo]));
  const orders = [...new Set(parts.map(p => p.order))].sort();
  // A job file that uses invented example parts is example data, whatever format it came in.
  const example = head.example || parts.some(p => p.isExample);
  return { ...head, example, parts, geos, orders, warnings };
}
