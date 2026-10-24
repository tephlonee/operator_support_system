// setup-view.js
// The setup screens at the start of a job, shown in the right-hand panel (made wide while setting up):
//   1. Choose the job.
//   2. How many pallets? (the app suggests one per order)
//   3. Which parts go on which pallet? (move a part, split a quantity, add/remove a pallet,
//      and the look-alike check with both outlines side by side and the difference circled in red)
//   4. Hang the cards ("Hang Blue 1, Orange 2, …"), then Ready.
// These functions only build the screen; ui.js owns the state and passes callbacks for every button.

import { t } from './i18n.js';
import { drawPartPicture } from './sheet-view.js';
import { palletLook } from './plan.js';

export const SETUP_STEPS = 4;

// "Blue 1", "Orange 2" … in the current language.
export const palletName = p => t('palletLabel', { colour: t(`colour_${p.key}`), num: p.num });

// ---------- 1. choose the job ----------

// The job list. With the pipeline service: today's jobs for this station's machine, a search (job,
// part number or order; date; machine), and for every job what state it is in: in progress here or at
// another station, sorted, a part file missing or damaged, replaced or removed on Z:\.
// The search form is built once and kept while the list refreshes, so typing is never interrupted.
//   list: { scope, q, date, machine, machines, machineKnown, total, loading, error }
export function renderJobList(root, { jobs, station, mode, list, fmtTime, fmtNum, onPick, onSearch, onToday }) {
  if (root.dataset.view !== `jobs-${mode}`) {
    root.dataset.view = `jobs-${mode}`;
    const head = node('div', 'setup-head');
    head.append(node('div', 'eyebrow'), node('h2'), node('p', 'help'));
    root.replaceChildren(head, searchForm(mode, onSearch, onToday), node('p', 'job-caption'), node('div', 'job-list'));
  }
  const [head, form, caption, listEl] = root.children;
  head.children[0].textContent = t('setupStep', { n: 1, of: SETUP_STEPS });
  head.children[1].textContent = t('step1Title');
  head.children[2].textContent = mode === 'server' ? t('step1HelpServer') : t('step1Help');
  syncForm(form, list);

  caption.textContent = list.error ? list.error
    : list.scope === 'search' ? t('listSearch', { n: list.total ?? jobs.length })
      : list.machineKnown ? t('listToday', { machine: list.machine }) : t('listTodayAll');
  caption.classList.toggle('error', !!list.error);

  const cards = jobs.map(j => jobCard(j, { station, mode, fmtTime, fmtNum, onPick }));
  if (!jobs.length && !list.loading) cards.push(node('p', 'help job-empty', list.scope === 'search' ? t('noJobsFound') : t('noJobsToday')));
  listEl.replaceChildren(...cards);
}

function jobCard(j, { station, mode, fmtTime, fmtNum, onPick }) {
  const s = j.summary;
  const b = button('job-card', null, () => onPick(j));
  b.disabled = !!j.error;
  const run = j.openRun;
  const head = node('div', 'job-head');
  head.append(node('span', 'job-title', s?.id || j.title));
  const tag = j.error ? ['is-error', t('jobError')]
    : run ? ['is-progress', run.station === station ? t('jobInProgressHere', run) : t('jobInProgressAt', run)]
      : j.doneRuns ? ['is-done', j.doneRuns > 1 ? t('jobDoneN', { n: j.doneRuns }) : t('jobDone')]
        : j.status === 'incomplete' ? ['is-warn', t('jobIncomplete')]
          : j.status === 'suspect' ? ['is-warn', t('jobSuspect')]
            : s?.example ? ['is-example', t('jobExample')] : ['is-real', t('jobReal')];
  head.append(node('span', `job-tag ${tag[0]}`, tag[1]));
  b.append(head);
  b.append(node('div', 'job-line', j.error ? j.error : s
    ? t('jobPieces', { pieces: s.pieces, parts: s.partNos, orders: s.orders })
    : t('loading')));
  if (s) b.append(node('div', 'job-sub', `${s.material} ${fmtNum(s.thickness)} mm · ${fmtNum(s.w)} × ${fmtNum(s.h)} mm`));
  if (mode === 'server') {
    const where = [j.machine, j.paths?.[0], j.paths?.length > 1 ? t('jobCopies', { n: j.paths.length }) : '', t('jobArrived', { time: fmtTime(j.firstSeen) })];
    b.append(node('div', 'job-sub', where.filter(Boolean).join(' · ')));
  }
  const notes = [   // [text, is a warning]
    [j.missing?.length && t('jobMissingNote', { parts: j.missing.join(', ') }), true],
    [j.suspect?.length && t('jobSuspectNote', { parts: j.suspect.map(x => x.partNo).join(', ') }), true],
    [(j.status === 'replaced' || j.newerVersion) && t('jobNewer'), true],
    [j.status === 'removed' && t('jobRemoved'), false],
    [j.note, false],
  ].filter(([text]) => text);
  for (const [text, warn] of notes) b.append(node('div', `job-note${warn ? ' is-warn' : ''}`, text));
  return b;
}

function searchForm(mode, onSearch, onToday) {
  const form = node('form', 'job-search');
  form.setAttribute('role', 'search');
  const q = node('input', 'search-q');
  q.type = 'search'; q.name = 'q'; q.autocomplete = 'off';
  form.append(q);
  if (mode === 'server') {
    const date = node('input', 'search-date');
    date.type = 'date'; date.name = 'date';
    const machine = node('select', 'search-machine');
    machine.name = 'machine';
    form.append(date, machine);
  }
  const go = button('btn btn-search', null, null);
  go.type = 'submit';
  const today = button('btn btn-today', null, () => onToday());
  form.append(go, today);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    onSearch({ q: form.elements.q.value.trim(), date: form.elements.date?.value || '', machine: form.elements.machine?.value || '' });
  });
  return form;
}

// Labels in the current language, and the values from the list state (never while someone types).
function syncForm(form, list) {
  const el = form.elements;
  el.q.placeholder = t('searchPlaceholder');
  el.q.setAttribute('aria-label', t('searchPlaceholder'));
  form.querySelector('.btn-search').textContent = t('searchBtn');
  form.querySelector('.btn-today').textContent = t('todayBtn');
  form.querySelector('.btn-today').classList.toggle('is-on', list.scope !== 'search');
  if (document.activeElement !== el.q && el.q.value !== list.q) el.q.value = list.q || '';
  if (el.date) {
    el.date.setAttribute('aria-label', t('searchDate'));
    if (document.activeElement !== el.date) el.date.value = list.date || '';
  }
  if (el.machine) {
    const want = ['', ...(list.machines || [])];
    const have = [...el.machine.options].map(o => o.value);
    if (want.join('|') !== have.join('|')) {
      el.machine.replaceChildren(...want.map(m => { const o = node('option', null, m || t('machineAll')); o.value = m; return o; }));
    } else el.machine.options[0].textContent = t('machineAll');
    el.machine.setAttribute('aria-label', t('searchMachine'));
    if (document.activeElement !== el.machine) el.machine.value = want.includes(list.machine) ? list.machine : '';
  }
}

// ---------- 2. how many pallets ----------

export function renderCount(root, { count, suggested, orders, max, onChange, onNext, onBack }) {
  const body = node('div', 'count-body');
  const row = node('div', 'stepper');
  const minus = button('btn btn-step', '−', () => onChange(count - 1)); minus.disabled = count <= 1;
  const plus = button('btn btn-step', '+', () => onChange(count + 1)); plus.disabled = count >= max;
  minus.setAttribute('aria-label', t('fewer')); plus.setAttribute('aria-label', t('more'));
  row.append(minus, node('div', 'count-number', String(count)), plus);
  body.append(row, node('div', 'count-word', t('palletsWord')));
  if (count !== suggested) body.append(button('btn btn-link', t('useSuggested', { n: suggested }), () => onChange(suggested)));
  const chips = node('div', 'chip-row');
  for (let i = 1; i <= count; i++) chips.append(chip(palletLook(i)));
  body.append(chips, node('p', 'help', t('colourOrderHelp')));
  frame(root, 2, t('step2Title'), t('step2Help', { n: suggested, orders: orders.join(', ') }), body,
    nav(onBack, onNext, t('stepNext')));
}

// ---------- 3. which parts on which pallet ----------

export function renderAssign(root, { plan, job, pairs, splitOpen, onMove, onShift, onToggleSplit, onAddPallet, onRemovePallet, onNext, onBack, colorOfLine }) {
  const pallets = plan.view;
  const draws = [];
  const body = node('div', 'assign-body');

  // The pallets, with what is on each and a remove button.
  const head = node('div', 'pallet-strip');
  for (const p of pallets) {
    const box = node('div', `pallet-pill${p.total ? '' : ' is-empty'}`);
    box.style.setProperty('--pallet', p.hex); box.style.setProperty('--ink', p.ink);
    box.append(node('span', 'pill-swatch', String(p.num)), node('span', 'pill-name', palletName(p)),
      node('span', 'pill-count', p.total ? t('pcs', { n: p.total }) : t('palletEmpty')));
    if (pallets.length > 1) {
      const rm = button('btn btn-mini', '×', () => onRemovePallet(p.id));
      rm.setAttribute('aria-label', t('removePalletAria', { pallet: palletName(p) }));
      box.append(rm);
    }
    head.append(box);
  }
  const add = button('btn btn-add', t('addPallet'), onAddPallet);
  add.disabled = pallets.length >= 12;
  head.append(add);
  body.append(head);

  // One row per part number and order.
  const rows = node('div', 'line-list');
  for (const line of plan.lines) {
    const geo = job.geos.get(line.partNo);
    const partner = pairs.find(x => x.a === line.partNo || x.b === line.partNo);
    const row = node('div', `line${splitOpen.has(line.id) ? ' is-split' : ''}`);
    const pic = svg('line-pic'); draws.push(() => drawPartPicture(pic, geo, { fill: colorOfLine(line) }));
    const text = node('div', 'line-text');
    text.append(node('div', 'line-part', line.partNo),
      node('div', 'line-sub', t('qtyOrder', { qty: line.qty, order: line.order })));
    if (geo.boxOnly) text.append(node('div', 'line-flag is-missing', geo.suspect ? t('boxOnlySuspect') : t('boxOnly')));
    if (partner) text.append(node('div', 'line-flag is-lookalike', t('lookAlikeOf', { part: partner.a === line.partNo ? partner.b : partner.a })));
    const chips = node('div', 'line-chips');
    for (const p of pallets) {
      const q = plan.qtyOn(line.id, p.id);
      const c = node('div', 'line-cell');
      const b = button(`chip-btn${q ? ' is-on' : ''}`, null, () => onMove(line.id, p.id));
      b.style.setProperty('--pallet', p.hex); b.style.setProperty('--ink', p.ink);
      b.append(node('span', 'chip-num', String(p.num)), node('span', 'chip-qty', q ? `× ${q}` : ''));
      b.setAttribute('aria-label', t('moveLineAria', { part: line.partNo, pallet: palletName(p) }));
      c.append(b);
      if (splitOpen.has(line.id)) {
        const s = node('div', 'split-steps');
        const minus = button('btn btn-mini', '−', () => onShift(line.id, p.id, -1));
        const plus = button('btn btn-mini', '+', () => onShift(line.id, p.id, +1));
        minus.disabled = !q || plan.palletsOfLine(line.id).length < 2;
        plus.disabled = q >= line.qty;
        s.append(minus, plus);
        c.append(s);
      }
      chips.append(c);
    }
    const split = button('btn btn-split', splitOpen.has(line.id) ? t('splitDone') : t('split'), () => onToggleSplit(line.id));
    split.disabled = line.qty < 2 || pallets.length < 2;
    row.append(pic, text, chips, split);
    rows.append(row);
  }
  body.append(rows);

  // Look-alike check.
  const check = plan.check();
  if (pairs.length) {
    const box = node('div', 'lookalikes');
    box.append(node('h3', null, t('laTitle')));
    for (const pair of pairs) {
      const warn = check.lookAlikes.some(x => x.pair === pair);
      box.append(lookAlikeCard(pair, job, plan, warn, draws));
    }
    body.append(box);
  }
  const problems = check.empty.map(id => t('emptyBlock', { pallet: palletName(plan.palletById(id)) }));
  if (problems.length) body.append(node('p', 'help error', problems.join(' ')));
  const n = nav(onBack, onNext, t('stepNext'));
  n.querySelector('.btn-next').disabled = !check.ok;
  frame(root, 3, t('step3Title'), t('step3Help'), body, n);
  draws.forEach(d => d());
}

// Both outlines side by side, the differing features circled in red, and what the difference is.
export function lookAlikeCard(pair, job, plan, warn, draws) {
  const card = node('div', `la-card${warn ? ' is-warn' : ' is-ok'}`);
  const words = describePair(pair, job);
  const pics = node('div', 'la-pics');
  for (const [no, key] of [[pair.a, 'a'], [pair.b, 'b']]) {
    const fig = node('figure', 'la-fig');
    const s = svg('la-pic');
    const where = plan ? plan.palletsOfPart(no).map(id => plan.palletById(id)) : [];
    const fill = where.length === 1 ? where[0].hex : '#9aa5ab';
    draws.push(() => drawPartPicture(s, job.geos.get(no), { fill, markers: pair.regions.map(r => r[key]) }));
    const cap = node('figcaption');
    cap.append(node('strong', null, no));
    if (where.length) cap.append(node('span', 'la-where', ` → ${where.map(palletName).join(', ')}`));
    if (words.caption[key]) cap.append(node('div', 'la-caption', words.caption[key]));
    fig.append(s, cap);
    pics.append(fig);
  }
  card.append(pics);
  for (const line of words.lines) card.append(node('p', 'la-line', line));
  card.append(node('p', `la-status ${warn ? 'is-warn' : 'is-ok'}`, warn ? t('laWarn') : t('laOk')));
  return card;
}

// Plain words for a look-alike pair: what tells them apart, and for mirror images on which side.
export function describePair(pair, job) {
  const caption = {};
  const lines = [];
  if (pair.sameOutline) lines.push(t('laSame'));
  else if (pair.mirrored) {
    for (const [no, key] of [[pair.a, 'a'], [pair.b, 'b']]) {
      const own = pair.regions.filter(r => r.has === key.toUpperCase());
      const r = own[0] || pair.regions[0];
      if (r) caption[key] = t('laMirrored', { feature: t(`feature_${own[0] ? r.kind : 'extra'}`), side: t(`side_${sideOf(job.geos.get(no), r[key])}`) });
    }
    lines.push(t('laMirrorLine'));
  } else {
    const groups = new Map();
    for (const r of pair.regions) {
      const k = `${r.has}|${r.kind}`;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    for (const [k, n] of groups) {
      const [has, kind] = k.split('|');
      const part = has === 'A' ? pair.a : pair.b;
      lines.push(t(kind === 'hole' ? (n === 1 ? 'laHole1' : 'laHoleN') : 'laExtra', { part, n }));
    }
  }
  // floor: never claim 100 % for parts that differ. Mirror images are identical once one is turned over.
  lines.push(pair.mirrored ? t('laMirrorSame') : t('laSimilar', { pct: Math.floor(pair.overlap * 100) }));
  return { lines, caption };
}

// Where a point is on a part as drawn (seen from above, not turned): left, right, top, bottom or middle.
export function sideOf(geo, p) {
  const b = geo.bbox;
  const dx = (p.x - (b.minX + b.maxX) / 2) / (b.maxX - b.minX), dy = (p.y - (b.minY + b.maxY) / 2) / (b.maxY - b.minY);
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.12) return 'middle';
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy > 0 ? 'top' : 'bottom');
}

// ---------- 4. hang the cards ----------

export function renderCards(root, { pallets, onReady, onBack }) {
  const body = node('div', 'cards-body');
  body.append(node('p', 'hang-line', t('hangLine', { list: pallets.map(palletName).join(', ') })));
  const grid = node('div', 'card-grid');
  for (const p of pallets) {
    const c = node('div', 'hang-card');
    c.style.setProperty('--pallet', p.hex); c.style.setProperty('--ink', p.ink);
    const face = node('div', 'hang-face');
    face.append(node('span', 'hang-num', String(p.num)), node('span', 'hang-name', t(`colour_${p.key}`).toUpperCase()));
    c.append(face);
    const what = node('ul', 'hang-parts');
    for (const part of p.parts) what.append(node('li', null, t('cardParts', { qty: part.qty, part: part.partNo, orders: part.orders.join(', ') })));
    c.append(what);
    grid.append(c);
  }
  body.append(grid);
  frame(root, 4, t('step4Title'), t('step4Help'), body, nav(onBack, onReady, t('ready'), 'btn-go'));
}

// ---------- helpers ----------

function chip(p) {
  const c = node('span', 'pallet-chip');
  c.style.setProperty('--pallet', p.hex); c.style.setProperty('--ink', p.ink);
  c.textContent = palletName(p);
  return c;
}

// The common frame of a setup step: "Setup 2 of 4", title, help text, the step's content, Back/Next.
function frame(root, step, title, help, body, navRow) {
  root.dataset.view = 'step';
  const head = node('div', 'setup-head');
  head.append(node('div', 'eyebrow', t('setupStep', { n: step, of: SETUP_STEPS })), node('h2', null, title));
  if (help) head.append(node('p', 'help', help));
  root.replaceChildren(head, body, ...(navRow ? [navRow] : []));
}

function nav(onBack, onNext, nextLabel, extra = '') {
  const row = node('div', 'setup-nav');
  const back = button('btn btn-back-step', t('stepBack'), onBack);
  const next = button(`btn btn-next ${extra}`, nextLabel, onNext);
  row.append(back, next);
  return row;
}

function button(className, text, onClick) {
  const b = node('button', className, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function svg(className) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', className);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

// Data from files goes in with textContent, never as HTML.
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
