// store.js
// Everything the pipeline service keeps, in one SQLite file (no database server).
// SQLite runs inside this program as a library: the whole database is the file at <dataDir>/picking.db.
// Only this service opens it; the monitors go through the API, so two screens never write at once.
//
//   files     the catalog, part 1: one row per .LST path seen on Z:\ (its status, its content hash)
//   jobs      the catalog, part 2: one row per job content (hash): job name, parts, orders, sheet, …
//   sorting_runs  one row per attempt at sorting a sheet of a job (job hash + run number), with the
//             station that has claimed it and the latest saved state of the screen. A job has many runs
//             (more sheets, sorted again, restarted); at most one is open at a time. Runs are never
//             deleted once something happened in them: a restart stops the old run ("abandoned") and
//             starts a new one, so every attempt keeps its own log.
//   events    the event log: every action on a screen (one row per test-log row), never changed
//   scan_log  what the poller noticed (files waiting, incomplete, damaged, Z:\ unreachable)
//
// Raw copies of the job files are not in the database: they are plain files in <dataDir>/raw/<hash>/.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Columns of sorting_runs added when runs could be restarted (schema version 1). An older database gets
// them too (see migrate()).
const RUN_COLUMNS = [
  ['started_as', "TEXT NOT NULL DEFAULT 'first'"],  // first | next_sheet | again | restart | test_session
  ['parent_run_id', 'INTEGER'],                      // the run it copied its pallets from, or replaced
  ['abandoned', 'TEXT'],                             // when it was stopped on purpose
  ['abandoned_by', 'TEXT'],                          // by which station
  ['abandon_reason', 'TEXT'],                        // restart | test_session | …
];
const RUN_COLUMNS_SQL = RUN_COLUMNS.map(([c, type]) => `  ${c} ${type}`).join(',\n');
export const SCHEMA_VERSION = 1;

const SCHEMA = `
-- The catalog, part 1: one row per .LST file on Z:\\ (a path), and what we know about it now.
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,   -- relative to Z:\\, with / as separator, e.g. L95/J14/J14_1.LST
  machine     TEXT NOT NULL DEFAULT '',  -- first folder under Z:\\ (e.g. L95)
  sha256      TEXT,                   -- the job content this path holds now (see jobs)
  prev_sha    TEXT,                   -- the content it held before it was replaced (S8)
  size        INTEGER, mtime INTEGER, -- as listed on Z:\\ (mtime is the programmer's date, not ours)
  first_seen  TEXT NOT NULL,          -- our own clock
  last_seen   TEXT NOT NULL,
  stable      INTEGER NOT NULL DEFAULT 0,  -- polls in a row with the same size and date
  status      TEXT NOT NULL,          -- copying | damaged | waiting | incomplete | suspect | ready | gone
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);

-- The catalog, part 2: one row per job content (hash of the LST + its GEO files). Two copies of the same
-- file share one row (S7); a file that is changed gets a new row, and the old one stays for its runs (S8).
CREATE TABLE IF NOT EXISTS jobs (
  sha256      TEXT PRIMARY KEY,
  job TEXT, program TEXT, guid TEXT, plan_date TEXT, machine_name TEXT,
  sheets_planned INTEGER,             -- SollAnzahl: how many sheets of this program are to be cut
  example     INTEGER NOT NULL DEFAULT 0,  -- 1 when its parts are invented example parts (EXAMPLE@1)
  lst_name    TEXT NOT NULL,          -- file name of the LST in the raw copy
  pieces INTEGER, part_nos TEXT, orders TEXT, material TEXT, thickness REAL, sheet_w REAL, sheet_h REAL,
  missing_geos TEXT NOT NULL DEFAULT '[]',  -- part numbers without a GEO file (JSON list)
  suspect_geos TEXT NOT NULL DEFAULT '[]',  -- [{ partNo, reason }] for GEO files that failed the check
  first_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sorting_runs (
  id        INTEGER PRIMARY KEY,
  sha256    TEXT NOT NULL,            -- which raw copy is being sorted
  run_no    INTEGER NOT NULL,         -- 1, 2, 3 … for the same job content (reruns, more sheets, restarts)
  station   TEXT NOT NULL,            -- the claim: the station working on it, e.g. L95
  phase     TEXT NOT NULL DEFAULT 'setup',   -- setup | sort | done | abandoned (open = setup or sort)
  state     TEXT,                     -- the screen's state as JSON: pallet plan, progress, …
  seq       INTEGER NOT NULL DEFAULT 0,      -- last state number written (older writes are ignored)
  picked INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  created   TEXT NOT NULL, updated TEXT NOT NULL, finished TEXT,
${RUN_COLUMNS_SQL},
  UNIQUE (sha256, run_no)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER REFERENCES sorting_runs(id),
  station     TEXT, session_id TEXT, seq INTEGER,
  at          TEXT NOT NULL,          -- when the server received it
  kind        TEXT NOT NULL,          -- the test-log event: confirm, undo, missing, pallet_full …
  data        TEXT NOT NULL,          -- the whole test-log row as JSON
  UNIQUE (session_id, seq)            -- a row sent twice (after a network drop) is stored once
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);

CREATE TABLE IF NOT EXISTS scan_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, path TEXT, message TEXT NOT NULL
);
`;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.rawDir = path.join(dataDir, 'raw');
    fs.mkdirSync(this.rawDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'picking.db'));
    // WAL: a power cut during a write cannot damage the file.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // A picking.db from before runs could be restarted: the table was called "runs" and had none of the
  // RUN_COLUMNS. Renaming keeps every row, and the events keep pointing at their runs.
  migrate() {
    const has = name => !!this.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
    if (has('runs') && !has('sorting_runs')) this.db.exec('ALTER TABLE runs RENAME TO sorting_runs');
    if (!has('sorting_runs')) return;
    const cols = new Set(this.all('PRAGMA table_info(sorting_runs)').map(c => c.name));
    for (const [c, type] of RUN_COLUMNS) if (!cols.has(c)) this.db.exec(`ALTER TABLE sorting_runs ADD COLUMN ${c} ${type}`);
  }

  close() { this.db.close(); }

  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- catalog ----------

  file(p) { return this.get('SELECT * FROM files WHERE path = ?', p); }
  files() { return this.all('SELECT * FROM files'); }
  job(sha) { return this.get('SELECT * FROM jobs WHERE sha256 = ?', sha); }

  saveFile(f) { this.upsert('files', 'path', f); }
  saveJob(j) { this.upsert('jobs', 'sha256', j); }

  upsert(table, key, row) {
    const cols = Object.keys(row);
    this.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
      ON CONFLICT(${key}) DO UPDATE SET ${cols.filter(c => c !== key).map(c => `${c}=excluded.${c}`).join(',')}`,
    ...cols.map(c => row[c] ?? null));
  }

  log(at, level, p, message) {
    this.run('INSERT INTO scan_log (at, level, path, message) VALUES (?, ?, ?, ?)', at, level, p ?? null, message);
  }

  // ---------- runs ----------

  runById(id) { return this.get('SELECT * FROM sorting_runs WHERE id = ?', id); }
  runsOf(sha) { return this.all('SELECT * FROM sorting_runs WHERE sha256 = ? ORDER BY run_no', sha); }
  // The run of a job that is being set up or sorted now (there is at most one).
  openRunOf(sha) { return this.get(`SELECT * FROM sorting_runs WHERE sha256 = ? AND phase IN ('setup', 'sort') ORDER BY run_no DESC`, sha); }

  // A new run of a job, with the next run number. opts: { state, startedAs, parentId } (see RUN_COLUMNS).
  newRun(sha, station, now, opts) { return this.tx(() => this.insertRun(sha, station, now, opts)); }

  insertRun(sha, station, now, { state = null, startedAs = 'first', parentId = null } = {}) {
    const n = (this.get('SELECT MAX(run_no) AS n FROM sorting_runs WHERE sha256 = ?', sha).n || 0) + 1;
    const r = this.run(`INSERT INTO sorting_runs (sha256, run_no, station, phase, state, created, updated, started_as, parent_run_id)
      VALUES (?, ?, ?, 'setup', ?, ?, ?, ?, ?)`, sha, n, station, state, now, now, startedAs, parentId);
    return this.runById(Number(r.lastInsertRowid));
  }

  // Stop a run on purpose. It keeps its picks and its log, and no longer counts as open.
  abandonRun(id, station, now, reason) {
    this.run(`UPDATE sorting_runs SET phase = 'abandoned', abandoned = ?, abandoned_by = ?, abandon_reason = ?, updated = ? WHERE id = ?`,
      now, station, reason, now, id);
  }

  // Restart, in one step: the run is stopped (unless it was finished: then it stays sorted) and a new run
  // of the same job starts from the beginning, linked to it.
  restartRun(id, station, now, { reason = 'restart', startedAs = 'restart' } = {}) {
    return this.tx(() => {
      const old = this.runById(id);
      if (old.phase === 'setup' || old.phase === 'sort') this.abandonRun(id, station, now, reason);
      return this.insertRun(old.sha256, station, now, { startedAs, parentId: id });
    });
  }

  // ---------- events ----------

  addEvents(runId, station, rows, now) {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO events (run_id, station, session_id, seq, at, kind, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    this.tx(() => {
      for (const row of rows) {
        added += Number(ins.run(runId ?? null, station ?? null, String(row.session_id ?? ''), Number(row.seq) || 0,
          now, String(row.event ?? ''), JSON.stringify(row)).changes);
      }
    });
    return added;
  }

  // ---------- backup ----------

  // A consistent copy of the database while the service keeps running (copying the live file could
  // catch it half-written). Keeps the newest `keep` copies.
  backup(dir, stamp, keep = 14) {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `picking-${stamp}.db`);
    if (fs.existsSync(target)) fs.rmSync(target);
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(dir).filter(f => /^picking-.*\.db$/.test(f)).sort().slice(0, -keep);
    for (const f of old) fs.rmSync(path.join(dir, f));
    return target;
  }
}
