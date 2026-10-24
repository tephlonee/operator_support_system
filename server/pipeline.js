// pipeline.js
// The poller and the catalog. Every few seconds (15 by default) it lists Z:\, which reads only names,
// sizes and dates, and opens only files that are new or changed. Z:\ is never written to.
//
// What happens to an .LST file (its "status" in the catalog):
//
//   copying     just appeared, changed since the last poll, or still locked by the copy: wait
//   damaged     unchanged for a while, but it does not end with its "ED" line, cannot be read,
//               or its piece counts do not add up (S4)
//   waiting     complete, but a .GEO file it needs is not there yet (or is still being copied);
//               not shown to the operator for the first few minutes (S3)
//   incomplete  still a .GEO missing after those minutes: listed, the part is drawn as its box (S2)
//   suspect     every .GEO is there, but one failed the integrity check (S17): listed, that part
//               is drawn as its box
//   ready       complete and checked
//   gone        no longer on Z:\ (the raw copy and any runs stay, S12)
//
// When a file is accepted (ready, incomplete or suspect) its LST and GEO files are copied into the raw
// store, named by the hash of their content. Screens are always served from that copy, so a job can be
// sorted even if Z:\ changes or cannot be reached (S8, S11, S12).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseLST, LST_COLUMNS as C, geoProblem } from '../src/nest-loader.js';
import { parseGEO } from '../src/geo-parser.js';

export const LISTED = new Set(['ready', 'incomplete', 'suspect']);
const SETTLE_POLLS = 1;      // polls a file must stay unchanged before it is opened (seen twice in total)
const DAMAGED_POLLS = 4;     // after this many unchanged polls a file that still does not end with ED is damaged

const decode = buf => new TextDecoder('windows-1252').decode(buf);

// On Windows a file that is still being pasted is locked: opening it fails with EBUSY (sharing violation).
export function isLockedOnWindows(file) {
  try { fs.closeSync(fs.openSync(file, 'r')); return false; }
  catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'; }
}

// The last line of an LST that is not empty and not a "C" (comment) line must be "ED".
export function endsWithED(text) {
  const lines = text.replace(/\r/g, '').split('\n').map(s => s.trim()).filter(s => s && s !== 'C');
  return lines.at(-1) === 'ED';
}

export class Pipeline {
  constructor(store, { zRoot, geoWaitMinutes = 5, geoFolders = [], maxDepth = 4, isLocked = isLockedOnWindows, clock = () => new Date() } = {}) {
    this.store = store;
    this.zRoot = zRoot;
    this.geoWaitMs = geoWaitMinutes * 60e3;
    this.geoFolders = geoFolders;
    this.maxDepth = maxDepth;
    this.isLocked = isLocked;
    this.clock = clock;
    this.health = { zReachable: null, lastScan: null, lastGoodScan: null, zError: '', zErrorSince: null, lastScanMs: 0, opened: 0, files: 0 };
    this.busy = false;
  }

  // ---------- one poll ----------

  poll(now = this.clock()) {
    if (this.busy) return this.health;          // never two polls at once
    this.busy = true;
    const t0 = Date.now();
    const at = now.toISOString();
    try {
      let listing;
      try {
        listing = this.list();
      } catch (e) {
        // Z:\ cannot be reached: keep everything we know, and say since when (S11).
        if (this.health.zReachable !== false) this.store.log(at, 'error', null, `Cannot reach ${this.zRoot}: ${e.message}`);
        this.health = { ...this.health, zReachable: false, zError: e.message, zErrorSince: this.health.zErrorSince || at, lastScan: at };
        return this.health;
      }
      const known = this.store.files().filter(f => f.status !== 'gone');
      // A share that suddenly looks empty is far more likely to be a network problem than every job
      // being deleted at once: do not mark anything gone then.
      const looksEmpty = !listing.lsts.length && known.length > 0;
      if (this.health.zReachable === false) this.store.log(at, 'info', null, `${this.zRoot} reachable again`);
      this.opened = 0;
      const seen = new Set();
      for (const f of listing.lsts) {
        seen.add(f.rel);
        try { this.consider(f, listing, now); }
        catch (e) { this.store.log(at, 'error', f.rel, `Could not check: ${e.message}`); }
      }
      if (!looksEmpty) {
        for (const f of known) {
          if (seen.has(f.path)) continue;
          this.store.saveFile({ ...f, status: 'gone', detail: 'no longer on Z:', last_seen: at });
          this.store.log(at, 'info', f.path, 'Removed from Z:');
        }
      } else if (this.health.zError !== 'empty') {
        this.store.log(at, 'warn', null, `${this.zRoot} looks empty: nothing marked as removed`);
      }
      this.health = {
        zReachable: true, zError: looksEmpty ? 'empty' : '', zErrorSince: null, lastScan: at, lastGoodScan: at,
        lastScanMs: Date.now() - t0, opened: this.opened, files: listing.lsts.length,
      };
      return this.health;
    } finally {
      this.busy = false;
    }
  }

  // List Z:\: every .LST (with its size and date) and, per folder, the file names in it (for the GEOs).
  // Only the .LST files are stat'ed; nothing is opened here.
  list() {
    const lsts = [];
    const dirs = new Map();    // relative folder → Map(lower-case name → real name)
    const walk = (rel, depth) => {
      const abs = path.join(this.zRoot, rel);
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
      catch (e) { if (!rel) throw e; return; }       // only the root being unreachable is an error
      const names = new Map();
      for (const e of entries) {
        if (e.isDirectory()) { if (depth < this.maxDepth && !e.name.startsWith('.')) walk(path.posix.join(rel, e.name), depth + 1); continue; }
        if (!e.isFile()) continue;
        names.set(e.name.toLowerCase(), e.name);
        if (/\.lst$/i.test(e.name)) {
          const p = path.join(abs, e.name);
          try {
            const st = fs.statSync(p);
            lsts.push({ rel: path.posix.join(rel, e.name), abs: p, dir: rel, name: e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
          } catch { /* vanished while listing: next poll */ }
        }
      }
      dirs.set(rel, names);
    };
    walk('', 0);
    for (const g of this.geoFolders) if (!dirs.has(g)) walk(g, this.maxDepth);
    return { lsts, dirs };
  }

  // ---------- one file ----------

  consider(f, listing, now) {
    const at = now.toISOString();
    const row = this.store.file(f.rel);
    if (!row) {
      this.store.saveFile({ path: f.rel, machine: f.rel.includes('/') ? f.rel.split('/')[0] : '', size: f.size, mtime: f.mtime,
        first_seen: at, last_seen: at, stable: 0, status: 'copying', detail: 'new: waiting until it stops changing' });
      return;
    }
    const changed = row.size !== f.size || row.mtime !== f.mtime;
    if (changed) {
      const was = row.status;
      this.store.saveFile({ ...row, size: f.size, mtime: f.mtime, last_seen: at, stable: 0, status: 'copying',
        detail: LISTED.has(was) ? 'changed on Z:\\, checking again' : 'still changing' });
      if (LISTED.has(was)) this.store.log(at, 'info', f.rel, 'Changed on Z:, checking again');
      return;
    }
    const stable = row.stable + 1;
    if (row.status === 'ready' || row.status === 'suspect') {
      this.store.saveFile({ ...row, last_seen: at, stable });
      return;
    }
    if (row.status === 'damaged') { this.store.saveFile({ ...row, last_seen: at, stable }); return; }
    if ((row.status === 'copying' || row.status === 'gone') && stable < SETTLE_POLLS) {
      this.store.saveFile({ ...row, last_seen: at, stable });
      return;
    }
    if (this.isLocked(f.abs)) {
      this.store.saveFile({ ...row, last_seen: at, stable, status: 'copying', detail: 'locked: still being copied' });
      return;
    }
    // copying (settled), waiting, incomplete, or back after being gone: open it and check it.
    this.check({ ...row, last_seen: at, stable }, f, listing, now);
  }

  check(row, f, listing, now) {
    const at = now.toISOString();
    this.opened++;
    const bytes = fs.readFileSync(f.abs);
    const text = decode(bytes);
    const damaged = detail => {
      if (row.stable < DAMAGED_POLLS) return this.save(row, 'copying', 'not complete yet', at);
      return this.save(row, 'damaged', detail, at, 'error');
    };
    if (!endsWithED(text)) return damaged('the file does not end with its ED line: cut short or damaged');
    let t;
    try { t = parseLST(text); } catch (e) { return damaged(`cannot be read: ${e.message}`); }
    for (const spec of [C.sheet, C.parts, C.pos, C.orders]) {
      if (!t[spec.table]?.rows.length) return damaged(`table ${spec.table} is missing or empty`);
    }
    const col = (spec, r, key) => { const k = t[spec.table].columns.get(spec[key]); return k == null ? undefined : r[k]; };
    const partRows = t[C.parts.table].rows;
    const pieces = t[C.pos.table].rows.length;
    const planned = partRows.reduce((s, r) => s + (+col(C.parts, r, 'count') || 0), 0);
    if (pieces !== planned) return damaged(`${pieces} pieces placed on the sheet, but ${planned} listed in PARTS_IN_PROGRAM`);

    // The GEO files: found in the same folder (or a shared GEO folder), any upper/lower case (S14).
    const geos = [], missing = [], notYet = [], suspect = [];
    let example = false;
    for (const r of partRows) {
      const partNo = col(C.parts, r, 'partNo');
      const want = (col(C.parts, r, 'geoFile') || `${partNo}.geo`).toLowerCase();
      const where = [f.dir, ...this.geoFolders].find(d => listing.dirs.get(d)?.has(want));
      if (where == null) { missing.push(partNo); continue; }
      const name = listing.dirs.get(where).get(want);
      const abs = path.join(this.zRoot, where, name);
      let gb;
      try { gb = fs.readFileSync(abs); } catch { notYet.push(partNo); continue; }
      const gtext = decode(gb);
      if (!gtext.trimEnd().endsWith('#~EOF')) { notYet.push(partNo); geos.push({ partNo, name, bytes: gb, cut: true }); continue; }
      geos.push({ partNo, name, bytes: gb });
      try {
        const geo = parseGEO(gtext, name);
        if (geo.attrs.EXAMPLE === '1') example = true;
        const reason = geoProblem(geo, { area: +col(C.parts, r, 'area'), w: +col(C.parts, r, 'dimX'), h: +col(C.parts, r, 'dimY') });
        if (reason) suspect.push({ partNo, reason });
      } catch (e) { suspect.push({ partNo, reason: e.message }); }
    }
    const waited = now.getTime() - Date.parse(row.first_seen) >= this.geoWaitMs;
    if ((missing.length || notYet.length) && !waited) {
      return this.save(row, 'waiting', `waiting for ${[...missing, ...notYet].map(p => `${p}.GEO`).join(', ')}`, at);
    }
    // After the wait, a GEO that never got its end line counts as damaged.
    for (const p of notYet) if (!missing.includes(p) && !suspect.some(s => s.partNo === p)) {
      if (geos.some(g => g.partNo === p)) suspect.push({ partNo: p, reason: 'the file is cut short (no #~EOF end line)' });
      else missing.push(p);
    }

    // Identity of the content: the LST plus every GEO it uses (S7, S8). Never used to block anything.
    const h = crypto.createHash('sha256').update(bytes);
    for (const g of [...geos].sort((a, b) => a.partNo.localeCompare(b.partNo))) h.update(`\n${g.name}\n`).update(g.bytes);
    const sha = h.digest('hex');

    const jobRow = t[C.job.table]?.rows[0];
    const jcol = key => (jobRow ? col(C.job, jobRow, key) : undefined);
    const plan = t.EINRICHTEPLAN_INFO;
    const pcol = no => { const k = plan?.columns.get(no); return k == null || !plan.rows[0] ? '' : plan.rows[0][k]; };
    const analytics = Object.fromEntries((t.ANALYTICS_DATA?.rows || []).map(r => [r[0], r[1]]));
    const sheetRow = t[C.sheet.table].rows[0];
    const ordersOf = [...new Set(t[C.orders.table].rows.map(r => col(C.orders, r, 'order')).filter(Boolean))].sort();
    const sollK = t[C.job.table]?.columns.get(50);
    if (!this.store.job(sha)) {
      this.store.saveJob({
        sha256: sha, job: jcol('name') || f.name.replace(/\.lst$/i, ''), program: jcol('program') || '',
        guid: analytics.NcProgramGuid || '', plan_date: pcol(80), machine_name: pcol(280) || pcol(10),
        sheets_planned: sollK != null && jobRow ? (+jobRow[sollK] || null) : null, example: example ? 1 : 0,
        lst_name: f.name, pieces, part_nos: partRows.map(r => col(C.parts, r, 'partNo')).join(' '), orders: ordersOf.join(' '),
        material: col(C.sheet, sheetRow, 'material') || '', thickness: +col(C.sheet, sheetRow, 'z') || null,
        sheet_w: +col(C.sheet, sheetRow, 'x') || null, sheet_h: +col(C.sheet, sheetRow, 'y') || null,
        missing_geos: JSON.stringify(missing), suspect_geos: JSON.stringify(suspect), first_seen: at,
      });
    }
    this.copyRaw(sha, f, bytes, geos);
    const status = missing.length ? 'incomplete' : suspect.length ? 'suspect' : 'ready';
    const detail = [missing.length ? `no GEO file for ${missing.join(', ')}` : '', ...suspect.map(s => `${s.partNo}.GEO: ${s.reason}`)].filter(Boolean).join('; ');
    const prev = row.sha256 && row.sha256 !== sha ? row.sha256 : row.prev_sha;
    return this.save({ ...row, sha256: sha, prev_sha: prev }, status, detail, at, status === 'ready' ? 'info' : 'warn');
  }

  save(row, status, detail, at, level = null) {
    if (level && (row.status !== status || row.detail !== detail)) {
      this.store.log(at, level, row.path, status === 'ready' ? 'Accepted' : `${status}: ${detail}`);
    }
    this.store.saveFile({ ...row, status, detail });
  }

  // Copy the job files into <dataDir>/raw/<hash>/ once. Written to a temporary folder first and then
  // renamed, so a half-written copy is never used.
  copyRaw(sha, f, bytes, geos) {
    const dir = path.join(this.store.rawDir, sha);
    if (fs.existsSync(dir)) return;
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, f.name), bytes);
    for (const g of geos) fs.writeFileSync(path.join(tmp, g.name), g.bytes);
    fs.renameSync(tmp, dir);
  }

  // A file from the raw copy of a job, by name in any upper/lower case. null if there is none.
  rawFile(sha, name) {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const dir = path.join(this.store.rawDir, sha);
    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }
    const real = names.find(n => n.toLowerCase() === String(name).toLowerCase());
    return real ? path.join(dir, real) : null;
  }
}
