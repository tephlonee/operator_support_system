// catalog.js
// The job lists the screens ask for, built from the catalog (files + jobs) and the runs.
//
//   today:  the default list for a station. A job is on it when
//             • it has a run that is not finished (whatever day it was started: S6), or
//             • someone worked on it today, or
//             • it is on Z:\ now, has never been sorted, and was first seen in the last few days
//               (programmed yesterday, cut today: S5). Our own clock decides, not the file date.
//   search: everything, filtered by text (job, program, part number, order, path), date and machine.
//
// One entry per job content (hash): two copies of the same file are one job with two paths (S7).

import { LISTED } from './pipeline.js';

export function localDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export function runSummary(r) {
  return {
    id: r.id, runNo: r.run_no, station: r.station, phase: r.phase, picked: r.picked, total: r.total,
    created: r.created, updated: r.updated, finished: r.finished,
  };
}

// Everything the screen needs to show one job in a list and to open it.
export function jobEntry(store, sha, files = store.all('SELECT * FROM files WHERE sha256 = ? OR prev_sha = ?', sha, sha)) {
  const j = store.job(sha);
  if (!j) return null;
  const here = files.filter(f => f.sha256 === sha && LISTED.has(f.status));
  const newer = files.filter(f => f.prev_sha === sha && f.sha256 !== sha && f.status !== 'gone');
  const runs = store.runsOf(sha).map(runSummary);
  const status = here.some(f => f.status === 'incomplete') ? 'incomplete' : here.some(f => f.status === 'suspect') ? 'suspect'
    : here.length ? 'ready' : newer.length ? 'replaced' : 'removed';
  return {
    sha, job: j.job, program: j.program, guid: j.guid, planDate: j.plan_date, machineName: j.machine_name,
    machine: here[0]?.machine ?? files.find(f => f.sha256 === sha || f.prev_sha === sha)?.machine ?? '',
    paths: here.map(f => f.path), onZ: here.length > 0, status,
    newerVersion: newer.length > 0,                  // the file on Z:\ was changed after this version (S8)
    sheetsPlanned: j.sheets_planned, example: !!j.example,
    lstName: j.lst_name, pieces: j.pieces, partNos: (j.part_nos || '').split(' ').filter(Boolean),
    orders: (j.orders || '').split(' ').filter(Boolean), material: j.material, thickness: j.thickness, w: j.sheet_w, h: j.sheet_h,
    missing: parse(j.missing_geos, []), suspect: parse(j.suspect_geos, []),
    firstSeen: j.first_seen, runs,
    openRun: [...runs].reverse().find(r => r.phase !== 'done') || null,
    doneRuns: runs.filter(r => r.phase === 'done').length,
  };
}

export function listJobs(store, { scope = 'today', q = '', date = '', machine = '', now = new Date(), recentDays = 7 } = {}) {
  const files = store.files();
  const shas = new Set(files.filter(f => f.sha256 && LISTED.has(f.status)).map(f => f.sha256));
  for (const r of store.all('SELECT DISTINCT sha256 FROM runs')) shas.add(r.sha256);
  const bySha = new Map();
  for (const f of files) for (const s of [f.sha256, f.prev_sha]) if (s) (bySha.get(s) || bySha.set(s, []).get(s)).push(f);
  let jobs = [...shas].map(s => jobEntry(store, s, bySha.get(s) || [])).filter(Boolean);
  const machines = [...new Set(jobs.map(j => j.machine).filter(Boolean))].sort();

  const today = localDate(now.toISOString());
  const since = now.getTime() - recentDays * 864e5;
  if (scope === 'today') {
    jobs = jobs.filter(j => j.openRun || j.runs.some(r => localDate(r.updated) === today)
      || (j.onZ && !j.doneRuns && Date.parse(j.firstSeen) >= since));
  } else {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    jobs = jobs.filter(j => {
      const hay = [j.job, j.program, ...j.partNos, ...j.orders, ...j.paths, j.machine].join(' ').toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
      if (date && localDate(j.firstSeen) !== date && !j.runs.some(r => localDate(r.created) === date || localDate(r.updated) === date)) return false;
      return true;
    });
  }
  // The station's own machine: only when that machine is known, otherwise everything is shown.
  const machineKnown = !!machine && machines.includes(machine);
  if (machineKnown) jobs = jobs.filter(j => j.machine === machine);
  const lastActivity = j => Math.max(Date.parse(j.firstSeen), ...j.runs.map(r => Date.parse(r.updated)));
  jobs.sort((a, b) => (!!b.openRun - !!a.openRun) || lastActivity(b) - lastActivity(a));
  return { jobs: jobs.slice(0, 200), machines, machineKnown, total: jobs.length };
}
