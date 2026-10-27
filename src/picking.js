// picking.js
// The picking rules, with no screen code: the order pieces are sorted in, which pallet is being
// sorted now, which piece is next, every piece's status, and undo. Every change is announced to
// listeners: the screen redraws, and the test log records it.
//
// The job given to a session already has its pallets (from the operator's pallet plan, plan.js) and
// every piece has its pallet. Sorting goes one pallet at a time: all of pallet 1 (Blue 1), then
// pallet 2 …, nearest piece first within a pallet. When a pallet is complete the next one starts by
// itself. "Pallet full" adds a pallet with the next number and colour and moves the pieces that were
// still left for the full pallet onto it; it is sorted next.
//
// Two ways to confirm (a station setting, kept in ui.js): piece by piece, or a whole pallet at once
// ("Blue 1 done": every piece still open on it is picked), tapping only the pieces that went wrong.
//
// Piece status:  open → picked            (confirm, "picked N" for several at once, or "pallet done")
//                open → missing           (not on the sheet, e.g. dropped through the grid)
//                missing → picked         (found after all)
//                open/picked/missing → scrap   (damaged, cannot be used)
//                picked/missing/scrap → open   (reopen: undo one specific piece, however long ago)

import { palletLook } from './plan.js';

export const PICK_ORDERS = ['pallet', 'nearest'];
export const EDGES = ['bottom', 'top', 'left', 'right'];
export const STATUSES = ['open', 'picked', 'missing', 'scrap'];

const ACTIONS = {
  confirm: { to: 'picked', from: ['open', 'missing'] },
  missing: { to: 'missing', from: ['open'] },
  scrap: { to: 'scrap', from: ['open', 'picked', 'missing'] },
  reopen: { to: 'open', from: ['picked', 'missing', 'scrap'] },
};

export class PickSession {
  // order: 'pallet'  = one pallet at a time (the workflow): pallet 1 first, nearest piece first within it
  //        'nearest' = all pallets at once, always the piece closest to the operator's edge (kept as a
  //                    comparison condition for the usability test)
  // operatorEdge: the sheet edge the operator stands at, in sheet terms (the sheet's (0,0) corner is bottom-left)
  constructor(job, { order = 'pallet', operatorEdge = 'bottom' } = {}) {
    // The session owns its copy of the pallets and of each piece's pallet, because "pallet full" changes them.
    this.job = { ...job, pallets: job.pallets.map(p => ({ ...p })), parts: job.parts.map(p => ({ ...p })) };
    this.parts = new Map(this.job.parts.map(p => [p.uid, p]));
    this.status = new Map(this.job.parts.map(p => [p.uid, 'open']));
    this.palletSeq = this.job.pallets.map(p => p.id);  // sorting order of the pallets
    this.history = [];      // undo stack: [{ kind, changes: [{ uid, from, to }], ... }]
    this.corrections = 0;   // undo and reopen actions (for the summary and the error rate)
    this.listeners = [];
    this.selectedUid = null;
    this.shownUid = undefined;
    this.shownPallet = undefined;
    this.sortSequence(order, operatorEdge);
  }

  get pallets() { return this.palletSeq.map(id => this.job.pallets.find(p => p.id === id)); }
  pallet(id) { return this.job.pallets.find(p => p.id === id) || null; }

  // Change the pick order during a sheet (station settings). Pieces already handled stay as they are.
  setOrder(order, operatorEdge = this.operatorEdge) {
    const before = [this.order, this.operatorEdge].join();
    this.sortSequence(order, operatorEdge);
    if ([this.order, this.operatorEdge].join() === before) return;
    this.selectedUid = null;
    this.emit({ type: 'order', order: this.order, operatorEdge: this.operatorEdge });
    if (this.shownUid !== undefined) this.announceNext();
  }

  sortSequence(order = this.order, operatorEdge = this.operatorEdge) {
    this.order = PICK_ORDERS.includes(order) ? order : 'pallet';
    this.operatorEdge = EDGES.includes(operatorEdge) ? operatorEdge : 'bottom';
    const palletIndex = new Map(this.palletSeq.map((id, i) => [id, i]));
    const dist = p => edgeDistance(p.bbox, this.operatorEdge, this.job.size);
    const along = p => (this.operatorEdge === 'bottom' || this.operatorEdge === 'top') ? p.bbox.minX : p.bbox.minY;
    this.sequence = [...this.job.parts].sort((a, b) =>
      (this.order === 'pallet' ? palletIndex.get(a.pallet) - palletIndex.get(b.pallet) : 0) ||
      dist(a) - dist(b) || along(a) - along(b));
  }

  // The suggested piece: the first piece in the sequence that is still open.
  get next() { return this.sequence.find(p => this.status.get(p.uid) === 'open') || null; }

  // The pallet being sorted now (one pallet at a time). null when sorting all pallets at once, or when done.
  get activePallet() { return this.order === 'pallet' ? (this.next?.pallet ?? null) : null; }

  // The piece the operator is working on: one they tapped, otherwise the suggested piece.
  get current() { return this.selectedUid ? this.parts.get(this.selectedUid) : this.next; }

  get canUndo() { return this.history.length > 0; }

  get isComplete() { return !this.next; }

  can(action, uid = this.current?.uid) { return !!uid && ACTIONS[action].from.includes(this.status.get(uid)); }

  count(status, palletId) {
    return this.job.parts.filter(p => this.status.get(p.uid) === status && (!palletId || p.pallet === palletId)).length;
  }

  // { open, picked, missing, scrap, total } for one pallet, or for the whole sheet without an id.
  progress(palletId) {
    const out = { total: this.job.parts.filter(p => !palletId || p.pallet === palletId).length };
    for (const s of STATUSES) out[s] = this.count(s, palletId);
    return out;
  }

  // Running count per part number on one pallet: [{ partNo, picked, total }].
  breakdown(palletId) {
    const out = new Map();
    for (const p of this.job.parts) {
      if (p.pallet !== palletId) continue;
      if (!out.has(p.partNo)) out.set(p.partNo, { partNo: p.partNo, picked: 0, total: 0 });
      const e = out.get(p.partNo); e.total++;
      if (this.status.get(p.uid) === 'picked') e.picked++;
    }
    return [...out.values()];
  }

  // The open pieces of the active pallet, nearest first ("picked N" takes the first N of these).
  openOnActive() {
    const pal = this.activePallet;
    return pal ? this.sequence.filter(p => p.pallet === pal && this.status.get(p.uid) === 'open') : [];
  }

  // fn(event, session) is called after every change.
  on(fn) { this.listeners.push(fn); }

  emit(event) {
    const e = { time: new Date(), ...event };
    for (const fn of this.listeners) fn(e, this);
  }

  // resumed: true when the progress was restored after a page reload.
  start({ resumed = false } = {}) {
    this.emit({ type: 'start', resumed, order: this.order, operatorEdge: this.operatorEdge, pallets: this.palletSeq.length });
    this.announceNext();
  }

  // Progress as plain data, so it can be saved and survive a page reload.
  snapshot() {
    return {
      status: [...this.status], history: this.history.map(h => JSON.parse(JSON.stringify(h))), corrections: this.corrections,
      pallets: this.job.pallets.map(p => ({ ...p })), palletSeq: [...this.palletSeq],
      palletOf: this.job.parts.map(p => [p.uid, p.pallet]),
    };
  }

  // Put saved progress back. Unknown pieces, pallets or statuses are ignored, so an old save can't break the session.
  restore(snap) {
    if (!snap || !Array.isArray(snap.status)) return false;
    if (Array.isArray(snap.pallets) && Array.isArray(snap.palletSeq) && Array.isArray(snap.palletOf)) {
      const ids = new Set(snap.pallets.map(p => p.id));
      if (snap.palletSeq.every(id => ids.has(id)) && snap.palletOf.every(([uid, pid]) => !this.parts.has(uid) || ids.has(pid))) {
        this.job.pallets = snap.pallets.map(p => ({ ...p }));
        this.palletSeq = [...snap.palletSeq];
        for (const [uid, pid] of snap.palletOf) if (this.parts.has(uid)) this.parts.get(uid).pallet = pid;
      }
    }
    for (const [uid, s] of snap.status) {
      if (this.status.has(uid) && STATUSES.includes(s)) this.status.set(uid, s);
    }
    this.history = (snap.history || []).map(normaliseHistory).filter(h => h && h.changes.every(c => this.status.has(c.uid)));
    this.corrections = Number.isInteger(snap.corrections) ? snap.corrections : 0;
    this.sortSequence();
    return true;
  }

  // Work on another piece than the suggested one (the operator tapped it on the sheet).
  // keepSuggested: also select the suggested piece itself (confirming per pallet, a tap only ever selects).
  select(uid, { keepSuggested = false } = {}) {
    if (!this.parts.has(uid)) return false;
    const suggested = this.next?.uid ?? null;
    this.selectedUid = uid === suggested && !keepSuggested ? null : uid;
    this.emit({ type: 'select', uid, suggested });
    return true;
  }

  clearSelection() {
    if (!this.selectedUid) return;
    this.selectedUid = null;
    this.emit({ type: 'deselect' });
  }

  // The actions. Without a uid they act on the current piece.
  // via: how the operator did it ('button', 'tap' or 'batch'), recorded for the usability study.
  confirm(uid, via = 'button') { return this.apply('confirm', uid, via); }
  markMissing(uid, via = 'button') { return this.apply('missing', uid, via); }
  markScrap(uid, via = 'button') { return this.apply('scrap', uid, via); }
  reopen(uid, via = 'button') { return this.apply('reopen', uid, via); }

  apply(action, uid = this.current?.uid, via = 'button') {
    if (!this.can(action, uid)) return false;
    const from = this.status.get(uid);
    const suggested = this.next?.uid ?? null;
    // On the active pallet any open piece is as good as the suggested one: it is not "out of order".
    const outOfOrder = uid !== suggested && !(this.order === 'pallet' && this.parts.get(uid).pallet === this.activePallet);
    this.status.set(uid, ACTIONS[action].to);
    this.history.push({ kind: action, changes: [{ uid, from, to: ACTIONS[action].to }] });
    if (action === 'reopen') this.corrections++;
    this.selectedUid = null;
    this.emit({ type: action, uid, from, to: ACTIONS[action].to, via, suggested, outOfOrder });
    this.announceNext();
    return true;
  }

  // "Picked 4": the operator took several pieces of the active pallet at once. The n nearest open
  // pieces are confirmed together; one Undo takes them all back.
  confirmMany(n) { return this.pickAll(this.openOnActive().slice(0, Math.max(0, Math.floor(n))), 'batch'); }

  // "Blue 1 done": every piece still open on the pallet being sorted is picked; pieces marked missing or
  // scrap stay as they are. One Undo takes the whole pallet back. Then the next pallet starts by itself.
  // via: 'button' or 'key' (a push button at the station). Returns the number of pieces picked (0 if none open).
  palletDone(via = 'button') {
    const pallet = this.activePallet;
    const startedAt = this.palletStartedAt;
    const take = this.openOnActive();
    return this.pickAll(take, 'pallet', () =>
      this.emit({ type: 'pallet_done', pallet, via, count: take.length, msSincePallet: startedAt ? Date.now() - startedAt : null }));
  }

  // Pick several pieces as one action (one undo step). via: 'batch' (picked N) or 'pallet' (pallet done).
  // before(): called after the pieces are picked, before the next piece or pallet is announced.
  pickAll(take, via, before = null) {
    if (!take.length) return 0;
    const batch = `${via === 'pallet' ? 'P' : 'B'}${Date.now().toString(36)}`;
    const changes = [];
    for (const p of take) {
      const suggested = this.next?.uid ?? null;
      this.status.set(p.uid, 'picked');
      changes.push({ uid: p.uid, from: 'open', to: 'picked' });
      this.emit({ type: 'confirm', uid: p.uid, from: 'open', to: 'picked', via, batch, suggested, outOfOrder: false });
    }
    this.history.push({ kind: via === 'pallet' ? 'pallet_done' : 'batch', changes });
    this.selectedUid = null;
    if (before) before();
    this.announceNext();
    return take.length;
  }

  // "Pallet full": add a pallet (next number and colour) and move the pieces still open for the
  // active pallet onto it. The new pallet is sorted next. Returns the new pallet, or null.
  palletFull() {
    const fromId = this.activePallet;
    const moving = this.openOnActive();
    if (!fromId || !moving.length) return null;
    const num = this.job.pallets.length + 1;
    const id = `P${Math.max(0, ...this.job.pallets.map(p => parseInt(p.id.slice(1), 10) || 0)) + 1}`;
    const pallet = { id, ...palletLook(num), addedDuringSort: true };
    this.job.pallets.push(pallet);
    this.palletSeq.splice(this.palletSeq.indexOf(fromId) + 1, 0, id);
    for (const p of moving) p.pallet = id;
    this.history.push({ kind: 'pallet_full', from: fromId, pallet: id, uids: moving.map(p => p.uid), changes: [] });
    this.selectedUid = null;
    this.sortSequence();
    this.emit({ type: 'pallet_full', pallet: id, fromPallet: fromId, moved: moving.length });
    this.announceNext('pallet_full');
    return pallet;
  }

  // Take back the last action; can be repeated.
  undo() {
    const last = this.history.pop();
    if (!last) return false;
    this.corrections++;
    if (last.kind === 'pallet_full') {
      for (const uid of last.uids) this.parts.get(uid).pallet = last.from;
      const removed = this.pallet(last.pallet);
      this.job.pallets = this.job.pallets.filter(p => p.id !== last.pallet);
      this.palletSeq = this.palletSeq.filter(id => id !== last.pallet);
      this.sortSequence();
      this.selectedUid = null;
      this.emit({ type: 'undo', undid: 'pallet_full', pallet: last.pallet, removed, fromPallet: last.from });
    } else {
      for (const c of last.changes) this.status.set(c.uid, c.from);
      this.selectedUid = null;
      const c = last.changes[0];
      const undid = last.kind === 'batch' || last.kind === 'pallet_done' ? last.kind : c.to;
      this.emit({ type: 'undo', uid: c.uid, from: c.to, to: c.from, undid, restored: c.from, count: last.changes.length, pallet: this.parts.get(c.uid).pallet });
    }
    this.announceNext('undo');
    return true;
  }

  // Tell listeners when a different piece becomes the suggested one (used for time-per-pick),
  // and when sorting moves on to another pallet. reason: why the pallet changed, when it is not
  // because the previous pallet is complete ('pallet_full', 'undo').
  announceNext(reason = null) {
    const uid = this.next?.uid ?? null;
    const pal = this.activePallet;
    if (pal !== this.shownPallet) {
      const prev = this.shownPallet;
      this.shownPallet = pal;
      this.palletStartedAt = pal ? Date.now() : null;   // for "time per pallet" (counts from a reload after one)
      if (pal) this.emit({ type: 'pallet', pallet: pal, previous: prev ?? null, reason });
    }
    if (uid === this.shownUid) return;
    this.shownUid = uid;
    this.emit(uid ? { type: 'shown', uid } : { type: 'complete', ...this.progress(), pallets: this.palletSeq.length, corrections: this.corrections });
  }
}

// Saves from the earlier version stored one { uid, from, to } per undo step.
function normaliseHistory(h) {
  if (!h || typeof h !== 'object') return null;
  if (Array.isArray(h.changes)) return h.changes.every(c => STATUSES.includes(c.from) && STATUSES.includes(c.to)) ? h : null;
  if (h.uid && STATUSES.includes(h.from) && STATUSES.includes(h.to)) return { kind: h.to === 'open' ? 'reopen' : 'confirm', changes: [{ uid: h.uid, from: h.from, to: h.to }] };
  return null;
}

// How far a piece's box is from the operator's edge of the sheet, in mm.
function edgeDistance(b, edge, size) {
  switch (edge) {
    case 'top': return size.h - b.maxY;
    case 'left': return b.minX;
    case 'right': return size.w - b.maxX;
    default: return b.minY;
  }
}
