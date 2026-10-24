// plan.test.js
// Checks the pallet plan: the suggested number of pallets, the proposal, moving and splitting parts,
// adding and removing pallets, the look-alike warning, which pieces go where, and save/restore.

import { PALETTE, palletLook } from '../src/plan.js';
import { check } from './harness.js';
import { planFor } from './fixtures.js';

export async function testPlan() {
  const { job, plan } = await planFor();
  const complete = () => plan.lines.every(l => plan.pallets.reduce((s, p) => s + plan.qtyOn(l.id, p.id), 0) === l.qty);

  check('Colours: a fixed order, pallet 1 is always Blue, and they repeat with new numbers after 8',
    palletLook(1).key === 'blue' && palletLook(2).key === 'orange' && palletLook(3).key === 'green' && palletLook(9).key === 'blue' && palletLook(9).num === 9 && PALETTE.length === 8,
    PALETTE.map(c => c.key).join(', '));
  check('Suggestion: one pallet per order', plan.suggestedCount === job.orders.length && plan.pallets.length === job.orders.length, `${plan.suggestedCount} pallets for ${job.orders.length} orders`);
  check('Proposal: each order on its own pallet, every line complete',
    complete() && plan.lines.every(l => plan.palletsOfLine(l.id).length === 1) &&
    job.orders.every(o => new Set(plan.lines.filter(l => l.order === o).flatMap(l => plan.palletsOfLine(l.id))).size === 1),
    plan.view.map(p => `${p.num}: ${p.total}`).join(' · '));

  // Fewer pallets than orders: orders are combined, no pallet is empty, look-alikes go together where possible.
  plan.propose(2);
  check('Proposal with fewer pallets: orders are combined, nothing is left out, no pallet is empty',
    complete() && plan.pallets.length === 2 && plan.check().empty.length === 0, plan.view.map(p => `${p.num}: ${p.total} pcs`).join(' · '));
  plan.propose(1);
  check('Proposal with 1 pallet: everything on it, so no look-alike warning', plan.palletTotal(plan.pallets[0].id) === job.parts.length && plan.check().lookAlikes.length === 0, '');

  // More pallets than orders: the extra ones are empty, and sorting cannot start until that is fixed.
  plan.propose(job.orders.length + 1);
  const extra = plan.pallets.at(-1).id;
  check('More pallets than orders: the extra pallet is empty and blocks the next step', plan.check().empty.includes(extra) && !plan.check().ok, '');

  // Move a whole line, split one piece at a time.
  const line = plan.lines.find(l => l.qty >= 2);
  check('Move: a whole part line goes onto one pallet', plan.moveLine(line.id, extra) && plan.qtyOn(line.id, extra) === line.qty && plan.palletsOfLine(line.id).length === 1 && plan.check().ok,
    `${line.id} → ${extra}`);
  const firstId = plan.pallets[0].id;
  check('Split: one piece more on another pallet takes it from where most of the line is',
    plan.shift(line.id, firstId, +1) && plan.qtyOn(line.id, firstId) === 1 && plan.qtyOn(line.id, extra) === line.qty - 1 && complete(), '');
  check('Split: one piece fewer gives it back', plan.shift(line.id, firstId, -1) && plan.qtyOn(line.id, firstId) === 0 && complete(), '');
  check('Split: a line cannot be taken off its only pallet', !plan.shift(line.id, extra, -1) && plan.qtyOn(line.id, extra) === line.qty, '');

  // Which pieces go where: within a split line, the pieces next to each other go together.
  plan.shift(line.id, firstId, +1);
  const assign = plan.assignPieces();
  check('Pieces: every piece on the sheet gets exactly one pallet, matching the plan',
    job.parts.every(p => assign.has(p.uid)) && plan.pallets.every(p => [...assign.values()].filter(v => v === p.id).length === plan.palletTotal(p.id)), `${assign.size} pieces`);

  // Add and remove pallets.
  const n0 = plan.pallets.length;
  const added = plan.addPallet();
  check('Add pallet: a new empty pallet at the end, with the next colour', plan.pallets.length === n0 + 1 && plan.palletById(added).num === n0 + 1 && plan.palletTotal(added) === 0, '');
  const victim = plan.pallets[1].id, had = plan.palletTotal(victim), prevTotal = plan.palletTotal(plan.pallets[0].id);
  check('Remove pallet: its parts go to the pallet before it, and the numbers close up',
    plan.removePallet(victim) && plan.palletTotal(plan.pallets[0].id) === prevTotal + had && complete() && plan.view.every((p, i) => p.num === i + 1),
    `${had} pieces moved to pallet 1`);

  // Look-alikes on different pallets are reported.
  plan.propose();
  const warn = plan.check().lookAlikes;
  check('Look-alike warning: pairs on different pallets are listed', warn.length > 0 && warn.every(w => w.pallets.length > 1), warn.map(w => `${w.pair.a}/${w.pair.b}`).join(', '));

  // Save / restore.
  plan.shift(line.id, plan.pallets.find(p => !plan.qtyOn(line.id, p.id)).id, +1);
  const { plan: other } = await planFor();
  check('Save/restore: the plan survives a page reload', other.restore(JSON.parse(JSON.stringify(plan.snapshot()))) &&
    other.lines.every(l => plan.pallets.every(p => other.qtyOn(l.id, p.id) === plan.qtyOn(l.id, p.id))), '');
  check('Save/restore: a save that does not add up is refused', !other.restore({ pallets: ['P1'], alloc: [] }), '');
}
