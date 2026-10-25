// backend.js
// Where the app gets its jobs from and where it saves progress. Two ways, same functions:
//
//   ServerBackend  the pipeline service on the LAN (server/main.js): jobs from Z:\ via the catalog,
//                  progress and the test log saved on the server, so every screen sees the same thing.
//                  Used whenever the page was opened from the service (http://<server-ip>:8080/).
//   LocalBackend   no service: the bundled job files (data/jobs/index.json) and progress in this
//                  browser only. Used when the app is opened from a plain local web server (demo, tests).
//
// The ServerBackend never loses a change when the network drops: changes wait in an outbox (also kept in
// this browser) and are sent again; the server ignores a row it already has and an older state.

const OUTBOX_KEY = 'operator-picking.outbox';
const LOCAL_STATE_KEY = 'operator-picking.state.v2';
const LOCAL_DONE_KEY = 'operator-picking.done';
const JOB_INDEX = 'data/jobs/index.json';

export async function connect() {
  try {
    const res = await fetch('api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) return new ServerBackend(await res.json());
  } catch { /* no service: work locally */ }
  return new LocalBackend();
}

class HttpError extends Error {
  constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body || {}; }
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

// ---------- the pipeline service ----------

export class ServerBackend {
  constructor(health) {
    this.mode = 'server';
    this.health = health;
    this.reachable = true;
    this.run = null;               // the run open on this screen: { id, runNo, station, sha, … }
    this.seq = 0;
    this.onConflict = () => {};    // fn(station, { abandoned }): another station took the job over or restarted it
    this.onChange = () => {};      // health or outbox changed (redraw the health line)
    this.outbox = readJSON(OUTBOX_KEY, { rows: [], states: {} });
    this.flushing = null;          // the send going on (a promise)
    this.flush();
  }

  get waiting() { return this.outbox.rows.length + Object.keys(this.outbox.states).length; }

  async refreshHealth() {
    try { this.health = await call('GET', 'api/health'); this.reachable = true; this.flush(); }
    catch { this.reachable = false; }
    this.onChange();
    return this.health;
  }

  // { jobs: [entry], machines, machineKnown }. An entry is what the job list and openJob need.
  async listJobs({ scope = 'today', q = '', date = '', machine = '' } = {}) {
    const p = new URLSearchParams({ scope, q, date, machine });
    const data = await call('GET', `api/jobs?${p}`);
    this.reachable = true;
    return { ...data, jobs: data.jobs.map(toEntry) };
  }

  async entry(sha) { return toEntry(await call('GET', `api/jobs/${sha}`)); }

  // Open a job on this screen, in one of its sorting runs (a job has at most one open run). mode:
  //   'continue'  the open run: this station's own, or taken over from another station
  //   'restart'   stop the open run (kept, with its log) and start a new run from setup
  //   'new'       a new run; copyPlanFrom: { runId } starts it with that run's pallets ("next sheet")
  // Default: continue the open run if there is one, otherwise a new run.
  // Returns the saved state of the run (null for a new one).
  async open(entry, station, { copyPlanFrom = null, mode = entry.openRun && !copyPlanFrom ? 'continue' : 'new' } = {}) {
    let run;
    if (mode === 'continue') {
      if (!entry.openRun) throw new Error('This job has no open run');
      run = entry.openRun.station === station ? await call('GET', `api/runs/${entry.openRun.id}`)
        : await call('POST', `api/runs/${entry.openRun.id}/claim`, { station });
    } else if (mode === 'restart') {
      run = await call('POST', `api/runs/${entry.openRun.id}/restart`, { station, reason: 'restart' });
    } else {
      await this.drain(); // the previous run's "done" must reach the server first, or it still counts as open
      run = await call('POST', 'api/runs', { sha: entry.sha, station, copyPlanFrom: copyPlanFrom?.runId ?? null });
    }
    this.run = run;
    this.seq = run.seq;
    return run.state;
  }

  // Start the open job again in a new run, on this screen (a new usability-test session): the current run
  // is stopped and kept with its log; a finished one stays sorted. Returns the new run.
  async restart(station, reason) {
    if (!this.run) return null;
    await this.drain(); // the old run keeps how far it got
    const run = await call('POST', `api/runs/${this.run.id}/restart`, { station, reason });
    this.run = run;
    this.seq = run.seq;
    return run;
  }

  // Leave the job. A run that never got past setup is cancelled, so it does not show as "in progress".
  async close(station, phase) {
    const run = this.run;
    this.run = null;
    if (run && phase !== 'sort' && phase !== 'done') {
      delete this.outbox.states[run.id];
      this.saveOutbox();
      try { await call('DELETE', `api/runs/${run.id}`, { station }); } catch { /* it stays as an unfinished run */ }
    }
  }

  saveState(station, state, { phase, picked = 0, total = 0 }) {
    if (!this.run) return;
    this.seq += 1;
    this.outbox.states[this.run.id] = { station, seq: this.seq, phase, state, picked, total };
    this.saveOutbox();
    this.flush();
  }

  record(row, station) {
    this.outbox.rows.push({ row, station, runId: this.run?.id ?? null });
    if (this.outbox.rows.length > 5000) this.outbox.rows.splice(0, this.outbox.rows.length - 5000);
    this.saveOutbox();
    this.flush();
  }

  // Send what is waiting: test-log rows first, then the latest state of each run. On a network error,
  // try again in a few seconds; on "taken over" or "stopped", tell the screen. One send at a time; the
  // promise resolves when it is over.
  flush() {
    if (!this.flushing) this.flushing = this.send().finally(() => { this.flushing = null; this.onChange(); });
    return this.flushing;
  }

  // Wait until everything waiting has been sent (a few tries; not while the server cannot be reached).
  async drain() {
    for (let i = 0; i < 5 && this.waiting && this.reachable; i++) await this.flush();
  }

  async send() {
    try {
      while (this.outbox.rows.length) {
        const batch = this.outbox.rows.slice(0, 200);
        const groups = new Map();
        for (const r of batch) {
          const k = `${r.runId}|${r.station}`;
          if (!groups.has(k)) groups.set(k, { runId: r.runId, station: r.station, rows: [] });
          groups.get(k).rows.push(r.row);
        }
        for (const g of groups.values()) await call('POST', 'api/events', g);
        this.outbox.rows.splice(0, batch.length);
        this.saveOutbox();
      }
      for (const [runId, s] of Object.entries(this.outbox.states)) {
        try {
          await call('PUT', `api/runs/${runId}/state`, s);
        } catch (e) {
          if (e.status !== 409 && e.status !== 404) throw e;
          if (this.outbox.states[runId] === s) delete this.outbox.states[runId];
          this.saveOutbox();
          if (e.status === 409 && String(this.run?.id) === runId) this.onConflict(e.body.claimedBy || '?', e.body);
          continue;
        }
        if (this.outbox.states[runId] === s) delete this.outbox.states[runId];
        this.saveOutbox();
      }
      this.reachable = true;
    } catch {
      this.reachable = false;
      setTimeout(() => this.flush(), 4000);
    }
  }

  saveOutbox() { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(this.outbox)); } catch { /* memory only */ } }

  // After a page reload: the newest unfinished run this station has, if any.
  async resumable(station) {
    if (!station) return null;
    const { jobs } = await this.listJobs({ scope: 'today' });
    const mine = jobs.filter(j => j.openRun?.station === station).sort((a, b) => b.openRun.updated.localeCompare(a.openRun.updated));
    return mine[0] || null;
  }

  logUrl() { return this.run ? `api/runs/${this.run.id}/log.csv` : null; }
}

// What the screen needs from a catalog entry.
function toEntry(j) {
  return {
    ...j, key: j.sha, file: j.lstName, title: j.job,
    url: new URL(`api/jobs/${j.sha}/files/${encodeURIComponent(j.lstName)}`, location.href).href,
    summary: {
      id: j.job, pieces: j.pieces, partNos: j.partNos.length, orders: j.orders.length, example: j.example,
      material: j.material, thickness: j.thickness, w: j.w, h: j.h,
    },
  };
}

// ---------- no service: this browser only ----------

export class LocalBackend {
  constructor() {
    this.mode = 'local';
    this.reachable = true;
    this.health = null;
    this.run = null;
    this.waiting = 0;
    this.onConflict = () => {};
    this.onChange = () => {};
  }

  async refreshHealth() { return null; }

  async listJobs({ scope = 'today', q = '' } = {}) {
    let list;
    try {
      const res = await fetch(JOB_INDEX, { cache: 'no-store' });
      list = (await res.json()).jobs;
    } catch {
      list = [{ file: 'example-sheet.json', title: 'EX-S001' }];
    }
    const done = readJSON(LOCAL_DONE_KEY, []);
    let jobs = list.map(j => ({ ...j, key: j.file, url: new URL(j.file, new URL(JOB_INDEX, location.href)).href, doneRuns: done.includes(j.title) ? 1 : 0 }));
    if (scope === 'search' && q) jobs = jobs.filter(j => `${j.title} ${j.note || ''}`.toLowerCase().includes(q.toLowerCase()));
    return { jobs, machines: [], machineKnown: false };
  }

  // One run per job in this browser: the saved one (mode 'continue', the default) or a fresh start.
  async open(entry, station, { copyPlanFrom = null, mode = 'continue' } = {}) {
    const saved = readJSON(LOCAL_STATE_KEY, {});
    this.run = { id: 'local', entry };
    if (copyPlanFrom) return { phase: 'cards', plan: copyPlanFrom.plan };
    return mode === 'continue' && saved.job?.url === entry.url ? saved : null;
  }

  // A new test session starts the job again: the saved progress is replaced by the next save.
  async restart() { return this.run; }

  async close() {
    this.run = null;
    try { localStorage.setItem(LOCAL_STATE_KEY, '{}'); } catch { /* not saved */ }
  }

  saveState(station, state, { phase, jobId }) {
    if (!this.run) return;
    const e = this.run.entry;
    try {
      localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({ job: { file: e.file, url: e.url, title: e.title }, jobId, ...state }));
      if (phase === 'done') localStorage.setItem(LOCAL_DONE_KEY, JSON.stringify([...new Set([...readJSON(LOCAL_DONE_KEY, []), jobId])]));
    } catch { /* not saved */ }
  }

  record() {}

  // A job saved in this browser is only continued within the same test session.
  async resumable(station, sessionId) {
    const saved = readJSON(LOCAL_STATE_KEY, {});
    return saved.job?.url && saved.sessionId === sessionId ? { ...saved.job, key: saved.job.file } : null;
  }

  logUrl() { return null; }
}

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
