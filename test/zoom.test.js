// zoom.test.js
// Checks the maths of zooming the sheet by hand (src/sheet-view.js): the point zoomed around stays put,
// the view never gets wider than the whole view or closer than the limit, and never leaves the sheet.

import { zoomViewBox, clampViewBox } from '../src/sheet-view.js';
import { check, near } from './harness.js';

export function testZoom() {
  const ov = [0, 0, 3000, 1500];
  const same = (a, b, tol = 1e-6) => a.every((v, i) => near(v, b[i], tol));
  const show = vb => vb.map(v => Math.round(v)).join(' ');

  // The point zoomed around stays at the same place in the view (same share of the width and height).
  const at = { x: 600, y: 300 };
  const z = zoomViewBox(ov, 2, at, ov);
  check('Zoom: zooming 2× halves the view and keeps the point zoomed around in place',
    near(z[2], 1500, 1e-6) && near(z[3], 750, 1e-6) && near((at.x - z[0]) / z[2], at.x / 3000, 1e-9) && near((at.y - z[1]) / z[3], at.y / 1500, 1e-9), show(z));

  const back = zoomViewBox(z, 1 / 2, at, ov);
  check('Zoom: zooming out again around the same point gives the whole view back', same(back, ov), show(back));

  check('Zoom: can never zoom out past the whole view', same(zoomViewBox(ov, 0.25, at, ov), ov), show(zoomViewBox(ov, 0.25, at, ov)));

  const max = zoomViewBox(ov, 100, at, ov, 8);
  check('Zoom: stops at 8× closer than the whole view', near(max[2], 3000 / 8, 1e-6) && near(max[3], 1500 / 8, 1e-6), show(max));

  // Zooming out in a corner must not show anything past the edge of the whole view.
  const corner = zoomViewBox([2500, 1200, 500, 250], 1 / 2, { x: 2510, y: 1210 }, ov);
  check('Zoom: zooming out in a corner stays inside the whole view', same(corner, [2000, 1000, 1000, 500]), show(corner));

  const moved = clampViewBox([-500, 2000, 1000, 500], ov);
  check('Zoom: a view moved past the edges is pulled back inside', same(moved, [0, 1000, 1000, 500]), show(moved));

  // Steps of 1.5× in and the same number out return to the start (buttons + and −).
  let vb = ov;
  for (let i = 0; i < 3; i++) vb = zoomViewBox(vb, 1.5, { x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 }, ov);
  for (let i = 0; i < 3; i++) vb = zoomViewBox(vb, 1 / 1.5, { x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 }, ov);
  check('Zoom: three presses of + and three of − give the whole view back', same(vb, ov, 1e-6), show(vb));
}
