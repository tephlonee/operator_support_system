// log.test.js
// Checks the test log: timings (time since the part was shown, time between actions), the CSV format,
// and that events from the picking session become complete rows. Uses a log that is never saved
// in the browser (storageKey: null), so running the tests can't touch a real study log.

import { TestLog, COLUMNS } from '../src/log.js';
import { PickSession } from '../src/picking.js';
import { check } from './harness.js';
import { exampleSortJob } from './fixtures.js';

export async function testLog() {
  const t0 = new Date('2026-10-06T09:00:00');
  const at = ms => new Date(t0.getTime() + ms);
  const log = new TestLog({ storageKey: null });
  log.newSession({ participant: 'P07', condition: 'with auto-zoom', note: 'left-handed, "fast"', jobId: 'EX-S001' }, t0);

  log.record('shown', { uid: 'A' }, at(1000));
  const r1 = log.record('confirm', { uid: 'A', suggested_uid: 'A' }, at(3500));
  log.record('shown', { uid: 'B' }, at(3500));
  log.record('tap', { uid: 'B' }, at(4000));
  const r2 = log.record('missing', { uid: 'B', suggested_uid: 'B' }, at(9500));
  check('Log: time since the part was shown (time per pick)', r1.ms_since_shown === 2500 && r2.ms_since_shown === 6000, `${r1.ms_since_shown} ms, ${r2.ms_since_shown} ms`);
  check('Log: time since the previous action (taps do not count as actions)', r1.ms_since_prev_action === undefined && r2.ms_since_prev_action === 6000, `${r2.ms_since_prev_action} ms`);
  check('Log: every row carries the session data and a running number', log.rows.every((r, i) => r.participant === 'P07' && r.condition === 'with auto-zoom' && r.seq === i + 1),
    `${log.rows.length} rows`);
  check('Log: time since session start and local time', r1.t_session_ms === 3500 && r1.time_local === '2026-10-06 09:00:03.500', `${r1.t_session_ms} ms, ${r1.time_local}`);

  const csv = log.toCSV().split('\r\n');
  check('CSV: header row has all columns in order', csv[0] === COLUMNS.join(','), csv[0].slice(0, 60) + '…');
  check('CSV: one line per event', csv.filter(Boolean).length === log.rows.length + 1, `${csv.filter(Boolean).length - 1} event lines`);
  check('CSV: commas and quotes in a note are escaped correctly', csv[1].includes('"left-handed, ""fast"""'), csv[1].split(',').slice(0, 4).join(','));
  check('CSV: file name has the participant and the date', /^picking-log_P07_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/.test(log.fileName(t0)), log.fileName(t0));
  check('Log: counts events not yet exported', log.unexported === log.rows.length, `${log.unexported} not exported`);

  // Events straight from a picking session.
  const job = await exampleSortJob();
  const s = new PickSession(job);
  const part = uid => s.parts.get(uid);
  const live = new TestLog({ storageKey: null });
  live.newSession({ participant: 'P01', jobId: job.id });
  s.on(e => live.recordSessionEvent(e, part));
  s.start();
  const suggested = s.next;
  const other = s.sequence.find(p => p.pallet !== suggested.pallet);
  s.select(other.uid);
  s.confirm(undefined, 'tap');
  const row = live.rows.find(r => r.event === 'confirm');
  check('Log from session: an out-of-order pick has part, pallet, suggested part and "via"',
    row && row.uid === other.uid && row.part_no === other.partNo && row.pallet === other.pallet && row.suggested_uid === suggested.uid &&
    row.suggested_part_no === suggested.partNo && row.out_of_order === 1 && row.via === 'tap' && row.from_status === 'open' && row.to_status === 'picked',
    row ? `${row.part_no} → ${row.pallet}, suggested ${row.suggested_part_no}, via ${row.via}` : 'no row');
  check('Log from session: start, shown and select are recorded too', ['start', 'shown', 'select'].every(ev => live.rows.some(r => r.event === ev)),
    live.rows.map(r => r.event).join(', '));
}
