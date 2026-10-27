// log.js
// The test log for the usability study. Records every action with a timestamp (job chosen, every setup
// change, part shown, confirm, "picked N", pallet started, pallet done, pallet full, missing, scrap, undo, reopen,
// taps on the sheet, setting changes) and exports it as a CSV file,
// so time per pick and error rate can be worked out. The log is saved in the browser after every
// row, so a page reload during a test loses nothing. With the pipeline service, every row is also sent
// to the server's event log (ui.js passes onRecord), where it can be exported per run or per session.

const STORAGE_KEY = 'operator-picking.log';

// CSV columns, in order. Names stay in English whatever the screen language, for the analysis tools.
export const COLUMNS = [
  'session_id', 'participant', 'condition', 'note', 'seq', 'time_local', 't_session_ms', 'event',
  'uid', 'part_no', 'pallet', 'suggested_uid', 'suggested_part_no', 'out_of_order',
  'from_status', 'to_status', 'via', 'ms_since_shown', 'ms_since_prev_action', 'detail',
];

// Events that count as an operator action (for ms_since_prev_action).
const ACTIONS = new Set(['confirm', 'missing', 'scrap', 'undo', 'reopen', 'pallet_full']);

export class TestLog {
  // storageKey: null keeps the log in memory only (used by the tests, so they never touch a real log).
  // onRecord(row): called with every new row (the app sends it on to the server's event log).
  constructor({ storageKey = STORAGE_KEY, onRecord = null } = {}) {
    this.storageKey = storageKey;
    this.onRecord = onRecord;
    this.saveOk = true;
    if (!this.load()) this.newSession({});
  }

  // Start a new test session: new id, new participant data, empty log.
  newSession({ participant = '', condition = '', note = '', jobId = '' } = {}, now = new Date()) {
    this.session = { id: sessionId(now), participant, condition, note, jobId, startedAt: now.getTime() };
    this.rows = [];
    this.exportedCount = 0;
    this.shownAt = {};      // uid → time it became the suggested part
    this.lastActionAt = null;
    this.save();
  }

  get unexported() { return this.rows.length - this.exportedCount; }

  // Add one row. fields: any of the COLUMNS (uid, part_no, …).
  record(event, fields = {}, now = new Date()) {
    const t = now.getTime();
    const row = {
      session_id: this.session.id, participant: this.session.participant,
      condition: this.session.condition, note: this.session.note,
      seq: this.rows.length + 1, time_local: localTime(now), t_session_ms: t - this.session.startedAt,
      event, ...fields,
    };
    if (event === 'shown' && fields.uid) this.shownAt[fields.uid] = t;
    if (ACTIONS.has(event)) {
      const shown = this.shownAt[fields.suggested_uid ?? fields.uid];
      if (shown != null) row.ms_since_shown = t - shown;
      if (this.lastActionAt != null) row.ms_since_prev_action = t - this.lastActionAt;
      this.lastActionAt = t;
    }
    this.rows.push(row);
    this.save();
    if (this.onRecord) this.onRecord(row);
    return row;
  }

  // Turn an event from the picking session into a row. part(uid) looks up a piece of the job,
  // palletName(id) gives a pallet's name as on its card ("Blue 1").
  recordSessionEvent(e, part, palletName = id => id) {
    const p = e.uid ? part(e.uid) : null;
    const s = e.suggested ? part(e.suggested) : null;
    const detail = e.type === 'start' ? `order=${e.order}; operator_edge=${e.operatorEdge}; pallets=${e.pallets}${e.resumed ? '; resumed after reload' : ''}`
      : e.type === 'order' ? `order=${e.order}; operator_edge=${e.operatorEdge}`
      : e.type === 'complete' ? `picked=${e.picked}; missing=${e.missing}; scrap=${e.scrap}; total=${e.total}; pallets=${e.pallets}; corrections=${e.corrections}`
      : e.type === 'pallet' ? `now sorting ${palletName(e.pallet)}${e.previous ? `; after ${palletName(e.previous)}` : ''}`
      : e.type === 'pallet_full' ? `${e.moved} pieces moved from ${palletName(e.fromPallet)} to the new pallet`
      : e.type === 'pallet_done' ? `${e.count} pieces picked at once${e.msSincePallet != null ? `; ${e.msSincePallet} ms since the pallet started` : ''}`
      : e.type === 'undo' ? `undid ${e.undid}${e.count > 1 ? ` (${e.count} pieces)` : ''}${e.removed ? `; removed ${palletName(e.pallet)}` : ''}`
      : e.batch ? (e.via === 'pallet' ? `pallet done (${e.batch})` : `picked several at once (${e.batch})`)
      : '';
    const pallet = p?.pallet ?? e.pallet;
    return this.record(e.type, {
      uid: e.uid ?? '', part_no: p?.partNo ?? '', pallet: pallet ? palletName(pallet) : '',
      suggested_uid: e.suggested ?? '', suggested_part_no: s?.partNo ?? '',
      // "Out of order" only means something for confirm/missing/scrap, not for undoing one part (reopen).
      out_of_order: e.outOfOrder == null || e.type === 'reopen' ? '' : e.outOfOrder ? 1 : 0,
      from_status: e.from ?? '', to_status: e.to ?? '', via: e.via ?? '', detail,
    }, e.time);
  }

  toCSV() {
    const cell = v => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [COLUMNS.join(','), ...this.rows.map(r => COLUMNS.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
  }

  fileName(now = new Date()) {
    const who = (this.session.participant || 'no-participant').replace(/[^\w-]+/g, '_');
    return `picking-log_${who}_${localTime(now).slice(0, 16).replace(/[: ]/g, '-')}.csv`;
  }

  // Save the CSV as a file. The byte-order mark makes Excel read å, ä, ö correctly.
  download() {
    const blob = new Blob(['﻿' + this.toCSV()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.fileName();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.exportedCount = this.rows.length;
    this.save();
  }

  load() {
    if (!this.storageKey) return false;
    try {
      const d = JSON.parse(localStorage.getItem(this.storageKey));
      if (!d || !d.session || !Array.isArray(d.rows)) return false;
      Object.assign(this, { session: d.session, rows: d.rows, exportedCount: d.exportedCount || 0, shownAt: d.shownAt || {}, lastActionAt: d.lastActionAt ?? null });
      return true;
    } catch { return false; }
  }

  save() {
    if (!this.storageKey) return;
    try {
      const { session, rows, exportedCount, shownAt, lastActionAt } = this;
      localStorage.setItem(this.storageKey, JSON.stringify({ session, rows, exportedCount, shownAt, lastActionAt }));
      this.saveOk = true;
    } catch { this.saveOk = false; }
  }
}

// "2026-10-06 09:41:12.345" in the computer's local time.
function localTime(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Short readable id, e.g. "S20261006-0941-k3f9".
function sessionId(d) {
  const p = n => String(n).padStart(2, '0');
  return `S${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
}
