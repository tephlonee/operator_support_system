// scenarios.test.js
// The acceptance test of the pipeline service: scenarios S1–S18 from the design doc (+ S19–S21 for
// restarting sorting runs), run against the
// real J14 files (data/jobs/J14.LST, data/parts/*.GEO). Run from the project folder:  npm test
//
// 1045575.GEO is really missing from the J14 files we have. Where a scenario needs a complete J14, a
// STAND-IN 1045575.GEO is generated (a 350 × 135 mm plate with one opening, with the area the LST gives).
// It is marked EXAMPLE and is only ever written into the temporary test folders.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.js';
import { Pipeline } from '../pipeline.js';
import { listJobs } from '../catalog.js';
import { createServer } from '../api.js';
import { housekeeping, DEFAULTS } from '../main.js';
import { makeDemoZ } from '../../tools/make-demo-z.mjs';
import { jobFromLST } from '../../src/nest-loader.js';
import { parseGEO } from '../../src/geo-parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const J14 = fs.readFileSync(path.join(ROOT, 'data/jobs/J14.LST'));
const GEO = name => fs.readFileSync(path.join(ROOT, 'data/parts', name));
const POLL = 15e3;

// ---------- test helpers ----------

function standInGeo() {
  // Outer 350 × 135 (counter-clockwise), one 200 × 78.296 opening (clockwise): 47250 − 15659.2 = 31590.8 mm²
  const pts = [[0, 0], [350, 0], [350, 135], [0, 135], [75, 28.352], [75, 106.648], [275, 106.648], [275, 28.352]];
  const L = ['#~1', '1.03', '2', '24.10.2026', '0 0 0', '350 135 0', '31590.8', '##~~',
    '#~11', 'STAND-IN', 'Test stand-in for 1045575', '', '', '*BELEGT*', 'st37-80', '8.0', '##~~',
    '#~30', 'EXAMPLE@1', 'BEZCH@Test stand-in for 1045575', '#~TTINFO_END', '#~31'];
  pts.forEach(([x, y], i) => L.push('P', String(i + 1), `${x} ${y} 0`, '|~'));
  L.push('##~~');
  const contour = (index, flag, ids) => {
    L.push('#~33', '', `${index} 24 ${flag}`, '##~~', '#~331');
    ids.forEach((a, k) => L.push('LIN', '1 0', `${a} ${ids[(k + 1) % ids.length]}`, '|~'));
    L.push('##~~', '#~KONT_END');
  };
  contour(1, 0, [1, 2, 3, 4]);
  contour(2, 1, [5, 6, 7, 8]);
  L.push('#~EOF', '');
  return Buffer.from(L.join('\r\n'), 'latin1');
}

function env({ geoWaitMinutes = 5, start = '2026-10-24T08:00:00', geoFolders = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  const z = path.join(dir, 'z');
  fs.mkdirSync(z);
  const store = new Store(path.join(dir, 'data'));
  const locked = new Set();
  const e = {
    dir, z, store, locked, now: new Date(start),
    put(rel, bytes) { const p = path.join(z, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; },
    // The programmer pastes a job folder: the LST and the GEO files (standIn: also the stand-in 1045575.GEO).
    pasteJ14(folder = 'L95/J14', { standIn = true, lst = J14, lstName = 'J14_1.LST' } = {}) {
      e.put(`${folder}/${lstName}`, lst);
      for (const g of ['1045572.GEO', '1045574.GEO']) e.put(`${folder}/${g}`, GEO(g));
      if (standIn) e.put(`${folder}/1045575.GEO`, standInGeo());
    },
    poll(n = 1) { for (let i = 0; i < n; i++) { e.now = new Date(e.now.getTime() + POLL); e.pipeline.poll(e.now); } return e.pipeline.health; },
    wait(ms) { e.now = new Date(e.now.getTime() + ms); },
    today(opts = {}) { return listJobs(store, { now: e.now, ...opts }).jobs; },
    file(rel) { return store.file(rel); },
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  e.pipeline = new Pipeline(store, { zRoot: z, geoWaitMinutes, geoFolders, isLocked: p => locked.has(p), clock: () => e.now });
  return e;
}

// Load a job the way a screen does, from the raw copy.
async function loadFromRaw(e, sha) {
  const raw = path.join(e.store.rawDir, sha);
  const lst = fs.readdirSync(raw).find(n => /\.lst$/i.test(n));
  const load = async url => {
    const name = url.split('/').pop();
    const real = fs.readdirSync(raw).find(n => n.toLowerCase() === name.toLowerCase());
    if (!real) throw new Error(`no ${name}`);
    return parseGEO(new TextDecoder('windows-1252').decode(fs.readFileSync(path.join(raw, real))), real);
  };
  return jobFromLST(fs.readFileSync(path.join(raw, lst), 'latin1'), '', load, lst);
}

const newRun = (e, sha, station = 'L95') => e.store.newRun(sha, station, e.now.toISOString());
const finish = (e, run) => e.store.run(`UPDATE sorting_runs SET phase = 'done', finished = ?, updated = ? WHERE id = ?`, e.now.toISOString(), e.now.toISOString(), run.id);

// The web API on a free port, as the screens use it. call() → { status, body }.
async function startApi(e) {
  const server = createServer({ store: e.store, pipeline: e.pipeline, appRoot: ROOT, config: { ...DEFAULTS, zRoot: e.z }, clock: () => e.now });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const csv = async url => (await fetch(base + url)).text();
  return { call, csv, close: () => server.close() };
}

// ---------- S1–S18 ----------

test('S1 a new complete job appears in today\'s list with 33 pieces', () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const [j] = e.today();
  assert.equal(j.job, 'J14');
  assert.equal(j.pieces, 33);
  assert.equal(j.status, 'ready');
  assert.equal(j.machine, 'L95');
  e.close();
});

test('S2 real J14 without 1045575.GEO: listed as incomplete, the part drawn as its box', async () => {
  const e = env();
  e.pasteJ14('L95/J14', { standIn: false });
  e.poll(2);
  assert.equal(e.today().length, 0, 'not listed while waiting');
  e.wait(5 * 60e3);
  e.poll();
  const [j] = e.today();
  assert.equal(j.status, 'incomplete');
  assert.deepEqual(j.missing, ['1045575']);
  const job = await loadFromRaw(e, j.sha);
  assert.equal(job.parts.length, 33);
  assert.ok(job.geos.get('1045575').boxOnly);
  assert.ok(e.store.all(`SELECT * FROM scan_log WHERE level = 'warn' AND message LIKE '%1045575%'`).length, 'the programmer can see it in the scan log');
  e.close();
});

test('S3 the LST arrives before its GEOs: waits quietly, then shows', () => {
  const e = env();
  e.put('L95/J14/J14_1.LST', J14);
  e.poll(2);
  assert.equal(e.file('L95/J14/J14_1.LST').status, 'waiting');
  assert.equal(e.today().length, 0);
  assert.equal(e.store.all(`SELECT * FROM scan_log WHERE level IN ('warn','error')`).length, 0, 'no error while waiting');
  for (const g of ['1045572.GEO', '1045574.GEO']) e.put(`L95/J14/${g}`, GEO(g));
  e.put('L95/J14/1045575.GEO', standInGeo());
  e.poll();
  assert.equal(e.today()[0].status, 'ready');
  e.close();
});

test('S4 an LST read while it is still being copied is never shown half', () => {
  const e = env();
  const p = e.put('L95/J14/J14_1.LST', J14.subarray(0, Math.floor(J14.length * 0.44)));
  for (const g of ['1045572.GEO', '1045574.GEO']) e.put(`L95/J14/${g}`, GEO(g));
  e.put('L95/J14/1045575.GEO', standInGeo());
  e.poll(3);
  assert.equal(e.today().length, 0, 'not shown with 9 of 33 pieces');
  assert.equal(e.file('L95/J14/J14_1.LST').status, 'copying');
  e.poll(3);
  assert.equal(e.file('L95/J14/J14_1.LST').status, 'damaged', 'a file that stays cut short is reported');
  // Windows sets the final size first and locks the file while copying: the lock keeps it out.
  e.locked.add(p);
  fs.writeFileSync(p, J14);
  e.poll(3);
  assert.equal(e.file('L95/J14/J14_1.LST').status, 'copying');
  assert.match(e.file('L95/J14/J14_1.LST').detail, /locked/);
  e.locked.delete(p);
  e.poll();
  assert.equal(e.today()[0].pieces, 33);
  e.close();
});

test('S5 programmed yesterday, cut today: still in today\'s list', () => {
  const e = env({ start: '2026-10-23T15:00:00' });
  e.pasteJ14();
  e.poll(2);
  e.now = new Date('2026-10-24T07:00:00');
  e.poll();
  assert.equal(e.today().length, 1);
  e.close();
});

test('S6 half sorted at 23:30, the shift goes on after midnight: still listed; old sorted jobs are not', () => {
  const e = env({ start: '2026-10-23T23:20:00' });
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  e.now = new Date('2026-10-23T23:30:00');
  newRun(e, sha);
  e.now = new Date('2026-10-24T00:10:00');
  e.poll();
  assert.equal(e.today()[0].openRun.runNo, 1);
  finish(e, e.store.runsOf(sha)[0]);
  e.now = new Date('2026-10-26T08:00:00');
  e.poll();
  assert.equal(e.today().length, 0, 'sorted two days ago: only found by search');
  assert.equal(listJobs(e.store, { scope: 'search', q: 'J14', now: e.now }).jobs.length, 1);
  e.close();
});

test('S7 the same LST pasted twice ("J14 - Copy"): one job, two places', () => {
  const e = env();
  e.pasteJ14('L95/J14');
  e.pasteJ14('L95/J14 - Copy');
  e.poll(2);
  const jobs = e.today();
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].paths.sort(), ['L95/J14 - Copy/J14_1.LST', 'L95/J14/J14_1.LST']);
  e.close();
});

test('S8 the program is pasted over while being sorted: the old version is kept and the screen is warned', async () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const a = e.today()[0];
  newRun(e, a.sha);
  // One piece moved by 10 mm, as when the programmer edits and re-exports the nest.
  const moved = Buffer.from(J14.toString('latin1').replace(/^(DA,1,'J14_1','1045572',)([\d.]+)/m, (m, head, x) => head + (+x + 10).toFixed(3)), 'latin1');
  assert.notDeepEqual(moved, J14);
  e.put('L95/J14/J14_1.LST', moved);
  e.wait(60e3);
  e.poll(2);
  const jobs = e.today();
  const old = jobs.find(j => j.sha === a.sha), now = jobs.find(j => j.sha !== a.sha);
  assert.ok(old.openRun, 'the version being sorted stays in the list');
  assert.equal(old.newerVersion, true);
  assert.equal(old.status, 'replaced');
  assert.equal(now.status, 'ready');
  const kept = await loadFromRaw(e, a.sha);
  const fresh = await loadFromRaw(e, now.sha);
  assert.notEqual(kept.parts[0].x, fresh.parts[0].x, 'the raw copy of the old version is unchanged');
  e.close();
});

test('S9 the name J14 is reused for a different program: it starts at 0, not as already sorted', () => {
  const e = env();
  e.pasteJ14('L95/J14');
  e.poll(2);
  const first = e.today()[0];
  finish(e, newRun(e, first.sha));
  const other = Buffer.from(J14.toString('latin1').replace("'2012479d-987b-4d79-b4f5-446ccc919301'", "'99999999-0000-0000-0000-000000000000'"), 'latin1');
  e.pasteJ14('L95/J14 new', { lst: other });
  e.wait(60e3);
  e.poll(2);
  const second = listJobs(e.store, { scope: 'search', q: 'J14', now: e.now }).jobs.find(j => j.sha !== first.sha);
  assert.equal(second.job, 'J14');
  assert.equal(second.runs.length, 0);
  e.close();
});

test('S10 one program cut on several sheets: one run per sheet, the next one can copy the pallet plan', () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  const r1 = newRun(e, sha);
  e.store.run('UPDATE sorting_runs SET state = ? WHERE id = ?', JSON.stringify({ phase: 'sort', plan: { pallets: ['P1', 'P2'] } }), r1.id);
  finish(e, r1);
  const r2 = newRun(e, sha);
  assert.equal(r2.run_no, 2);
  assert.equal(e.today()[0].sheetsPlanned, 1, 'SollAnzahl from the LST');
  e.close();
});

test('S11 Z:\\ cannot be reached: known jobs stay, the screens are told since when', () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  fs.renameSync(e.z, `${e.z}-offline`);
  const h = e.poll();
  assert.equal(h.zReachable, false);
  assert.ok(h.zErrorSince);
  assert.equal(e.today().length, 1, 'the job is still listed');
  assert.ok(e.pipeline.rawFile(sha, 'j14_1.lst'), 'and can still be opened from the raw copy');
  fs.renameSync(`${e.z}-offline`, e.z);
  assert.equal(e.poll().zReachable, true);
  e.close();
});

test('S12 the job folder is deleted from Z:\\ in the middle of sorting: sorting goes on', () => {
  const e = env();
  e.pasteJ14();
  // Another job stays on Z:\, so the share does not look empty.
  e.pasteJ14('L96/OTHER', { lst: Buffer.from(J14.toString('latin1').replace("'J14','J14_1'", "'K20','K20_1'"), 'latin1'), lstName: 'K20_1.LST' });
  e.poll(2);
  const sha = e.today()[0].sha;
  newRun(e, sha);
  fs.rmSync(path.join(e.z, 'L95'), { recursive: true });
  e.poll();
  const j = e.today().find(x => x.sha === sha);
  assert.equal(j.status, 'removed');
  assert.ok(j.openRun);
  assert.ok(e.pipeline.rawFile(sha, '1045572.GEO'));
  e.close();
});

test('S12b a share that suddenly looks empty is not taken as "everything deleted"', () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  fs.rmSync(path.join(e.z, 'L95'), { recursive: true });
  e.poll();
  assert.equal(e.file('L95/J14/J14_1.LST').status, 'ready');
  assert.equal(e.pipeline.health.zError, 'empty');
  e.close();
});

test('S13 search by date and machine, by part number and by order', () => {
  const e = env({ start: '2026-09-14T09:00:00' });
  e.pasteJ14();
  e.poll(2);
  e.now = new Date('2026-10-24T08:00:00');
  const search = o => listJobs(e.store, { scope: 'search', now: e.now, ...o }).jobs.map(j => j.job);
  assert.deepEqual(search({ date: '2026-09-14', machine: 'L95' }), ['J14']);
  assert.deepEqual(search({ date: '2026-09-15' }), []);
  assert.deepEqual(search({ q: '1045574' }), ['J14']);
  const order = listJobs(e.store, { scope: 'search', now: e.now }).jobs[0].orders[0];
  assert.deepEqual(search({ q: order.toLowerCase() }), ['J14']);
  e.close();
});

test('S14 GEO names in any upper/lower case are found', () => {
  const e = env();
  e.pasteJ14();
  fs.renameSync(path.join(e.z, 'L95/J14/1045574.GEO'), path.join(e.z, 'L95/J14/1045574.geo'));
  e.poll(2);
  assert.equal(e.today()[0].status, 'ready');
  e.close();
});

test('S15 two stations: only the one that has the job can save; the other can take it over', async () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  const server = createServer({ store: e.store, pipeline: e.pipeline, appRoot: ROOT, config: { ...DEFAULTS, zRoot: e.z }, clock: () => e.now });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const run = (await call('POST', '/runs', { sha, station: 'L95' })).body;
    assert.equal((await call('PUT', `/runs/${run.id}/state`, { station: 'L95', seq: 1, phase: 'sort', state: { x: 1 }, picked: 12, total: 33 })).status, 200);
    const other = await call('PUT', `/runs/${run.id}/state`, { station: 'L96', seq: 2, phase: 'sort', state: { x: 2 } });
    assert.equal(other.status, 409);
    assert.equal(other.body.claimedBy, 'L95');
    const list = (await call('GET', '/jobs?machine=L96')).body;
    assert.equal(list.jobs[0].openRun.station, 'L95', 'other screens see "in progress at L95"');
    assert.equal(list.jobs[0].openRun.picked, 12);
    assert.equal((await call('POST', `/runs/${run.id}/claim`, { station: 'L96' })).body.station, 'L96');
    assert.equal((await call('PUT', `/runs/${run.id}/state`, { station: 'L95', seq: 3, phase: 'sort', state: {} })).status, 409, 'the first station is told it was taken over');
    assert.equal((await call('PUT', `/runs/${run.id}/state`, { station: 'L96', seq: 1, phase: 'sort', state: { old: true } })).body.ignored, true, 'a late, older write is ignored');
    const got = (await call('GET', `/runs/${run.id}`)).body;
    assert.deepEqual(got.state, { x: 1 });
    // The test log: a row sent twice after a network drop is stored once, and can be exported.
    const rows = [{ session_id: 'S1', seq: 1, event: 'confirm', uid: 'J14_1-01' }, { session_id: 'S1', seq: 2, event: 'undo' }];
    assert.equal((await call('POST', '/events', { station: 'L96', runId: run.id, rows })).body.added, 2);
    assert.equal((await call('POST', '/events', { station: 'L96', runId: run.id, rows })).body.added, 0);
    const csv = await (await fetch(`${base}/runs/${run.id}/log.csv`)).text();
    assert.match(csv, /confirm/);
    assert.equal(csv.trim().split('\r\n').length, 1 + 3, 'header + claim + 2 rows');
    // The raw files, in any case, and nothing outside the app folder.
    assert.equal((await fetch(`${base}/jobs/${sha}/parts/1045572.geo`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/server/store.js`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/index.html`)).status, 200);
  } finally {
    server.close();
    e.close();
  }
});

test('S16 3,000 jobs on Z:\\: after the first scan, a poll opens nothing and stays fast', () => {
  const e = env({ geoFolders: ['GEO'] });
  // 3,000 job folders with the invented example LST (small); the GEO files in one shared folder.
  const demo = makeDemoZ(path.join(e.dir, 'demo'));
  const exDir = path.join(demo, 'L96', 'EX-S001');
  const lst = fs.readFileSync(path.join(exDir, 'EX-S001.LST'));
  for (const f of fs.readdirSync(exDir)) if (/\.geo$/i.test(f)) e.put(`GEO/${f}`, fs.readFileSync(path.join(exDir, f)));
  for (let i = 0; i < 3000; i++) e.put(`L${90 + (i % 8)}/JOB${i}/EX-S001.LST`, lst);
  e.poll(2);
  assert.equal(e.store.get(`SELECT COUNT(*) AS n FROM files WHERE status = 'ready'`).n, 3000);
  const t0 = Date.now();
  const h = e.poll();
  const ms = Date.now() - t0;
  assert.equal(h.opened, 0, 'no file opened when nothing changed');
  assert.ok(ms < 2000, `poll took ${ms} ms`);
  console.log(`  S16: a steady poll over 3,000 jobs took ${ms} ms on local disk (one stat per LST; over SMB expect more)`);
  e.close();
});

test('S17 a corrupted GEO is caught: garbled coordinate, cut short, or empty', async () => {
  const e = env();
  const garbled = Buffer.from(GEO('1045572.GEO').toString('latin1').replace('0.000000000 12.071067812 0.000000000', '0.000000000 12.971067812 0.000000000'), 'latin1');
  e.pasteJ14();
  e.put('L95/J14/1045572.GEO', garbled);
  e.poll(2);
  const [j] = e.today();
  assert.equal(j.status, 'suspect');
  assert.equal(j.suspect[0].partNo, '1045572');
  assert.match(j.suspect[0].reason, /area/);
  const job = await loadFromRaw(e, j.sha);
  assert.ok(job.geos.get('1045572').boxOnly, 'the screen draws it as its box, never the damaged outline');
  assert.ok(job.geos.get('1045572').suspect);

  const e2 = env();
  e2.pasteJ14();
  const g = GEO('1045574.GEO');
  e2.put('L95/J14/1045574.GEO', g.subarray(0, g.length - 40));
  e2.poll(2);
  assert.equal(e2.file('L95/J14/J14_1.LST').status, 'waiting', 'a GEO without #~EOF may still be copying');
  e2.wait(5 * 60e3);
  e2.poll();
  assert.match(e2.today()[0].suspect[0].reason, /cut short/);

  const e3 = env();
  e3.pasteJ14();
  e3.put('L95/J14/1045574.GEO', Buffer.alloc(0));
  e3.poll(2);
  e3.wait(5 * 60e3);
  e3.poll();
  assert.equal(e3.today()[0].suspect[0].partNo, '1045574');
  for (const x of [e, e2, e3]) x.close();
});

test('S18 the same program cut again for a new order: a new run, never blocked', () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  finish(e, newRun(e, sha));
  e.now = new Date('2026-10-31T08:00:00');
  e.poll();
  assert.equal(e.today().length, 0, 'sorted last week');
  const again = listJobs(e.store, { scope: 'search', q: 'J14', now: e.now }).jobs[0];
  assert.equal(again.doneRuns, 1);
  const r2 = newRun(e, again.sha);
  assert.equal(r2.run_no, 2);
  assert.equal(e.today()[0].openRun.runNo, 2, 'back on today\'s list while it is being sorted');
  e.close();
});

// ---------- sorting runs: restart, one open run per job, test sessions ----------

test('S19 a run is restarted halfway: the old run is stopped and kept with its log, the new one starts at setup', async () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  const api = await startApi(e);
  try {
    const r1 = (await api.call('POST', '/runs', { sha, station: 'L95' })).body;
    assert.equal(r1.startedAs, 'first');
    await api.call('PUT', `/runs/${r1.id}/state`, { station: 'L95', seq: 1, phase: 'sort', state: { plan: 3 }, picked: 12, total: 33 });
    await api.call('POST', '/events', { station: 'L95', runId: r1.id, rows: [{ session_id: 'A', seq: 1, event: 'confirm' }] });
    // Another station restarts it (e.g. the setup was wrong).
    const r2 = await api.call('POST', `/runs/${r1.id}/restart`, { station: 'L96' });
    assert.equal(r2.status, 200);
    assert.deepEqual([r2.body.runNo, r2.body.phase, r2.body.picked, r2.body.state], [2, 'setup', 0, null], 'starts from setup with nothing picked');
    assert.deepEqual([r2.body.startedAs, r2.body.parentRunId, r2.body.station], ['restart', r1.id, 'L96']);
    const old = (await api.call('GET', `/runs/${r1.id}`)).body;
    assert.deepEqual([old.phase, old.picked, old.abandonedBy, old.abandonReason], ['abandoned', 12, 'L96', 'restart'], 'kept, with how far it got');
    assert.deepEqual(old.state, { plan: 3 });
    // The screen that still had run 1 is told on its next save, and by whom.
    const late = await api.call('PUT', `/runs/${r1.id}/state`, { station: 'L95', seq: 2, phase: 'sort', state: {} });
    assert.equal(late.status, 409);
    assert.deepEqual([late.body.abandoned, late.body.claimedBy], [true, 'L96']);
    assert.equal((await api.call('POST', `/runs/${r1.id}/claim`, { station: 'L95' })).status, 409, 'a stopped run cannot be taken over');
    assert.equal((await api.call('POST', `/runs/${r1.id}/restart`, { station: 'L95' })).status, 409, 'nor restarted twice');
    // Each attempt keeps its own log.
    const log1 = await api.csv(`/runs/${r1.id}/log.csv`);
    assert.match(log1, /confirm/);
    assert.match(log1, /run_stopped/);
    assert.doesNotMatch(await api.csv(`/runs/${r2.body.id}/log.csv`), /confirm/);
    // The job list shows the new run as the open one; run 1 is neither open nor sorted.
    const entry = (await api.call('GET', `/jobs/${sha}`)).body;
    assert.equal(entry.openRun.runNo, 2);
    assert.equal(entry.doneRuns, 0);
    assert.deepEqual(entry.runs.map(r => r.phase), ['abandoned', 'setup']);
  } finally {
    api.close();
    e.close();
  }
});

test('S20 one open run per job: a second one is refused until the first is finished or stopped', async () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  const api = await startApi(e);
  try {
    const r1 = (await api.call('POST', '/runs', { sha, station: 'L95' })).body;
    const second = await api.call('POST', '/runs', { sha, station: 'L96' });
    assert.equal(second.status, 409);
    assert.equal(second.body.openRun.id, r1.id, 'the screen is told which run is open, so it can offer continue or restart');
    // Finished: the next sheet copies the pallets of run 1; a plain new run is "sorted again".
    await api.call('PUT', `/runs/${r1.id}/state`, { station: 'L95', seq: 1, phase: 'done', state: { plan: { pallets: ['P1'] } }, picked: 33, total: 33 });
    const r2 = (await api.call('POST', '/runs', { sha, station: 'L95', copyPlanFrom: r1.id })).body;
    assert.deepEqual([r2.runNo, r2.startedAs, r2.parentRunId, r2.state.phase], [2, 'next_sheet', r1.id, 'cards']);
    await api.call('POST', `/runs/${r2.id}/abandon`, { station: 'L95' });
    const r3 = (await api.call('POST', '/runs', { sha, station: 'L95' })).body;
    assert.deepEqual([r3.runNo, r3.startedAs, r3.parentRunId], [3, 'again', null]);
    assert.equal((await api.call('POST', `/runs/${r1.id}/abandon`, { station: 'L95' })).status, 409, 'a sorted sheet cannot be stopped');
  } finally {
    api.close();
    e.close();
  }
});

test('S21 a new usability-test session gets its own run and log, also after a finished sheet', async () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  const sha = e.today()[0].sha;
  const api = await startApi(e);
  try {
    const r1 = (await api.call('POST', '/runs', { sha, station: 'L95' })).body;
    await api.call('POST', '/events', { station: 'L95', runId: r1.id, rows: [{ session_id: 'P01', seq: 1, event: 'confirm' }] });
    await api.call('PUT', `/runs/${r1.id}/state`, { station: 'L95', seq: 1, phase: 'done', state: {}, picked: 33, total: 33 });
    const r2 = (await api.call('POST', `/runs/${r1.id}/restart`, { station: 'L95', reason: 'test_session' })).body;
    assert.deepEqual([r2.runNo, r2.startedAs, r2.parentRunId], [2, 'test_session', r1.id]);
    assert.equal((await api.call('GET', `/runs/${r1.id}`)).body.phase, 'done', 'a sorted sheet stays sorted');
    await api.call('POST', '/events', { station: 'L95', runId: r2.id, rows: [{ session_id: 'P02', seq: 1, event: 'undo' }] });
    const p2 = await api.csv('/log.csv?session=P02');
    assert.equal(p2.trim().split('\r\n').length, 2, 'header + the one row of participant P02');
    assert.doesNotMatch(await api.csv(`/runs/${r2.id}/log.csv`), /P01/);
  } finally {
    api.close();
    e.close();
  }
});

test('An older picking.db (table "runs") is upgraded in place: runs and their log links kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-migrate-'));
  try {
    const db = new DatabaseSync(path.join(dir, 'picking.db'));
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, run_no INTEGER NOT NULL, station TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'setup', state TEXT, seq INTEGER NOT NULL DEFAULT 0, picked INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, finished TEXT, UNIQUE (sha256, run_no));
      CREATE TABLE events (id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES runs(id), station TEXT, session_id TEXT, seq INTEGER,
        at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (session_id, seq));
      INSERT INTO runs (sha256, run_no, station, phase, picked, total, created, updated) VALUES ('abc', 1, 'L95', 'sort', 5, 33, 'x', 'x');
      INSERT INTO events (run_id, at, kind, data) VALUES (1, 'x', 'confirm', '{}');`);
    db.close();
    const store = new Store(dir);
    const [run] = store.runsOf('abc');
    assert.deepEqual([run.picked, run.started_as, run.abandoned], [5, 'first', null], 'the old run, with the new columns');
    assert.equal(store.openRunOf('abc').id, run.id);
    assert.match(store.get(`SELECT sql FROM sqlite_master WHERE name = 'events'`).sql, /REFERENCES "?sorting_runs"?/, 'events point at the renamed table');
    assert.equal(store.get('PRAGMA user_version').user_version, 1);
    assert.equal(store.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'runs'`).n, 0);
    store.close();
    new Store(dir).close(); // opening it again changes nothing
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Housekeeping: a consistent nightly backup copy, old log lines removed', () => {
  const e = env();
  e.pasteJ14();
  e.poll(2);
  e.store.log('2026-08-01T00:00:00.000Z', 'info', null, 'old line');
  const out = housekeeping(e.store, { ...DEFAULTS, dataDir: path.join(e.dir, 'data') }, new Date('2026-10-24T02:30:00'));
  const copy = new DatabaseSync(out.backup, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  copy.close();
  assert.equal(out.logLinesRemoved, 1);
  assert.equal(out.rawRemoved, 0, 'the job is still on Z:\\');
  e.close();
});
