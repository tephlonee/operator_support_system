// picking.test.js
// Checks the picking rules: one pallet at a time, confirm, "picked N", "pallet done", "pallet full", progress per pallet
// and per part, undo, the exceptions (missing, scrap, picked out of order), save/restore, and the events
// the test log uses. The job is the example sheet with the app's proposed pallet plan (one per order).

import { PickSession } from '../src/picking.js';
import { check } from './harness.js';
import { exampleSortJob } from './fixtures.js';

export async function testPicking() {
  const job = await exampleSortJob();
  const first = job.pallets[0].id, second = job.pallets[1].id;

  // One pallet at a time: pallet 1 first, nearest to the operator's (bottom) edge first within it.
  const s = new PickSession(job, { order: 'pallet', operatorEdge: 'bottom' });
  const seq = s.sequence.map(p => s.palletSeq.indexOf(p.pallet));
  check('One pallet at a time: pallets come one after another (1, then 2, …)', seq.every((v, i) => i === 0 || seq[i - 1] <= v), seq.join(' '));
  const p1 = s.sequence.filter(p => p.pallet === first).map(p => p.bbox.minY);
  check('One pallet at a time: within a pallet, pieces nearest the operator edge come first', p1.every((y, i) => i === 0 || p1[i - 1] <= y), p1.map(Math.round).join(', '));
  check('Active pallet: sorting starts with pallet 1 (Blue 1)', s.activePallet === first && s.pallet(first).num === 1 && s.pallet(first).key === 'blue', `${s.activePallet}`);

  // All pallets at once (comparison condition): distance to the operator edge only.
  const n = new PickSession(job, { order: 'nearest', operatorEdge: 'top' });
  const d = n.sequence.map(p => job.size.h - p.bbox.maxY);
  check('All pallets at once (operator at top edge): sorted by distance to that edge, no active pallet',
    d.every((v, i) => i === 0 || d[i - 1] <= v) && n.activePallet === null, `first ${n.next.uid}, ${Math.round(d[0])} mm from the edge`);

  // Confirm, progress, events.
  const events = [];
  s.on(e => events.push(e));
  s.start();
  const firstUid = s.next.uid;
  check('Start: announces the pallet and the first piece', events.some(e => e.type === 'pallet' && e.pallet === first) && events.some(e => e.type === 'shown' && e.uid === firstUid),
    events.map(e => e.type).join(', '));
  s.confirm();
  const total1 = job.parts.filter(p => p.pallet === first).length;
  check('Confirm: the piece becomes picked and pallet progress goes up', s.status.get(firstUid) === 'picked' && s.progress(first).picked === 1 && s.progress(first).total === total1,
    `${first} ${s.progress(first).picked} / ${s.progress(first).total}`);
  const bd = s.breakdown(first);
  check('Running count per part: the pallet\'s count is broken down by part number',
    bd.reduce((a, b) => a + b.total, 0) === total1 && bd.reduce((a, b) => a + b.picked, 0) === 1, bd.map(b => `${b.picked}/${b.total} × ${b.partNo}`).join(' · '));
  const ce = events.find(e => e.type === 'confirm');
  check('Confirm: event says it was the suggested piece, with a timestamp', ce && ce.uid === firstUid && !ce.outOfOrder && ce.time instanceof Date, ce ? `outOfOrder=${ce.outOfOrder}` : 'no event');

  // Any piece of the active pallet is fine: not "out of order".
  const sameOther = s.openOnActive()[1];
  s.confirm(sameOther.uid, 'tap');
  const se = events.filter(e => e.type === 'confirm').at(-1);
  check('Any open piece of the active pallet can be picked, and is not "out of order"', se.uid === sameOther.uid && se.outOfOrder === false && se.via === 'tap',
    `${sameOther.uid}, outOfOrder=${se.outOfOrder}`);
  s.undo();

  // Undo.
  s.undo();
  check('Undo: the piece is open again and is the next piece again', s.status.get(firstUid) === 'open' && s.next.uid === firstUid, `${firstUid} is ${s.status.get(firstUid)}`);
  check('Undo: nothing more to undo, and both undos count as corrections', !s.canUndo && !s.undo() && s.corrections === 2, `corrections=${s.corrections}`);

  // "Picked 3": three pieces at once, one undo step.
  const before = s.openOnActive().slice(0, 3).map(p => p.uid);
  check('Picked N: confirms the N nearest open pieces of the active pallet', s.confirmMany(3) === 3 && before.every(uid => s.status.get(uid) === 'picked'), before.join(', '));
  const batchEvents = events.filter(e => e.type === 'confirm' && e.via === 'batch');
  check('Picked N: each piece is logged, marked as one batch', batchEvents.length === 3 && new Set(batchEvents.map(e => e.batch)).size === 1, `${batchEvents.length} rows`);
  s.undo();
  check('Picked N: one Undo takes all of them back', before.every(uid => s.status.get(uid) === 'open'), '');

  // Pallet full: a new pallet with the next number and colour gets the open pieces of the active pallet.
  s.confirmMany(2);
  const left = s.openOnActive().map(p => p.uid);
  const np = s.palletFull();
  check('Pallet full: a new pallet gets the next number and colour', np && np.num === job.pallets.length + 1 && np.key === ['blue', 'orange', 'green', 'yellow', 'pink'][np.num - 1],
    np ? `${np.key} ${np.num}` : 'none');
  check('Pallet full: the pieces still open for the full pallet move to the new one, which is sorted next',
    left.every(uid => s.parts.get(uid).pallet === np.id) && s.activePallet === np.id && s.palletSeq.indexOf(np.id) === 1, `${left.length} moved; now ${s.activePallet}`);
  check('Pallet full: the full pallet keeps what is on it and counts as complete', s.progress(first).open === 0 && s.progress(first).picked === 2, JSON.stringify(s.progress(first)));
  const pe = events.filter(e => e.type === 'pallet').at(-1);
  check('Pallet full: the change of pallet is not reported as "pallet complete"', pe.pallet === np.id && pe.reason === 'pallet_full', `reason=${pe.reason}`);
  s.undo();
  check('Undo of pallet full: the pieces go back and the new pallet is gone',
    left.every(uid => s.parts.get(uid).pallet === first) && !s.pallet(np.id) && s.activePallet === first, `${s.pallets.length} pallets`);
  s.undo();

  // When a pallet is complete, the next one starts by itself.
  s.confirmMany(s.openOnActive().length);
  check('Pallet complete: sorting moves on to pallet 2 by itself', s.activePallet === second && events.filter(e => e.type === 'pallet').at(-1).pallet === second, `now ${s.activePallet}`);

  // Missing: the piece is skipped, counted separately, and can still be picked if found.
  const m = s.next.uid;
  s.markMissing();
  check('Missing: the piece is marked missing and the next piece moves on', s.status.get(m) === 'missing' && s.next.uid !== m, `${m} is ${s.status.get(m)}`);
  check('Missing: a missing piece can be picked when found', s.can('confirm', m) && !s.can('missing', m), '');

  // Scrap.
  s.markScrap(firstUid);
  check('Scrap: a picked piece can be marked as scrap, and then cannot be picked', s.status.get(firstUid) === 'scrap' && !s.confirm(firstUid), `${firstUid} is ${s.status.get(firstUid)}`);
  s.undo();

  // Out of order: a piece of another pallet, tapped and confirmed.
  const suggested = s.next.uid;
  const other = s.sequence.find(p => s.status.get(p.uid) === 'open' && p.pallet !== s.activePallet).uid;
  s.select(other);
  s.confirm();
  const oe = events.filter(e => e.type === 'confirm').at(-1);
  check('Out of order: a piece of another pallet is picked and logged as out of order', s.status.get(other) === 'picked' && oe.uid === other && oe.outOfOrder && oe.suggested === suggested,
    `${other} is ${s.status.get(other)}, outOfOrder=${oe.outOfOrder}`);

  // Reopen: undo one specific piece, even if other actions came after it.
  const early = s.sequence.find(p => s.status.get(p.uid) === 'picked' && p.uid !== firstUid).uid;
  s.confirm();
  check('Reopen: a picked piece from earlier can be put back to open', s.reopen(early) && s.status.get(early) === 'open', `${early} is ${s.status.get(early)}`);

  // Save and restore (page reload), including an added pallet.
  s.confirmMany(1);
  const np2 = s.palletFull();
  const copy = new PickSession(job, { order: 'pallet', operatorEdge: 'bottom' });
  copy.restore(JSON.parse(JSON.stringify(s.snapshot())));
  check('Save/restore: progress, undo history, corrections and added pallets survive a page reload',
    [...s.status].every(([uid, st]) => copy.status.get(uid) === st) && copy.history.length === s.history.length && copy.next?.uid === s.next?.uid &&
    copy.corrections === s.corrections && !!np2 && copy.pallet(np2.id)?.num === np2.num && copy.activePallet === s.activePallet,
    `${copy.count('picked')} picked, ${copy.history.length} undo steps, ${copy.pallets.length} pallets`);
  check('Save/restore: an old-style save (one piece per undo step) still loads', copy.restore({ status: [], history: [{ uid: firstUid, from: 'open', to: 'picked' }] }) && copy.history.length === 1, '');

  // Handle everything: the sheet is complete, with the summary numbers.
  while (s.next) s.confirm();
  const done = events.at(-1);
  check('Complete: a "complete" event reports pieces, problems, pallets and corrections',
    s.isComplete && done.type === 'complete' && done.missing === 1 && done.pallets === s.pallets.length && done.corrections === s.corrections,
    `${done.picked} picked, ${done.missing} missing, ${done.pallets} pallets, ${done.corrections} corrections`);

  check('Pallet done: on a finished sheet it does nothing', s.palletDone() === 0 && s.history.at(-1).kind !== 'pallet_done', '');
  testPalletDone(job, first, second);
}

// "Blue 1 done": confirming per pallet. Pieces already marked missing or scrap stay as they are.
function testPalletDone(job, first, second) {
  const pd = new PickSession(job, { order: 'pallet', operatorEdge: 'bottom' });
  const dEvents = [];
  pd.on(e => dEvents.push(e));
  pd.start();
  const onFirst = pd.openOnActive().map(p => p.uid);
  const gone = onFirst[1], broken = onFirst[2];
  pd.markMissing(gone); pd.markScrap(broken);
  const n = pd.palletDone('key');
  check('Pallet done: every piece still open on the pallet is picked; missing and scrap stay',
    n === onFirst.length - 2 && onFirst.every(uid => [gone, broken].includes(uid) || pd.status.get(uid) === 'picked') &&
    pd.status.get(gone) === 'missing' && pd.status.get(broken) === 'scrap', `${n} picked of ${onFirst.length}`);
  const doneRow = dEvents.find(e => e.type === 'pallet_done');
  check('Pallet done: one "pallet_done" event with the count, how it was pressed and the time on the pallet',
    doneRow && doneRow.pallet === first && doneRow.count === n && doneRow.via === 'key' && Number.isFinite(doneRow.msSincePallet), JSON.stringify(doneRow && { ...doneRow, time: undefined }));
  check('Pallet done: each piece is logged as picked "via pallet", in one batch',
    dEvents.filter(e => e.type === 'confirm' && e.via === 'pallet').length === n && new Set(dEvents.filter(e => e.via === 'pallet').map(e => e.batch)).size === 1, '');
  const order = dEvents.map(e => e.type);
  check('Pallet done: the next pallet starts by itself, after the "pallet_done" event',
    pd.activePallet === second && order.lastIndexOf('pallet') > order.indexOf('pallet_done'), `now ${pd.activePallet}`);
  pd.undo();
  check('Undo of pallet done: one Undo opens the whole pallet again (missing and scrap stay) and it is sorted again',
    onFirst.every(uid => [gone, broken].includes(uid) || pd.status.get(uid) === 'open') && pd.status.get(gone) === 'missing' &&
    pd.status.get(broken) === 'scrap' && pd.activePallet === first &&
    dEvents.some(e => e.type === 'undo' && e.undid === 'pallet_done' && e.count === n && e.pallet === first),
    `now ${pd.activePallet}; ${pd.count('open', first)} open`);
  const r = new PickSession(job, { order: 'pallet', operatorEdge: 'bottom' });
  pd.palletDone();
  r.restore(JSON.parse(JSON.stringify(pd.snapshot())));
  r.undo();
  check('Pallet done survives a page reload, and can still be undone after it', r.activePallet === first && r.count('open', first) === n, `${r.count('open', first)} open`);

  // Per pallet, a tap only selects; the suggested piece itself can be selected too.
  const sel = new PickSession(job, { order: 'pallet', operatorEdge: 'bottom' });
  sel.start();
  const sug = sel.next.uid;
  sel.select(sug);
  const plain = sel.selectedUid;
  sel.select(sug, { keepSuggested: true });
  check('Select: the suggested piece can be selected when a tap must not confirm (per pallet)', plain === null && sel.selectedUid === sug && sel.status.get(sug) === 'open', `${sel.selectedUid}`);
}
