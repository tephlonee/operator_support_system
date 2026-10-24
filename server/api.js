// api.js
// The web server the monitors connect to (http://<server-ip>:8080/). It serves the app itself and a small
// JSON API. Nothing else talks to the database or to Z:\.
//
//   GET  /api/health                         last poll, whether Z:\ can be reached
//   GET  /api/jobs?scope=today&machine=L95   the default list for a station
//   GET  /api/jobs?scope=search&q=&date=&machine=
//   GET  /api/jobs/{hash}                    one job, with its runs
//   GET  /api/jobs/{hash}/files/{name}       a file from the job's raw copy (the LST)
//   GET  /api/jobs/{hash}/parts/{name}       the same, for the GEO files (any upper/lower case)
//   POST /api/runs                {sha, station, copyPlanFrom?}   start sorting a sheet of a job
//   GET  /api/runs/{id}                      a run with its saved state
//   POST /api/runs/{id}/claim     {station}  take the job over from another station
//   PUT  /api/runs/{id}/state     {station, seq, phase, state, picked, total}
//   POST /api/events              {station, runId, rows}           test-log rows (the event log)
//   GET  /api/runs/{id}/log.csv              the event log of one run, as CSV
//   GET  /api/log.csv?session=ID             the event log of one test session, as CSV
//   GET  /api/scan-log                       what the poller noticed (for the programmer)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { jobEntry, listJobs, runSummary } from './catalog.js';
import { COLUMNS } from '../src/log.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8',
  '.geo': 'application/octet-stream', '.lst': 'text/plain; charset=windows-1252', '.ico': 'image/x-icon',
};
const STATION = /^[\w .-]{1,20}$/;

export function createServer({ store, pipeline, appRoot, config, clock = () => new Date() }) {
  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ...pipeline.health, now: clock().toISOString(), pollSeconds: config.pollSeconds, zRoot: config.zRoot })],
    ['GET', /^\/api\/jobs$/, (req, url) => listJobs(store, {
      scope: url.searchParams.get('scope') === 'search' ? 'search' : 'today',
      q: url.searchParams.get('q') || '', date: url.searchParams.get('date') || '', machine: url.searchParams.get('machine') || '',
      now: clock(), recentDays: config.recentDays,
    })],
    ['GET', /^\/api\/jobs\/([0-9a-f]{64})$/, (req, url, [sha]) => jobEntry(store, sha) || fail(404, 'No such job')],
    ['GET', /^\/api\/jobs\/([0-9a-f]{64})\/(?:files|parts)\/([^/]+)$/, (req, url, [sha, name]) => {
      const file = pipeline.rawFile(sha, decodeURIComponent(name));
      if (!file) fail(404, `No file ${name} in this job`);
      return { file };
    }],
    ['POST', /^\/api\/runs$/, async req => {
      const b = await body(req);
      const station = needStation(b.station);
      if (!store.job(b.sha)) fail(404, 'No such job');
      let state = null;
      if (b.copyPlanFrom) {
        // "Next sheet of this program": start with the same pallets, at "hang the cards".
        const prev = store.runById(+b.copyPlanFrom);
        const ps = prev?.state ? JSON.parse(prev.state) : null;
        if (prev?.sha256 === b.sha && ps?.plan) state = JSON.stringify({ phase: 'cards', plan: ps.plan });
      }
      const run = store.newRun(b.sha, station, clock().toISOString(), state);
      return runOut(run);
    }],
    ['GET', /^\/api\/runs\/(\d+)$/, (req, url, [id]) => runOut(store.runById(+id) || fail(404, 'No such run'))],
    // A run opened and left again during setup, before anything was sorted: forget it (its log rows stay).
    ['DELETE', /^\/api\/runs\/(\d+)$/, async (req, url, [id]) => {
      const b = await body(req);
      const run = store.runById(+id);
      if (!run) return { ok: true };
      if (run.station !== b.station || run.phase !== 'setup') fail(409, 'Only a run still in setup, on its own station, can be cancelled');
      store.tx(() => { store.run('UPDATE events SET run_id = NULL WHERE run_id = ?', run.id); store.run('DELETE FROM runs WHERE id = ?', run.id); });
      return { ok: true };
    }],
    ['POST', /^\/api\/runs\/(\d+)\/claim$/, async (req, url, [id]) => {
      const b = await body(req);
      const station = needStation(b.station);
      const run = store.runById(+id) || fail(404, 'No such run');
      if (run.phase === 'done') fail(409, 'This sheet is already sorted');
      const now = clock().toISOString();
      store.run('UPDATE runs SET station = ?, updated = ? WHERE id = ?', station, now, run.id);
      store.addEvents(run.id, station, [{ session_id: `claim-${run.id}-${Date.now()}`, seq: 1, event: 'claim', detail: `from ${run.station} to ${station}` }], now);
      return runOut(store.runById(run.id));
    }],
    ['PUT', /^\/api\/runs\/(\d+)\/state$/, async (req, url, [id]) => {
      const b = await body(req);
      const station = needStation(b.station);
      const run = store.runById(+id) || fail(404, 'No such run');
      // Only the station that has the job may write. Another station took it over: tell this one (S15).
      if (run.station !== station) fail(409, `Taken over by ${run.station}`, { claimedBy: run.station });
      const seq = Number(b.seq) || 0;
      if (seq <= run.seq) return { ok: true, ignored: true };     // an older write arriving late
      const now = clock().toISOString();
      const phase = ['setup', 'sort', 'done'].includes(b.phase) ? b.phase : run.phase;
      store.run(`UPDATE runs SET phase = ?, state = ?, seq = ?, picked = ?, total = ?, updated = ?,
        finished = CASE WHEN ? = 'done' THEN COALESCE(finished, ?) ELSE NULL END WHERE id = ?`,
      phase, JSON.stringify(b.state ?? null), seq, +b.picked || 0, +b.total || 0, now, phase, now, run.id);
      return { ok: true };
    }],
    ['POST', /^\/api\/events$/, async req => {
      const b = await body(req);
      const station = b.station && STATION.test(b.station) ? b.station : null;
      const rows = Array.isArray(b.rows) ? b.rows.filter(r => r && typeof r === 'object').slice(0, 1000) : [];
      const runId = b.runId && store.runById(+b.runId) ? +b.runId : null;
      return { ok: true, added: store.addEvents(runId, station, rows, clock().toISOString()) };
    }],
    ['GET', /^\/api\/runs\/(\d+)\/log\.csv$/, (req, url, [id]) => ({ csv: toCSV(store.all('SELECT * FROM events WHERE run_id = ? ORDER BY id', +id)), name: `run-${id}-log.csv` })],
    ['GET', /^\/api\/log\.csv$/, (req, url) => {
      const s = url.searchParams.get('session') || '';
      return { csv: toCSV(store.all('SELECT * FROM events WHERE session_id = ? ORDER BY id', s)), name: `session-${s.replace(/[^\w-]/g, '_')}-log.csv` };
    }],
    ['GET', /^\/api\/scan-log$/, (req, url) => store.all('SELECT at, level, path, message FROM scan_log ORDER BY id DESC LIMIT ?', Math.min(+url.searchParams.get('limit') || 100, 1000))],
  ];

  const runOut = r => ({ ...runSummary(r), sha: r.sha256, state: r.state ? JSON.parse(r.state) : null, seq: r.seq });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) {
        const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
        if (!route) fail(404, 'Unknown API call');
        const out = await route[2](req, url, url.pathname.match(route[1]).slice(1));
        if (out?.file) return sendFile(res, out.file);
        if (out?.csv != null) {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.name}"`, 'Cache-Control': 'no-store' });
          return res.end('\ufeff' + out.csv);
        }
        return json(res, 200, out);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
      // The app's own files. Never anything outside the app folder, and never the server's data.
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(appRoot, `.${rel}`);
      if (!file.startsWith(path.resolve(appRoot) + path.sep) || /[\\/](server|\.[^\\/]*)([\\/]|$)/.test(file.slice(path.resolve(appRoot).length))) fail(404, 'Not found');
      return sendFile(res, file);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json(res, status, { error: e.message, ...(e.extra || {}) });
    }
  });
}

function sendFile(res, file) {
  let data;
  try { data = fs.readFileSync(file); } catch { fail(404, 'Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function fail(status, message, extra) {
  const e = new Error(message); e.status = status; e.extra = extra;
  throw e;
}

function needStation(s) {
  if (typeof s !== 'string' || !STATION.test(s)) fail(400, 'Set a station ID on this screen first (letters, digits, - or _)');
  return s;
}

async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2e6) fail(413, 'Too much data'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'Not valid JSON'); }
}

// The event log as CSV: the test-log columns (as exported from a screen), then station, run and when the
// server received the row.
export function toCSV(events) {
  const cols = [...COLUMNS, 'station', 'run_id', 'received'];
  const cell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = events.map(e => { const d = JSON.parse(e.data); return cols.map(c => cell(c === 'station' ? e.station : c === 'run_id' ? e.run_id : c === 'received' ? e.at : d[c])).join(','); });
  return [cols.join(','), ...rows].join('\r\n') + '\r\n';
}
