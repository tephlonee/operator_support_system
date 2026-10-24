// nest-loader.test.js
// Checks the job loader: the placement maths (move, rotate, mirror), the example job, the real J14 job
// read straight from its TRUMPF .LST file, the job list, and that bad job data stops with a clear message.

import { loadJob, loadJobIndex, jobFromJSON, jobFromLST, placementMatrix, parseLST, geoProblem } from '../src/nest-loader.js';
import { loadGEO, parseGEO } from '../src/geo-parser.js';
import * as M from '../src/matrix.js';
import { check, near } from './harness.js';

const JOB = '../data/jobs/example-sheet.json';

function testPlacement() {
  // The part point (10, 0), placed with its origin at (100, 200).
  const at = (rot, mirror) => M.apply(placementMatrix(100, 200, rot, mirror), { x: 10, y: 0 });
  const same = (p, x, y) => near(p.x, x, 1e-9) && near(p.y, y, 1e-9);
  const cases = [
    ['no rotation', at(0, false), 110, 200],
    ['rotated 90° counter-clockwise', at(90, false), 100, 210],
    ['rotated 180°', at(180, false), 90, 200],
    ['mirrored', at(0, true), 90, 200],
    ['mirrored, then rotated 90°', at(90, true), 100, 190],
  ];
  for (const [name, p, x, y] of cases) {
    check(`Placement: part point (10, 0) ${name} lands at (${x}, ${y})`, same(p, x, y), `got (${+p.x.toFixed(6)}, ${+p.y.toFixed(6)})`);
  }
}

async function testExampleJob() {
  const job = await loadJob(JOB);
  check('Example job: marked as example data', job.example === true, `example=${job.example}`);
  check('Example job: 15–30 parts on the sheet', job.parts.length >= 15 && job.parts.length <= 30, `${job.parts.length} parts`);
  check('Example job: 3–4 orders, every part has one (pallets are chosen by the operator, not in the file)',
    job.orders.length >= 3 && job.orders.length <= 4 && job.parts.every(p => job.orders.includes(p.order)) && !('pallets' in job), job.orders.join(', '));
  check('Example job: part numbers match the marked text in the .GEO files', !job.warnings.length, job.warnings.join('; ') || 'all match');
  const wrongFlag = job.parts.filter(p => p.isExample !== p.partNo.startsWith('EX-')).map(p => p.uid);
  check('Example job: EX- parts are flagged as examples, real parts are not', !wrongFlag.length, wrongFlag.join(', ') || 'all OK');

  // The Python generator placed EX-S001-24 (EX-2001, rotated 90°) with its box at (1238, 15)–(1488, 415).
  // Getting the same box here means the two independent placement calculations agree.
  const p24 = job.parts.find(p => p.uid === 'EX-S001-24');
  const b = p24.bbox;
  check('Example job: rotated part EX-S001-24 lands where the generator put it', near(b.minX, 1238, 1e-6) && near(b.minY, 15, 1e-6) && near(b.maxX, 1488, 1e-6) && near(b.maxY, 415, 1e-6),
    `box (${+b.minX.toFixed(3)}, ${+b.minY.toFixed(3)})–(${+b.maxX.toFixed(3)}, ${+b.maxY.toFixed(3)})`);

  const outside = job.parts.filter(p => p.bbox.minX < 0 || p.bbox.minY < 0 || p.bbox.maxX > job.size.w || p.bbox.maxY > job.size.h);
  check('Example job: every part lies on the sheet', !outside.length, outside.map(p => p.uid).join(', ') || 'all inside');
  const overlaps = [];
  job.parts.forEach((a, i) => job.parts.slice(i + 1).forEach(c => {
    if (a.bbox.minX < c.bbox.maxX && c.bbox.minX < a.bbox.maxX && a.bbox.minY < c.bbox.maxY && c.bbox.minY < a.bbox.maxY) overlaps.push(`${a.uid}/${c.uid}`);
  }));
  check('Example job: no two parts overlap', !overlaps.length, overlaps.join(', ') || 'no overlaps');
}

async function expectError(name, json, pattern) {
  const partsBase = new URL('../data/parts/', location.href).href;
  try {
    await jobFromJSON(json, partsBase);
    check(name, false, 'no error was raised');
  } catch (e) {
    check(name, pattern.test(e.message), e.message);
  }
}

async function testBadJobs() {
  const json = await (await fetch(JOB)).json();
  const first = json.parts[0];
  const { order, ...noOrder } = first;
  await expectError('Bad job: a part without an order stops with a clear message',
    { ...json, parts: [noOrder] }, /has no order/);
  await expectError('Bad job: missing .GEO file stops with a clear message',
    { ...json, parts: [{ ...first, geo: 'examples/NOPE.GEO' }] }, /NOPE\.GEO/);
  await expectError('Bad job: the same part id twice stops with a clear message',
    { ...json, parts: [first, first] }, /used twice/);
}

// The real job J14 (TruTops Boost .LST). Expected values are read off the file by hand.
async function testLST() {
  const job = await loadJob('../data/jobs/J14.LST');
  check('J14.LST: sheet 2000 × 1000 × 8 mm, St37-80', job.size.w === 2000 && job.size.h === 1000 && job.thickness === 8 && job.material === 'St37-80',
    `${job.size.w} × ${job.size.h} × ${job.thickness} ${job.material}`);
  const count = no => job.parts.filter(p => p.partNo === no).length;
  check('J14.LST: 33 pieces: 12 × 1045572, 10 × 1045575, 11 × 1045574', job.parts.length === 33 && count('1045572') === 12 && count('1045575') === 10 && count('1045574') === 11,
    `${job.parts.length} pieces`);
  check('J14.LST: orders from PARTORDER_IN_PRODORDER (1045574 → OR13, 1045575 → OR14, 1045572 → OR17)',
    job.orders.join(',') === 'OR13,OR14,OR17' && job.parts.every(p => p.order === { 1045574: 'OR13', 1045575: 'OR14', 1045572: 'OR17' }[p.partNo]), job.orders.join(', '));
  const p5 = job.parts.find(p => p.uid === 'J14-05');
  check('J14.LST: piece 5 (1045574) has its box where the LST puts it (644.96, 83.32), 833 × 135 mm',
    Math.abs(p5.bbox.minX - 644.96) < 0.01 && Math.abs(p5.bbox.minY - 83.32) < 0.01 && Math.abs(p5.bbox.maxX - p5.bbox.minX - 833) < 0.01 && Math.abs(p5.bbox.maxY - p5.bbox.minY - 135) < 0.01,
    `(${p5.bbox.minX.toFixed(2)}, ${p5.bbox.minY.toFixed(2)})–(${p5.bbox.maxX.toFixed(2)}, ${p5.bbox.maxY.toFixed(2)})`);
  const box = job.geos.get('1045575');
  check('J14.LST: a part without a .GEO file (1045575) is shown as its box (350 × 135 mm) and flagged',
    box.boxOnly && box.bbox.maxX === 350 && box.bbox.maxY === 135 && job.parts.filter(p => p.boxOnly).length === 10 && /1045575/.test(job.note), job.note);
  check('J14.LST: the real outlines of 1045572 and 1045574 are used', !job.geos.get('1045572').boxOnly && !job.geos.get('1045574').boxOnly && !job.warnings.length,
    job.warnings.join('; ') || 'both read');
  const outside = job.parts.filter(p => p.bbox.minX < 0 || p.bbox.minY < 0 || p.bbox.maxX > job.size.w || p.bbox.maxY > job.size.h);
  check('J14.LST: every piece lies on the sheet', !outside.length, outside.map(p => p.uid).join(', ') || 'all inside');
  const t = parseLST("BEGIN_X\nZA,MM,2\nMM,AT,1,  10,1,1,,'a'                 ,,'',T\nMM,AT,1,  20,1,1,,'b'                 ,,'',T\nDA,'one, two',\n* 'three'\nENDE_X\n");
  check('LST reader: continued lines ("* ") and commas inside quotes', t.X.rows[0][0] === 'one, two' && t.X.rows[0][1] === 'three' && t.X.columns.get(20) === 1, JSON.stringify(t.X.rows[0]));
}

async function testIndex() {
  const jobs = await loadJobIndex('../data/jobs/index.json');
  check('Job list: lists the real J14 and the example sheet', jobs.some(j => j.file === 'J14.LST') && jobs.some(j => j.file === 'example-sheet.json'), jobs.map(j => j.file).join(', '));
}

// The integrity check of a .GEO file (S17 in the pipeline design): a damaged file can still parse, so
// the exact area (outline vs header vs the LST) decides, and a damaged part is drawn as its box.
async function testGeoCheck() {
  const text = new TextDecoder('windows-1252').decode(await (await fetch('../data/parts/1045572.GEO')).arrayBuffer());
  const lst = { area: 13818.84, w: 165, h: 90 };            // from PARTS_IN_PROGRAM in J14.LST
  const ok = parseGEO(text, '1045572.GEO');
  check('GEO check: the real 1045572 passes (outline area = header = LST, size = LST)', geoProblem(ok, lst) === '', geoProblem(ok, lst) || 'OK');
  const bad = parseGEO(text.replace('0.000000000 12.071067812 0.000000000', '0.000000000 12.971067812 0.000000000'), '1045572.GEO');
  const why = geoProblem(bad, lst);
  check('GEO check: one garbled coordinate parses, but the area check catches it', /area/.test(why), why);
  check('GEO check: a part with the wrong size for the job is caught', /size/.test(geoProblem(ok, { w: 166, h: 90 })), geoProblem(ok, { w: 166, h: 90 }));
  const job = await jobFromLST(await (await fetch('../data/jobs/J14.LST')).text(), '../data/parts/',
    async url => (/1045572/i.test(url) ? bad : loadGEO(url)), 'J14.LST');
  const g = job.geos.get('1045572');
  check('GEO check: a damaged part file is drawn as its box, never with the wrong outline', g.boxOnly && !!g.suspect && /Damaged/.test(job.note), job.note);
}

export async function testNestLoader() {
  testPlacement();
  await testExampleJob();
  await testLST();
  await testIndex();
  await testBadJobs();
  await testGeoCheck();
}
