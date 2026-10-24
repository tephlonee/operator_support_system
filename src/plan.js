// plan.js
// The pallet plan: which pallets this job uses and which parts go on each. It is made at the start of
// every job (setup), by the operator, from a proposal. No screen code.
//
//   • A "line" is one part number for one order, e.g. 12 × 1045572 for order OR17.
//   • The app proposes a number of pallets (one per order) and an assignment of lines to pallets.
//     With fewer pallets than orders, whole orders are combined, and look-alike parts are put on
//     the same pallet where possible, so they cannot be mixed up.
//   • The operator can move a whole line to another pallet, split a line over pallets (one piece at
//     a time), and add or remove pallets.
//   • Pallets are numbered 1, 2, 3 … in the order they will be sorted, and get their colour from a
//     fixed colour order (pallet 1 is always Blue). The same colour + number is on the hanging card.
//   • Finally the plan decides which physical pieces on the sheet go to which pallet.

// Colour order for pallet cards: the Okabe–Ito palette, chosen to stay distinguishable for colour-blind
// operators. The number is always shown with the colour, so the colour is never the only cue.
// ink = text colour on top of it. Past 8 pallets the colours repeat with new numbers (Blue 9 …).
export const PALETTE = Object.freeze([
  { key: 'blue', hex: '#0072B2', ink: '#ffffff' },
  { key: 'orange', hex: '#E69F00', ink: '#111111' },
  { key: 'green', hex: '#009E73', ink: '#ffffff' },
  { key: 'yellow', hex: '#F0E442', ink: '#111111' },
  { key: 'pink', hex: '#CC79A7', ink: '#111111' },
  { key: 'sky', hex: '#56B4E9', ink: '#111111' },
  { key: 'red', hex: '#D55E00', ink: '#ffffff' },
  { key: 'black', hex: '#1d1d1d', ink: '#ffffff' },
]);
export const MAX_PALLETS = 12;

// Colour and number of the pallet in position `num` (1-based).
export const palletLook = num => ({ num, ...PALETTE[(num - 1) % PALETTE.length] });

// One line per part number and order, with the pieces (uids) on the sheet that belong to it.
export function linesOf(job) {
  const map = new Map();
  for (const p of job.parts) {
    const id = `${p.partNo}|${p.order}`;
    if (!map.has(id)) map.set(id, { id, partNo: p.partNo, order: p.order, qty: 0, uids: [] });
    const line = map.get(id);
    line.qty++; line.uids.push(p.uid);
  }
  return [...map.values()].sort((a, b) => a.order.localeCompare(b.order) || a.partNo.localeCompare(b.partNo));
}

export class PalletPlan {
  // lookAlikes: pairs from lookalike.js ({ a, b } part numbers); used to keep them together.
  constructor(job, lookAlikes = []) {
    this.job = job;
    this.lines = linesOf(job);
    this.lookAlikes = lookAlikes;
    this.pallets = [];          // [{ id }] in sorting order; number and colour follow from the position
    this.alloc = new Map();     // line id → Map(pallet id → quantity)
    this.lastId = 0;
  }

  get suggestedCount() { return clamp(new Set(this.lines.map(l => l.order)).size, 1, MAX_PALLETS); }

  // Pallets as the screen needs them: id, number, colour, and what is on them.
  get view() {
    return this.pallets.map((p, i) => ({ ...p, ...palletLook(i + 1), total: this.palletTotal(p.id), parts: this.partsOn(p.id) }));
  }

  palletById(id) { return this.view.find(p => p.id === id) || null; }

  // ---- proposal ----

  // Start over with n pallets and the proposed assignment.
  propose(n = this.suggestedCount) {
    n = clamp(Math.round(n), 1, MAX_PALLETS);
    this.pallets = Array.from({ length: n }, () => this.newPallet());
    this.alloc = new Map(this.lines.map(l => [l.id, new Map()]));
    const groups = [...groupBy(this.lines, l => l.order).values()];   // one group per order, in order-name order
    if (n >= groups.length) {
      groups.forEach((g, i) => g.forEach(l => this.put(l.id, this.pallets[i].id, l.qty)));
    } else {
      // Combine orders. The n biggest orders get a pallet each (so no pallet is empty). Every other order
      // goes onto the least loaded pallet, unless a pallet that holds look-alikes of its parts is not much
      // fuller (at most the size of this order more): then it goes there, so the look-alikes stay together.
      const load = new Map(this.pallets.map(p => [p.id, 0]));
      const bySize = [...groups].sort((a, b) => sum(b, l => l.qty) - sum(a, l => l.qty));
      bySize.forEach((g, i) => {
        let target = this.pallets[i];
        if (i >= n) {
          const size = sum(g, l => l.qty);
          const partners = p => sum(g, l => sum(this.partnersOf(l.partNo), no => (this.partOnPallet(no, p.id) ? 1 : 0)));
          const least = Math.min(...load.values());
          const ok = this.pallets.filter(p => partners(p) > 0 && load.get(p.id) - least <= size);
          target = ok.length ? ok.sort((a, b) => partners(b) - partners(a) || load.get(a.id) - load.get(b.id))[0]
            : [...this.pallets].sort((a, b) => load.get(a.id) - load.get(b.id))[0];
        }
        g.forEach(l => this.put(l.id, target.id, l.qty));
        load.set(target.id, load.get(target.id) + sum(g, l => l.qty));
      });
      // Number the pallets in the order of the first order on each, so the plan reads naturally.
      const first = id => Math.min(...this.lines.filter(l => this.qtyOn(l.id, id) > 0).map(l => groups.findIndex(g => g.includes(l))));
      this.pallets.sort((a, b) => first(a.id) - first(b.id));
    }
    return this;
  }

  // ---- the operator's changes ----

  addPallet() {
    if (this.pallets.length >= MAX_PALLETS) return null;
    const p = this.newPallet();
    this.pallets.push(p);
    return p.id;
  }

  // Remove a pallet; its parts go to the pallet before it (or the next one if it was the first).
  removePallet(id) {
    const i = this.pallets.findIndex(p => p.id === id);
    if (i < 0 || this.pallets.length === 1) return false;
    const to = this.pallets[i === 0 ? 1 : i - 1].id;
    for (const line of this.lines) {
      const q = this.qtyOn(line.id, id);
      if (q) { this.put(line.id, to, this.qtyOn(line.id, to) + q); this.alloc.get(line.id).delete(id); }
    }
    this.pallets.splice(i, 1);
    return true;
  }

  // Put the whole line on one pallet.
  moveLine(lineId, palletId) {
    const line = this.line(lineId);
    if (!line || !this.hasPallet(palletId)) return false;
    this.alloc.set(lineId, new Map([[palletId, line.qty]]));
    return true;
  }

  // Split: one piece more (delta +1) or fewer (−1) of this line on this pallet. The piece comes from,
  // or goes back to, the other pallet that holds most of the line. The line always stays complete.
  shift(lineId, palletId, delta) {
    const line = this.line(lineId);
    if (!line || !this.hasPallet(palletId) || Math.abs(delta) !== 1) return false;
    const here = this.qtyOn(lineId, palletId);
    const others = this.pallets.map(p => p.id).filter(id => id !== palletId && this.qtyOn(lineId, id) > 0)
      .sort((a, b) => this.qtyOn(lineId, b) - this.qtyOn(lineId, a));
    if (delta > 0) {
      if (!others.length) return false;                 // everything is already here
      this.put(lineId, others[0], this.qtyOn(lineId, others[0]) - 1);
      this.put(lineId, palletId, here + 1);
    } else {
      if (here === 0 || !others.length) return false;    // nothing here, or nowhere for it to go
      this.put(lineId, palletId, here - 1);
      this.put(lineId, others[0], this.qtyOn(lineId, others[0]) + 1);
    }
    return true;
  }

  // ---- reading the plan ----

  line(id) { return this.lines.find(l => l.id === id) || null; }
  hasPallet(id) { return this.pallets.some(p => p.id === id); }
  qtyOn(lineId, palletId) { return this.alloc.get(lineId)?.get(palletId) || 0; }
  palletsOfLine(lineId) { return this.pallets.map(p => p.id).filter(id => this.qtyOn(lineId, id) > 0); }
  palletTotal(palletId) { return sum(this.lines, l => this.qtyOn(l.id, palletId)); }
  partOnPallet(partNo, palletId) { return this.lines.some(l => l.partNo === partNo && this.qtyOn(l.id, palletId) > 0); }
  palletsOfPart(partNo) { return this.pallets.map(p => p.id).filter(id => this.partOnPallet(partNo, id)); }
  partnersOf(partNo) { return this.lookAlikes.filter(p => p.a === partNo || p.b === partNo).map(p => (p.a === partNo ? p.b : p.a)); }

  // What is on a pallet, per part number: [{ partNo, qty, orders }].
  partsOn(palletId) {
    const out = new Map();
    for (const l of this.lines) {
      const q = this.qtyOn(l.id, palletId);
      if (!q) continue;
      if (!out.has(l.partNo)) out.set(l.partNo, { partNo: l.partNo, qty: 0, orders: [] });
      const e = out.get(l.partNo); e.qty += q; e.orders.push(l.order);
    }
    return [...out.values()];
  }

  // Things to tell the operator before sorting starts:
  //   empty: pallets with nothing on them (sorting cannot start: remove them or put parts on them)
  //   lookAlikes: look-alike pairs that end up on different pallets (allowed, but the screen warns)
  check() {
    const empty = this.pallets.filter(p => this.palletTotal(p.id) === 0).map(p => p.id);
    const lookAlikes = this.lookAlikes
      .filter(pair => this.job.geos.has(pair.a) && this.job.geos.has(pair.b))
      .map(pair => ({ pair, pallets: [...new Set([...this.palletsOfPart(pair.a), ...this.palletsOfPart(pair.b)])] }))
      .filter(x => x.pallets.length > 1);
    return { empty, lookAlikes, ok: !empty.length };
  }

  // Which physical piece goes to which pallet: Map uid → pallet id. Within a line that is split, the
  // pieces nearest each other go together (sorted along the sheet), so each pallet's pieces form a group.
  assignPieces() {
    const box = new Map(this.job.parts.map(p => [p.uid, p.bbox]));
    const out = new Map();
    for (const line of this.lines) {
      const uids = [...line.uids].sort((a, b) => box.get(a).minX - box.get(b).minX || box.get(a).minY - box.get(b).minY);
      let k = 0;
      for (const p of this.pallets) {
        for (let q = this.qtyOn(line.id, p.id); q > 0; q--) out.set(uids[k++], p.id);
      }
    }
    return out;
  }

  // ---- save / restore (page reload during setup) ----

  snapshot() {
    return { pallets: this.pallets.map(p => p.id), lastId: this.lastId, alloc: [...this.alloc].map(([l, m]) => [l, [...m]]) };
  }

  restore(s) {
    if (!s || !Array.isArray(s.pallets) || !s.pallets.length || !Array.isArray(s.alloc)) return false;
    const alloc = new Map(s.alloc.map(([l, m]) => [l, new Map(m)]));
    // Only accept a save that matches this job exactly: same lines, every line complete.
    const ok = this.lines.every(l => alloc.has(l.id) && sum([...alloc.get(l.id)], ([id, q]) => (s.pallets.includes(id) ? q : 0)) === l.qty);
    if (!ok) return false;
    this.pallets = s.pallets.map(id => ({ id }));
    this.alloc = alloc;
    this.lastId = s.lastId || s.pallets.length;
    return true;
  }

  newPallet() { return { id: `P${++this.lastId}` }; }
  put(lineId, palletId, qty) {
    const m = this.alloc.get(lineId);
    if (qty > 0) m.set(palletId, qty); else m.delete(palletId);
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
