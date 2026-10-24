// fixtures.js
// Shared test data: the example job, turned into a sorting job the way the app does it
// (look-alikes found, the proposed pallet plan, every piece given its pallet).

import { loadJob } from '../src/nest-loader.js';
import { PalletPlan } from '../src/plan.js';
import { findLookAlikes } from '../src/lookalike.js';

export const EXAMPLE_JOB = '../data/jobs/example-sheet.json';
export const J14_JOB = '../data/jobs/J14.LST';

// The job, its look-alike pairs and a pallet plan with n pallets (default: the suggestion, one per order).
export async function planFor(url = EXAMPLE_JOB, n) {
  const job = await loadJob(url);
  const pairs = findLookAlikes(new Map([...job.geos].filter(([, g]) => !g.boxOnly)));
  const plan = new PalletPlan(job, pairs).propose(n);
  return { job, pairs, plan };
}

// What a sorting session gets: the job with the plan's pallets, and every piece with its pallet.
export function sortJobOf(job, plan) {
  const assign = plan.assignPieces();
  return {
    ...job,
    pallets: plan.view.map(p => ({ id: p.id, num: p.num, key: p.key, hex: p.hex, ink: p.ink })),
    parts: job.parts.map(p => ({ ...p, pallet: assign.get(p.uid) })),
  };
}

export async function exampleSortJob(n) {
  const { job, plan } = await planFor(EXAMPLE_JOB, n);
  return sortJobOf(job, plan);
}
