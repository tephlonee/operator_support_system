// settings.test.js
// Checks the station settings: bad saved values are refused, the "near edge" follows the screen
// orientation, mirror always flips left↔right on the screen, and the pick order can change mid-sheet.

import { sanitize, DEFAULTS } from '../src/settings.js';
import { viewMatrix, nearEdge } from '../src/sheet-view.js';
import { PickSession } from '../src/picking.js';
import * as M from '../src/matrix.js';
import { check, near } from './harness.js';
import { exampleSortJob } from './fixtures.js';

export async function testSettings() {
  // Saved settings come from the browser and may be old or broken: only known values get through.
  const bad = sanitize({ rotation: 45, mirror: 'yes', order: 'random', zoomSmall: 'maybe' });
  check('Settings: unknown values fall back to the defaults', JSON.stringify(bad) === JSON.stringify(DEFAULTS), JSON.stringify(bad));
  const good = sanitize({ rotation: 270, mirror: true, order: 'nearest', confirm: 'piece', zoomSmall: false });
  check('Settings: valid values are kept', good.rotation === 270 && good.mirror === true && good.order === 'nearest' && good.confirm === 'piece' && good.zoomSmall === false, JSON.stringify(good));
  check('Settings: picks are confirmed per pallet unless the station says otherwise', DEFAULTS.confirm === 'pallet' && sanitize({ confirm: 'sometimes' }).confirm === 'pallet', '');
  check('Settings: nothing saved yet gives the defaults', JSON.stringify(sanitize(null)) === JSON.stringify(DEFAULTS), JSON.stringify(sanitize(null)));

  // The sheet edge at the bottom of the screen (= nearest the operator) for every orientation.
  const expected = { 0: 'bottom', 90: 'left', 180: 'top', 270: 'right' };
  for (const mirror of [false, true]) {
    const got = [0, 90, 180, 270].map(r => nearEdge({ rotation: r, mirror }));
    const want = [0, 90, 180, 270].map(r => expected[r]);
    check(`Near edge${mirror ? ' (mirrored)' : ''}: turned 0/90/180/270° puts the sheet's ${want.join('/')} edge at the bottom`,
      got.join() === want.join(), got.join(', '));
  }

  // Mirror flips the picture left↔right on the screen, whatever the rotation.
  const p = { x: 1234, y: 567 };
  const flips = [0, 90, 180, 270].every(r => {
    const a = M.apply(viewMatrix({ rotation: r, mirror: false }), p);
    const b = M.apply(viewMatrix({ rotation: r, mirror: true }), p);
    return near(b.x, -a.x, 1e-9) && near(b.y, a.y, 1e-9);
  });
  check('Mirror: flips the picture left↔right on the screen at every rotation', flips, '');

  // Changing the pick order during a sheet.
  const job = await exampleSortJob();
  const s = new PickSession(job, { order: 'pallet', operatorEdge: 'bottom' });
  const events = [];
  s.on(e => events.push(e));
  s.start();
  s.confirm();
  const picked = s.count('picked');
  s.setOrder('nearest', 'left');
  const left = s.sequence.filter(q => s.status.get(q.uid) === 'open').map(q => q.bbox.minX);
  check('Pick order change: switches to nearest-first from the new edge, picked parts stay picked',
    s.order === 'nearest' && s.operatorEdge === 'left' && s.next.bbox.minX === Math.min(...left) && s.count('picked') === picked,
    `next ${s.next.uid}, ${Math.round(s.next.bbox.minX)} mm from the left edge`);
  check('Pick order change: is announced (for the test log) and the new next part is shown',
    events.some(e => e.type === 'order' && e.order === 'nearest') && events.at(-1).type === 'shown' && events.at(-1).uid === s.next.uid,
    events.slice(-2).map(e => e.type).join(', '));
  const before = events.length;
  s.setOrder('nearest', 'left');
  check('Pick order change: setting the same order again changes nothing', events.length === before, '');
}
