// ui.js
// Builds the screen and connects the pieces. The flow for every job:
//
//   A. Setup (setup-view.js, in a wide right-hand panel; the sheet is shown on the left as a preview)
//      1. choose the job  →  2. how many pallets  →  3. which parts on which pallet  →  4. hang the cards
//      A job that already has sorting runs first shows them: continue or take over the open run, restart
//      it from the beginning, or sort a new sheet (with the pallets of the last sorted run, or a new setup).
//   B. Sorting, one pallet at a time (picking.js): only the pallet being sorted is highlighted, the others
//      are grey; the operator sorts the whole pallet and taps "Blue 1 done" (or, as a station setting, taps
//      each piece / "picked N"); the next pallet starts by itself; "Pallet full" adds a pallet.
//   C. Summary: "3 pallets · 33 pieces · 0 corrections", then the next job.
//
// It also keeps the station settings and the test log, saves the progress after every change (backend.js:
// on the pipeline service when there is one, otherwise in this browser), so a page reload, a second screen
// or another station sees the same job state, and redraws the header, the panels, the sheet and the
// pallet tiles after every change.

import { loadJob } from './nest-loader.js';
import { connect } from './backend.js';
import { SheetView, drawPartDetail, drawPartPicture, nearEdge } from './sheet-view.js';
import { PickSession } from './picking.js';
import { PalletPlan, MAX_PALLETS } from './plan.js';
import { findLookAlikes } from './lookalike.js';
import { renderJobList, renderRunCard, renderCount, renderAssign, renderCards, palletName } from './setup-view.js';
import { loadSettings, saveSettings, sanitize, DEFAULTS } from './settings.js';
import { TestLog } from './log.js';
import { t, getLang, setLang, applyStatic, formatNumber } from './i18n.js';
import { ask, tell, isOpen as dialogOpen } from './dialog.js';

const SETUP_PHASES = ['jobs', 'runs', 'count', 'assign', 'cards'];
const REFRESH_MS = 15000;      // job list and health line refresh (the server polls Z:\ every 15 s)
const $ = id => document.getElementById(id);

let backend = null;            // where jobs come from and progress goes (backend.js)
let jobs = [];                 // the job list: [{ key, url, title, summary, status, openRun, … }]
// What the job list shows: today's jobs for this station, or a search.
let listState = { scope: 'today', q: '', date: '', machine: '', machines: [], machineKnown: false, total: 0, loading: true, error: '' };
const jobCache = new Map();    // url → loaded job (a server url names one job content, so it never goes stale)
let entry = null;              // the job list entry of the open job
let cardEntry = null;          // the job whose sorting runs are shown (phase 'runs'), before it is opened
let job = null;                // the open job (nest-loader.js)
let pairs = [];                // look-alike pairs in the job (lookalike.js)
let plan = null;               // the pallet plan being set up (plan.js)
let phase = 'jobs';            // 'jobs' | 'runs' | 'count' | 'assign' | 'cards' | 'sort'
let splitOpen = new Set();     // assignment rows with the split controls open
let session = null;            // the sorting session (picking.js)
let pendingCard = null;        // after "Pallet full": { pallet, from, n } until the operator has hung the card
let view = null;
let message = { key: 'loading', detail: '' };
let feedback = null;           // last feedback, kept as key + values so it can be re-translated
let settings = loadSettings();
let settingsSaved = true;
let panelMode = 'work';        // right-hand panel: 'work' (setup or sorting), 'settings' or 'test'
// Every test-log row also goes to the server's event log (when there is a server).
const log = new TestLog({ onRecord: row => backend?.record(row, settings.stationId) });

const partByUid = uid => session?.parts.get(uid) ?? job.parts.find(p => p.uid === uid);
const palletOfPiece = part => session.pallet(part.pallet);
const isSetup = () => SETUP_PHASES.includes(phase);
// Confirming per pallet: only when sorting one pallet at a time (station setting "Confirming picks").
const perPallet = () => settings.confirm === 'pallet' && session?.order === 'pallet';

// The app's own dialogs (dialog.js), with every question and its answer in the test log.
async function askLogged(id, opts) {
  log.record('dialog', { detail: `${id}; shown` });
  const yes = await ask(opts);
  log.record('dialog', { detail: `${id}; ${yes ? 'yes' : 'no'}` });
  return yes;
}

async function tellLogged(id, opts) {
  log.record('dialog', { detail: `${id}; shown` });
  await tell(opts);
  log.record('dialog', { detail: `${id}; closed` });
}

// ---------- drawing the screen ----------

function render() {
  applyStatic();
  $('lang-btn').textContent = t('switchLang');
  document.querySelector('.main').classList.toggle('is-setup', isSetup() && panelMode === 'work');
  $('message').hidden = !!job;
  if (!job) {
    $('message').textContent = message ? t(message.key) + (message.detail ? `: ${message.detail}` : '') : t('chooseJob');
  }
  renderHeader();
  renderHealth();
  for (const id of ['jobs-btn', 'test-btn']) $(id).hidden = !job;
  $('station-btn').hidden = !backend;    // the station ID is set before choosing a job
  $('setup-panel').hidden = !(isSetup() && panelMode === 'work');
  $('work-panel').hidden = !(phase === 'sort' && panelMode === 'work');
  $('settings-panel').hidden = panelMode !== 'settings';
  $('test-panel').hidden = panelMode !== 'test';
  $('station-btn').setAttribute('aria-pressed', String(panelMode === 'settings'));
  $('test-btn').setAttribute('aria-pressed', String(panelMode === 'test'));
  if (panelMode === 'settings') renderSettings();
  else if (panelMode === 'test') renderTest();
  if (isSetup()) renderSetup();
  else if (session) renderSorting();
  renderPallets();
}

function renderHeader() {
  const n = formatNumber;
  $('sheet-info').textContent = job
    ? `${t('sheet')} ${job.id} · ${job.material} ${n(job.thickness)} mm · ${n(job.size.w)} × ${n(job.size.h)} mm · ${job.parts.length} ${t('parts')}`
    : '';
  // Banner: invented example data; a real job with a part file missing or damaged; or a job that was
  // replaced on Z:\ while this version is being sorted.
  const geos = job ? [...job.geos.values()] : [];
  const missing = geos.filter(g => g.boxOnly && !g.suspect).map(g => g.partNo);
  const suspect = geos.filter(g => g.suspect).map(g => g.partNo);
  const newer = !!(entry && (entry.newerVersion || entry.status === 'replaced'));
  $('example-banner').hidden = !job || (!job.example && !missing.length && !suspect.length && !newer);
  if (job?.example) {
    $('banner-title').textContent = t('exampleBanner');
    const real = [...new Set(job.parts.filter(p => !p.isExample).map(p => p.partNo))];
    $('example-note').textContent = real.length ? t('exampleNoteReal', { real: real.join(', ') }) : t('exampleNote');
  } else if (missing.length || suspect.length) {
    $('banner-title').textContent = t(missing.length ? 'missingGeoBanner' : 'suspectGeoBanner');
    $('example-note').textContent = [missing.length && t('missingGeo', { parts: missing.join(', ') }),
      suspect.length && t('suspectGeo', { parts: suspect.join(', ') }), newer && t('jobNewer')].filter(Boolean).join(' ');
  } else if (newer) {
    $('banner-title').textContent = t('newerBanner');
    $('example-note').textContent = t('jobNewer');
  }
  $('overall').hidden = phase !== 'sort' || !session;
  if (session) {
    const p = session.progress();
    $('overall-text').textContent = t('overall', { done: p.picked, total: p.total });
    $('overall-fill').style.width = `${(100 * (p.picked + p.missing + p.scrap) / p.total).toFixed(1)}%`;
  }
}

// ---------- A. setup ----------

function renderSetup() {
  const root = $('setup-panel');
  if (phase === 'jobs') {
    renderJobList(root, {
      jobs, station: settings.stationId, mode: backend?.mode, list: listState, fmtTime, fmtNum: formatNumber,
      onPick: e => chooseJob(e),
      onSearch: ({ q, date, machine }) => {
        listState = { ...listState, scope: 'search', q, date, machine };
        log.record('job_search', { detail: `q=${q}; date=${date}; machine=${machine}` });
        refreshList();
      },
      onToday: () => {
        listState = { ...listState, scope: 'today', q: '', date: '', machine: settings.stationId };
        refreshList();
      },
    });
    return;
  }
  if (phase === 'runs') {
    const e = cardEntry;
    renderRunCard(root, {
      entry: e, station: settings.stationId, fmtTime,
      onContinue: () => openJob(e, { mode: 'continue' }),
      onRestart: async () => {
        const r = e.openRun;
        const yes = await askLogged('restart', {
          title: t('restartTitle', { job: e.title }),
          text: t('restartAsk', { n: r.runNo, picked: r.picked, total: r.total || e.pieces || '?' })
            + (r.station !== settings.stationId ? t('restartAskOther', { station: r.station }) : ''),
          yes: t('restartYes'), no: t('restartNo'), danger: true,
        });
        if (!yes) { log.record('run_restart_cancelled', { detail: `job=${e.title}; run=${r.runNo}` }); return; }
        openJob(e, { mode: 'restart' });
      },
      onNew: from => openJob(e, { mode: 'new', nextFrom: from ? { runId: from.id } : null }),
      onBack: () => { cardEntry = null; phase = 'jobs'; render(); refreshList(); },
    });
    return;
  }
  if (phase === 'count') {
    renderCount(root, {
      count: plan.pallets.length, suggested: plan.suggestedCount, orders: job.orders, max: MAX_PALLETS,
      onChange: n => { plan.propose(n); splitOpen.clear(); log.record('pallet_count', { detail: `pallets=${plan.pallets.length}; suggested=${plan.suggestedCount}` }); setupChanged(); },
      onNext: () => goStep('assign'),
      onBack: closeJob,
    });
  } else if (phase === 'assign') {
    renderAssign(root, {
      plan, job, pairs, splitOpen,
      colorOfLine: line => { const ids = plan.palletsOfLine(line.id); return ids.length === 1 ? plan.palletById(ids[0]).hex : '#9aa5ab'; },
      onMove: (lineId, palletId) => { if (plan.moveLine(lineId, palletId)) { log.record('plan_move', { detail: `${lineId} → ${palletLabel(palletId)}` }); setupChanged(); } },
      onShift: (lineId, palletId, d) => { if (plan.shift(lineId, palletId, d)) { log.record('plan_split', { detail: `${lineId} ${d > 0 ? '+1' : '−1'} on ${palletLabel(palletId)}` }); setupChanged(); } },
      onToggleSplit: lineId => { splitOpen.has(lineId) ? splitOpen.delete(lineId) : splitOpen.add(lineId); render(); },
      onAddPallet: () => { if (plan.addPallet()) { log.record('plan_add_pallet', { detail: `pallets=${plan.pallets.length}` }); setupChanged(); } },
      onRemovePallet: id => { const name = palletLabel(id); if (plan.removePallet(id)) { log.record('plan_remove_pallet', { detail: name }); setupChanged(); } },
      onNext: () => goStep('cards'),
      onBack: () => goStep('count'),
    });
  } else if (phase === 'cards') {
    renderCards(root, { pallets: plan.view, onReady: startSorting, onBack: () => goStep('assign') });
  }
  // The sheet on the left shows the plan as it is now, with the look-alike marks.
  const assign = plan.assignPieces();
  view.colorOf = part => plan.palletById(assign.get(part.uid))?.hex ?? '#9aa5ab';
  view.secondLine = part => { const p = plan.palletById(assign.get(part.uid)); return p ? palletName(p) : ''; };
  view.recolor();
  view.setState(new Map(), null, null, () => false);
  view.setMarkers(markersFor(uid => assign.get(uid)));
}

function goStep(next) {
  phase = next;
  log.record('setup_step', { detail: `${next}; pallets=${plan.pallets.length}` });
  setupChanged();
  $('setup-panel').scrollTop = 0;
  $('panel').scrollTop = 0;
}

function setupChanged() { saveState(); render(); }

const palletLabel = id => { const p = plan?.palletById(id) || session?.pallet(id); return p ? palletName(p) : id; };

// Look-alike marks: on every piece whose look-alike partner goes on another pallet, circle the feature
// that tells them apart. palletOf(uid) gives each piece's pallet.
function markersFor(palletOf) {
  const out = new Map();
  for (const pair of pairs) {
    const pa = job.parts.filter(p => p.partNo === pair.a), pb = job.parts.filter(p => p.partNo === pair.b);
    const pallets = new Set([...pa, ...pb].map(p => palletOf(p.uid)));
    if (pallets.size < 2) continue;
    for (const p of pa) out.set(p.uid, pair.regions.map(r => r.a));
    for (const p of pb) out.set(p.uid, pair.regions.map(r => r.b));
  }
  return out;
}

// Forget the colours and the greying of a sorting session before the sheet is drawn without it (another
// job, or a new test session): they read that session, which is gone.
function forgetSheetLook() {
  view.colorOf = () => '#9aa5ab';
  view.secondLine = () => '';
  view.isDim = () => false;
}

// Tapping a job in the list. With the server, a job that is being sorted or has been sorted before first
// shows its sorting runs and what can be done; any other job opens at once (the common case: one tap).
// The list may be up to 15 s old (another station may have opened the job since), so the job's runs are
// asked for again first.
async function chooseJob(e) {
  if (backend.mode === 'server') {
    try { e = await backend.entry(e.sha); } catch (err) { console.error(err); /* go on with what the list showed */ }
  }
  if (backend.mode !== 'server' || !e.runs?.length) return openJob(e);
  cardEntry = e;
  phase = 'runs';
  log.record('run_card', { detail: `job=${e.title}; runs=${e.runs.length}; open=${e.openRun ? `${e.openRun.runNo} at ${e.openRun.station}` : 'none'}` });
  render();
}

// Open a job on this screen, in one of its sorting runs (backend.js). mode: 'continue' the open run (this
// station's own, or taken over from another station), 'restart' it from the beginning (the old run is kept,
// with its log), or 'new' run (a new sheet); default: continue if there is an open run, otherwise new.
// nextFrom: { runId, plan } to start the new run with that run's pallets ("Next sheet of this program").
async function openJob(e, { nextFrom = null, resuming = false, mode } = {}) {
  const station = settings.stationId;
  const server = backend.mode === 'server';
  if (server && !station) {
    await tellLogged('need_station', { title: t('needStationTitle'), text: t('needStation'), ok: t('toSettings') });
    setPanel('settings');
    return false;
  }
  let state, j = jobCache.get(e.url);
  try {
    if (!j) { j = await loadJob(e.url); jobCache.set(e.url, j); }
    state = await backend.open(e, station, { copyPlanFrom: nextFrom, mode });
  } catch (err) {
    // E.g. another station opened a run of this job a moment ago: back to the (refreshed) list.
    console.error(err);
    listState.error = t('openError', { job: e.title, msg: err.message });
    cardEntry = null;
    phase = 'jobs';
    render();
    refreshList({ keepError: true });
    return false;
  }
  cardEntry = null;
  j.warnings.forEach(w => console.warn(w));
  entry = e; job = j;
  // Look-alikes are only checked for parts whose real outline is known.
  pairs = findLookAlikes(new Map([...job.geos].filter(([, g]) => !g.boxOnly)));
  plan = new PalletPlan(job, pairs);
  session = null; pendingCard = null; feedback = null; splitOpen = new Set();
  forgetSheetLook();
  view.show(job);
  if (log.session.jobId !== job.id) log.newSession({ ...log.session, jobId: job.id });
  // Saved progress: always from the server; in this browser only from the same test session.
  const restore = state && (server || nextFrom || state.sessionId === log.session.id) ? state : null;
  const r = backend.run;
  const parent = r?.parentRunId ? e.runs?.find(x => x.id === r.parentRunId)?.runNo ?? r.parentRunId : '';
  const run = r?.runNo ? `; run=${r.runNo}; station=${station}; started_as=${r.startedAs ?? ''}${parent ? `; after_run=${parent}` : ''}` : '';
  if (restore?.plan) {
    if (!plan.restore(restore.plan)) plan.propose();
    phase = SETUP_PHASES.includes(restore.phase) || restore.phase === 'sort' ? restore.phase : 'count';
    if (phase === 'jobs' || phase === 'runs') phase = 'count';
    if (phase === 'sort') {
      createSession(restore.snap);
      pendingCard = restore.pendingCard || null;
    }
    log.record(nextFrom ? 'next_sheet' : 'job_resumed', { detail: `job=${job.id}; phase=${phase}${run}` });
  } else {
    plan.propose();
    phase = 'count';
    log.record('job_selected', { detail: `job=${job.id}; file=${e.file}; pieces=${job.parts.length}; orders=${job.orders.length}; lookalike_pairs=${pairs.length}${run}` });
  }
  saveState();
  render();
  return true;
}

// Back to the job list. Without a server, unfinished sorting is lost, so ask first. With a server the
// progress is saved and the job stays "in progress here" until it is finished.
async function closeJob({ force = false } = {}) {
  if (!force && backend.mode === 'local' && session && !session.isComplete && !await askLogged('leave_job', {
    title: t('leaveTitle', { job: job.id }), text: t('leaveJob'), yes: t('leaveYes'), no: t('leaveNo'), danger: true,
  })) return;
  if (!job) return;   // closed meanwhile (e.g. taken over while the question was open)
  log.record('job_closed', { detail: `job=${job?.id}; phase=${phase}${session ? `; picked=${session.count('picked')}/${session.progress().total}` : ''}` });
  backend.close(settings.stationId, isSetup() ? 'setup' : 'sort');
  entry = null; job = null; plan = null; session = null; pendingCard = null; pairs = []; feedback = null;
  phase = 'jobs'; panelMode = 'work'; message = null;
  view.clear();
  render();
  refreshList();
}

// "Next sheet of this program": a new run of the same job, with the same pallets (cards are hung again).
async function nextSheet() {
  const from = { runId: backend.run?.id, plan: plan.snapshot() };
  const e = entry;
  log.record('next_sheet_button', { detail: `job=${job.id}; after run=${backend.run?.runNo ?? ''}` });
  await backend.close(settings.stationId, 'done');
  const fresh = backend.mode === 'server' ? await backend.entry(e.sha).catch(() => e) : e;
  await openJob(fresh, { nextFrom: from });
}

// Another station took this job over, or restarted it: this screen stops and goes back to the list.
function onTakenOver(station, info = {}) {
  log.record(info.abandoned ? 'run_stopped_elsewhere' : 'taken_over', { detail: `by ${station}` });
  const text = t(info.abandoned ? 'restartedElsewhere' : 'takenOver', { job: job?.id ?? '', station });
  // Leave first, so this screen can't keep sorting a run it no longer has; then say why.
  if (job) closeJob({ force: true });
  tellLogged('taken_over', { title: t(info.abandoned ? 'restartedTitle' : 'takenOverTitle', { station }), text, ok: t('backToList') });
}

// The job list from the backend; in the local mode each job is loaded once for its summary line.
// keepError: keep the message of a job that could not be opened.
async function refreshList({ keepError = false } = {}) {
  if (!backend) return;
  listState.loading = true;
  try {
    const params = listState.scope === 'search' ? listState : { ...listState, machine: settings.stationId };
    const data = await backend.listJobs(params);
    jobs = data.jobs;
    listState = { ...listState, machines: data.machines, machineKnown: data.machineKnown, total: data.total ?? jobs.length, error: keepError ? listState.error : '' };
    if (listState.scope === 'today') listState.machine = data.machineKnown ? settings.stationId : '';
    if (backend.mode === 'local') {
      await Promise.all(jobs.map(async j => {
        try {
          const jb = jobCache.get(j.url) || await loadJob(j.url);
          jobCache.set(j.url, jb);
          j.summary = { id: jb.id, pieces: jb.parts.length, partNos: jb.geos.size, orders: jb.orders.length, example: jb.example,
            material: jb.material, thickness: jb.thickness, w: jb.size.w, h: jb.size.h };
        } catch (err) { console.error(err); j.error = err.message; }
      }));
    }
  } catch (err) {
    console.error(err);
    listState.error = t('serverError', { msg: err.message });
  }
  listState.loading = false;
  message = null;
  if (phase === 'jobs') render();
}

const fmtTime = iso => {
  const d = new Date(iso), now = new Date();
  const locale = getLang() === 'sv' ? 'sv-SE' : 'en-GB';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
};

// The health line in the header: when the job list was last updated from Z:\, or what is wrong.
function renderHealth() {
  const el = $('health');
  if (!backend) { el.hidden = true; return; }
  el.hidden = false;
  const h = backend.health;
  let text, level = 'ok';
  if (backend.mode === 'local') { text = t('healthLocal'); level = 'muted'; }
  else if (!backend.reachable) { text = backend.waiting ? t('healthServerDown', { n: backend.waiting }) : t('healthServerDownNone'); level = 'bad'; }
  else if (h?.zReachable === false) { text = t('healthZDown', { time: fmtTime(h.zErrorSince) }); level = 'warn'; }
  else if (h?.lastGoodScan) { text = t('healthOk', { time: fmtTime(h.lastGoodScan) }) + (backend.waiting ? ` · ${t('healthSending', { n: backend.waiting })}` : ''); }
  else text = t('healthStarting');
  el.textContent = text;
  el.className = `health is-${level}`;
}

// ---------- B. sorting ----------

// Turn the plan into a sorting session: every piece gets its pallet, and sorting starts with pallet 1.
function startSorting() {
  const assign = plan.assignPieces();
  const pallets = plan.view.map(p => ({ id: p.id, num: p.num, key: p.key, hex: p.hex, ink: p.ink }));
  log.record('cards_ready', {
    detail: `pallets=${pallets.map(palletName).join(' | ')}; plan=${plan.view.map(p => `${palletName(p)}: ${p.parts.map(x => `${x.qty}×${x.partNo}`).join(' ')}`).join(' | ')}; lookalike_warnings=${plan.check().lookAlikes.length}`,
  });
  phase = 'sort';
  createSession(null, { ...job, pallets, parts: job.parts.map(p => ({ ...p, pallet: assign.get(p.uid) })) });
  render();
}

// A new sorting session; with a saved snapshot, the saved progress (and any added pallets) is put back.
function createSession(snap, sortJob) {
  if (!sortJob) {
    const assign = plan.assignPieces();
    sortJob = { ...job, pallets: plan.view.map(p => ({ id: p.id, num: p.num, key: p.key, hex: p.hex, ink: p.ink })), parts: job.parts.map(p => ({ ...p, pallet: assign.get(p.uid) })) };
  }
  session = new PickSession(sortJob, { order: settings.order, operatorEdge: nearEdge(settings) });
  const resumed = snap ? session.restore(snap) : false;
  session.on(onSessionEvent);
  view.colorOf = part => palletOfPiece(session.parts.get(part.uid))?.hex ?? '#9aa5ab';
  view.secondLine = (part, status) => (status === 'missing' || status === 'scrap') ? t(`short_${status}`) : palletName(palletOfPiece(session.parts.get(part.uid)));
  view.recolor();
  session.start({ resumed });
}

function renderSorting() {
  const active = session.activePallet;
  const dim = uid => !!active && session.parts.get(uid).pallet !== active;
  view.setMarkers(markersFor(uid => session.parts.get(uid).pallet));
  view.setState(session.status, session.current?.uid ?? null, session.next?.uid ?? null, dim);
  renderCurrent();
  $('undo-btn').disabled = !session.canUndo;
  $('feedback').textContent = feedback ? t(feedback.key, feedback.params) : '';
}

// The right-hand panel: the piece being worked on, where it goes, and which buttons apply to it.
function renderCurrent() {
  const cur = session.current;
  const selected = !!session.selectedUid;
  const status = cur ? session.status.get(cur.uid) : null;
  const p = session.progress();
  const active = session.activePallet ? session.pallet(session.activePallet) : null;

  // New pallet after "Pallet full": hang its card first.
  $('new-card').hidden = !pendingCard;
  if (pendingCard) {
    const np = session.pallet(pendingCard.pallet);
    const face = $('new-card-face');
    face.textContent = String(np.num);
    face.style.background = np.hex; face.style.color = np.ink;
    $('new-card-title').textContent = t('newCardTitle', { pallet: palletName(np) });
    $('new-card-help').textContent = t('newCardHelp', { n: pendingCard.n, from: palletLabel(pendingCard.from), pallet: palletName(np) });
  }

  // While a new card has to be hung, that is the one thing to do (Undo stays, to take "Pallet full" back).
  const waiting = !!pendingCard;
  for (const id of ['next-card', 'destination', 'confirm-btn', 'pallet-done-btn', 'batch', 'reopen-btn']) if (waiting) $(id).hidden = true;
  $('next-card').hidden = waiting;
  if (waiting) { document.querySelector('.exceptions').hidden = true; return; }

  $('card-title').textContent = !cur ? `${t('sheet')} ${job.id}` : selected ? t('selectedPart') : active ? `${t('nowSorting')}: ${palletName(active)}` : t('nextPart');
  $('next-count').textContent = cur ? t('pickedOf', { done: p.picked, total: p.total }) : '';
  $('selected-strip').hidden = !selected;
  if (selected) {
    const sp = palletOfPiece(cur);
    $('selected-text').textContent = active && cur.pallet !== active.id ? t('goesLater', { pallet: palletName(sp) })
      : perPallet() ? t('tappedPiece') : t('notSuggested', { part: session.next?.partNo ?? '–' });
  }
  $('next-card').classList.toggle('is-complete', !cur);
  $('next-card').classList.toggle('has-problems', !cur && (p.missing + p.scrap) > 0);
  for (const id of ['destination', 'next-hint', 'part-status', 'next-name']) $(id).hidden = !cur;
  $('next-drawing').classList.toggle('is-empty', !cur);
  $('part-status').hidden = !cur || status === 'open';
  $('summary').hidden = !!cur;
  const canReopen = !!cur && session.can('reopen', cur.uid);
  $('reopen-btn').hidden = !canReopen;
  // Per pallet, the main button is "Blue 1 done"; Confirm stays below it, smaller, for one piece at a time.
  // A tapped piece makes Confirm the main button again (one main action at a time).
  const openOnPallet = session.openOnActive().length;
  const showDone = perPallet() && !!cur && !selected && !!active && openOnPallet > 0;
  $('pallet-done-btn').hidden = !showDone;
  if (showDone) {
    $('pallet-done-main').textContent = t('palletDoneMain', { pallet: palletName(active) });
    $('pallet-done-sub').textContent = t('palletDoneSub', { n: openOnPallet });
  }
  $('confirm-btn').textContent = showDone ? t('confirmOne') : t('confirm');
  $('confirm-btn').classList.toggle('is-secondary', showDone);
  $('confirm-btn').hidden = !cur || (canReopen && !session.can('confirm'));
  $('confirm-btn').disabled = !session.can('confirm');
  $('missing-btn').disabled = !session.can('missing');
  $('scrap-btn').disabled = !session.can('scrap');
  $('other-btn').disabled = !session.next;
  $('full-btn').hidden = session.order !== 'pallet' || !cur;
  $('full-btn').disabled = !session.openOnActive().length || !!pendingCard;
  document.querySelector('.exceptions').hidden = !cur;

  // "Picked 2 / 3 / 4 / All": only while sorting one pallet at a time, with at least two pieces left on it.
  const open = session.openOnActive().length;
  const showBatch = !!cur && !selected && session.order === 'pallet' && !perPallet() && open >= 2;
  $('batch').hidden = !showBatch;
  if (showBatch) {
    const ns = [2, 3, 4].filter(n => n < open);
    $('batch-btns').replaceChildren(...ns.map(n => batchButton(String(n), n)), batchButton(t('pickedAll', { n: open }), open));
  }

  if (!cur) { renderSummary(p); $('la-note').hidden = true; return; }
  const pallet = palletOfPiece(cur);
  const marks = markersFor(uid => session.parts.get(uid).pallet).get(cur.uid) || [];
  drawPartDetail($('next-drawing'), cur, pallet.hex, view.orientation, marks);
  $('next-partno').textContent = cur.partNo;
  $('next-name').textContent = cur.boxOnly ? t(cur.geo.suspect ? 'boxOnlySuspect' : 'boxOnly') : cur.geo.name;
  $('part-status').textContent = status === 'open' ? '' : t(`status_${status}`);
  $('part-status').className = `part-status is-${status}`;
  if (status !== 'open') $('reopen-btn').textContent = t(`reopen_${status}`);
  $('destination').style.background = pallet.hex;
  $('destination').style.color = pallet.ink;
  $('dest-label').textContent = `→ ${palletName(pallet).toUpperCase()}`;
  $('dest-order').textContent = `${t('order')} ${cur.order}`;

  // Look-alike on another pallet: name it and show it, with the same red marks.
  const pair = marks.length ? pairs.find(x => x.a === cur.partNo || x.b === cur.partNo) : null;
  $('la-note').hidden = !pair;
  if (pair) {
    const other = pair.a === cur.partNo ? pair.b : pair.a;
    $('la-note-text').textContent = t('laNext', { other });
    drawPartPicture($('la-note-pic'), job.geos.get(other), { fill: '#c9cfd3', markers: pair.regions.map(r => (other === pair.a ? r.a : r.b)) });
  }
}

const breakdownText = palletId => session.breakdown(palletId).map(b => t('breakdownItem', { ...b, part: b.partNo })).join(' · ');

function batchButton(label, n) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-batch'; b.textContent = label;
  b.addEventListener('click', () => {
    const before = session.activePallet;
    const done = session.confirmMany(n);
    if (!done) return;
    const after = session.activePallet;
    feedback = before && after && before !== after
      ? { key: 'fbPalletDone', params: { pallet: palletLabel(before), next: palletLabel(after) } }
      : { key: 'fbBatch', params: { n: done, pallet: palletLabel(before) } };
    render();
  });
  return b;
}

// C. Summary: "3 pallets · 33 pieces · 0 corrections", problems, and what is on each pallet.
function renderSummary(p) {
  $('next-drawing').replaceChildren();
  $('next-partno').textContent = t('summaryTitle', { job: job.id });
  const count = (n, key) => t(n === 1 ? `${key}One` : `${key}Many`, { n });
  $('summary-line').textContent = [count(session.pallets.length, 'pallets'), count(p.total, 'pieces'), count(session.corrections, 'corrections')].join(' · ');
  $('next-sheet-btn').hidden = !session.isComplete;
  $('summary-issues').hidden = !(p.missing + p.scrap);
  $('summary-issues').textContent = t('summaryIssues', p);
  $('summary-pallets').replaceChildren(...session.pallets.map(pl => {
    const li = node('li', null);
    const sw = node('span', 'swatch-mini', String(pl.num));
    sw.style.background = pl.hex; sw.style.color = pl.ink;
    li.append(sw, node('span', null, `${palletName(pl)}: ${breakdownText(pl.id)}`));
    return li;
  }));
}

// Pallet tiles under the sheet. While sorting: done / total, broken down by part, problems in red.
// During setup: what the plan puts on each pallet.
function renderPallets() {
  // During setup the panel shows the pallets itself; the sheet gets the room.
  $('pallets').hidden = !job || isSetup();
  if ($('pallets').hidden) { $('pallets').replaceChildren(); return; }
  const target = session.current ? session.current.pallet : null;
  $('pallets').replaceChildren(...session.pallets.map(pl => {
    const p = session.progress(pl.id);
    const done = p.open === 0, whole = p.picked === p.total;
    const issues = [p.missing && t('issueMissing', { n: p.missing }), p.scrap && t('issueScrap', { n: p.scrap })].filter(Boolean);
    return tile(pl, {
      orders: [...new Set(session.job.parts.filter(x => x.pallet === pl.id).map(x => x.order))].join(', '),
      count: done ? null : `${p.picked} / ${p.total}`,
      done, whole, issues, target: pl.id === target, active: pl.id === session.activePallet,
      detail: session.breakdown(pl.id).map(b => t('breakdownItem', { ...b, part: b.partNo })),
      bar: [p.picked / p.total, (p.missing + p.scrap) / p.total],
    });
  }));
}

function tile(pl, { orders, count, detail, done = false, whole = false, issues = [], target = false, active = false, bar = null }) {
  const li = node('li', `pallet${target ? ' is-target' : ''}${active ? ' is-active' : ''}${done ? (whole ? ' is-done' : ' is-incomplete') : ''}`);
  li.style.setProperty('--pallet', pl.hex);
  li.style.setProperty('--ink', pl.ink);
  const text = node('div', 'pallet-text');
  text.append(node('div', 'pallet-name', palletName(pl)), node('div', 'pallet-order', `${t('order')} ${orders || '–'}`));
  if (issues.length) text.append(node('div', 'pallet-issues', issues.join(' · ')));
  // While open: "3 / 8". When done: a big ✓ or ⚠ with the word under it.
  const c = node('div', 'pallet-count', count);
  if (done) c.append(node('span', 'count-icon', whole ? '✓' : '⚠'), node('span', 'count-word', whole ? t('palletComplete') : t('palletIncomplete')));
  li.append(node('div', 'swatch', String(pl.num)), text, c);
  // The running count per part, one item per part number, across the whole tile.
  if (detail && !(done && whole)) {
    const d = node('div', 'pallet-detail');
    for (const item of detail) d.append(node('span', null, item));
    li.append(d);
  }
  if (bar) {
    const b = node('div', 'pallet-bar');
    const picked = node('span', 'bar-picked'), problem = node('span', 'bar-problem');
    picked.style.width = `${(100 * bar[0]).toFixed(1)}%`;
    problem.style.width = `${(100 * bar[1]).toFixed(1)}%`;
    b.append(picked, problem);
    li.append(b);
  }
  return li;
}

function renderSettings() {
  if (document.activeElement !== $('station-id')) $('station-id').value = settings.stationId;
  $('station-id-note').textContent = backend?.mode === 'server' && !settings.stationId ? t('needStation') : '';
  $('view-now').textContent = t(settings.mirror ? 'viewNowMirrored' : 'viewNow', { deg: settings.rotation });
  $('mirror-btn').setAttribute('aria-pressed', String(settings.mirror));
  $('zoom-btn').setAttribute('aria-pressed', String(settings.zoomSmall));
  document.querySelectorAll('[data-order]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.order === settings.order)));
  document.querySelectorAll('[data-confirm]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.confirm === settings.confirm)));
  $('saved-note').textContent = settingsSaved ? t('savedHere') : t('notSaved');
  $('saved-note').classList.toggle('error', !settingsSaved);
}

function renderTest() {
  const s = log.session;
  const started = new Date(s.startedAt).toLocaleTimeString(getLang() === 'sv' ? 'sv-SE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  $('session-box').replaceChildren(
    node('div', 'session-who', t('sessionWho', { participant: s.participant || '–', condition: s.condition || '–' })),
    node('div', 'session-meta', t('sessionMeta', { id: s.id, time: started, n: log.rows.length })),
    node('div', `session-export${log.unexported ? ' is-unsaved' : ''}`, log.unexported ? t('notExported', { n: log.unexported }) : t('allExported')),
  );
  $('log-note').textContent = log.saveOk ? '' : t('logNotSaved');
  // With the server: the same log, as stored on the server for this job's run (every station's rows).
  const url = backend?.logUrl();
  $('server-log-btn').hidden = !url;
  if (url) $('server-log-btn').href = url;
}

// Data from files goes in with textContent, never as HTML.
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// ---------- panels: work, station settings, test session ----------

function setPanel(mode) {
  const next = panelMode === mode ? 'work' : mode; // pressing the same header button again closes it
  if (next === panelMode) return;
  log.record('panel', { detail: next });
  panelMode = next;
  view.setFit(panelMode === 'settings' ? 'sheet' : 'parts');
  view.tapsEnabled = panelMode === 'work';
  if (panelMode === 'test') {
    $('tp-participant').value = log.session.participant;
    $('tp-condition').value = log.session.condition;
    $('tp-note').value = log.session.note;
  }
  render();
}

function changeSettings(change) {
  settings = sanitize({ ...settings, ...change });
  settingsSaved = saveSettings(settings);
  view.setOrientation({ rotation: settings.rotation, mirror: settings.mirror });
  view.setZoomSmall(settings.zoomSmall);
  log.record('settings', { detail: settingsDetail() });
  if (session) session.setOrder(settings.order, nearEdge(settings));
  render();
}

const settingsDetail = () =>
  `station=${settings.stationId}; rotation=${settings.rotation}; mirror=${+settings.mirror}; order=${settings.order}; confirm=${settings.confirm}; zoom_small=${+settings.zoomSmall}; lang=${getLang()}; backend=${backend?.mode ?? ''}`;

function turn(direction) {
  const step = direction === 'left' ? 90 : -90;
  changeSettings({ rotation: (settings.rotation + (settings.mirror ? -step : step) + 360) % 360 });
}

// ---------- saved progress and the test log ----------

// Save the job's state after every change: the setup step, the pallet plan, the sorting progress and
// a card waiting to be hung. With the server it is saved for the run (and other screens see the count).
function saveState() {
  if (!entry || !backend) return;
  const p = session?.progress();
  backend.saveState(settings.stationId, {
    sessionId: log.session.id, jobId: job.id,
    phase, plan: plan.snapshot(), snap: session?.snapshot() ?? null, pendingCard,
  }, { phase: isSetup() ? 'setup' : session?.isComplete ? 'done' : 'sort', picked: p?.picked ?? 0, total: p?.total ?? job.parts.length, jobId: job.id });
}

// Start a new test session: new participant data, empty log, and the job's setup starts again. With the
// server, the session also gets its own sorting run: the current run is stopped and kept (a sorted sheet
// stays sorted), so each participant's picks and log stay apart.
async function startNewTestSession() {
  if (log.unexported > 0 && !await askLogged('new_session', {
    title: t('newSessionTitle'), text: t('confirmNewSession', { n: log.unexported }),
    yes: t('newSessionYes'), no: t('newSessionNo'), danger: true,
  })) return;
  if (job && backend.run) {
    try { await backend.restart(settings.stationId, 'test_session'); }
    catch (err) {
      console.error(err);
      await tellLogged('session_error', { title: t('sessionErrorTitle'), text: t('sessionRunError', { msg: err.message }), ok: t('closeDialog') });
      return;
    }
  }
  log.newSession({
    participant: $('tp-participant').value.trim(),
    condition: $('tp-condition').value.trim(),
    note: $('tp-note').value.trim(),
    jobId: job?.id ?? '',
  });
  log.record('session_start', { detail: `${settingsDetail()}; job=${job?.id ?? ''}${backend.run?.runNo ? `; run=${backend.run.runNo}` : ''}; window=${innerWidth}x${innerHeight}` });
  feedback = null; pendingCard = null; session = null; splitOpen = new Set();
  forgetSheetLook();
  panelMode = 'work';
  view.setFit('parts');
  view.tapsEnabled = true;
  if (job) { plan.propose(); phase = 'count'; } else phase = 'jobs';
  saveState();
  render();
}

function exportLog() {
  log.record('export', { detail: log.fileName() });
  log.download();
  render();
}

// Confirming per piece: tapping a piece of the pallet being sorted (or the piece shown in the panel) confirms it.
// Tapping any other piece shows it in the panel first, with its pallet, so nothing is confirmed by accident.
// Confirming per pallet: a tap only shows the piece (Confirm, Missing, Scrap); a second tap on it confirms it.
// Nobody looks at the screen while sorting, so a glove brushing the screen must not pick anything.
function onPartTap(uid) {
  if (phase !== 'sort' || !session) return;
  const part = partByUid(uid);
  const status = session.status.get(uid);
  const tap = result => log.record('tap', { uid, part_no: part.partNo, pallet: palletLabel(part.pallet), via: 'tap', detail: result });
  const onActive = session.order === 'pallet' && part.pallet === session.activePallet;
  const confirms = perPallet() ? uid === session.selectedUid : uid === session.current?.uid || (onActive && status === 'open');
  if (confirms) {
    if (session.can('confirm', uid)) { tap('confirm'); session.confirm(uid, 'tap'); return; }
    tap(`refused: ${status}`);
    feedback = { key: status === 'scrap' ? 'fbIsScrap' : 'fbAlreadyPicked', params: { part: part.partNo } };
    render();
    return;
  }
  tap('select');
  session.select(uid, { keepSuggested: perPallet() });
  if (session.selectedUid) {
    feedback = session.activePallet && part.pallet !== session.activePallet && status === 'open'
      ? { key: 'fbOtherPallet', params: { part: part.partNo, pallet: palletLabel(part.pallet) } }
      : { key: 'fbSelected', params: { part: part.partNo } };
  }
  render();
}

function onSessionEvent(e) {
  log.recordSessionEvent(e, partByUid, palletLabel);
  saveState();
  const part = e.uid ? partByUid(e.uid) : null;
  if (e.type === 'confirm' && e.via !== 'batch' && e.via !== 'pallet') {
    feedback = { key: e.outOfOrder ? 'fbPickedOutOfOrder' : 'fbPicked', params: { part: part.partNo, pallet: palletLabel(part.pallet) } };
  } else if (e.type === 'pallet' && e.previous && !e.reason) {
    // Honest kit status: a pallet with missing or scrapped pieces is not "complete".
    const pp = session.progress(e.previous), issues = pp.missing + pp.scrap;
    feedback = { key: issues ? 'fbPalletDoneIssues' : 'fbPalletDone', params: { pallet: palletLabel(e.previous), next: palletLabel(e.pallet), n: issues } };
  } else if (e.type === 'pallet_done') {
    feedback = { key: 'fbPalletDoneN', params: { pallet: palletLabel(e.pallet), n: e.count } };
  } else if (e.type === 'missing') {
    feedback = { key: 'fbMissing', params: { part: part.partNo } };
  } else if (e.type === 'scrap') {
    feedback = { key: 'fbScrap', params: { part: part.partNo } };
  } else if (e.type === 'reopen') {
    feedback = { key: 'fbReopened', params: { part: part.partNo } };
  } else if (e.type === 'pallet_full') {
    pendingCard = { pallet: e.pallet, from: e.fromPallet, n: e.moved };
    feedback = { key: 'fbPalletFull', params: { pallet: palletLabel(e.pallet), n: e.moved, from: palletLabel(e.fromPallet) } };
    view.recolor();
    saveState();
  } else if (e.type === 'undo') {
    if (e.undid === 'pallet_full') {
      if (pendingCard?.pallet === e.pallet) pendingCard = null;
      feedback = { key: 'fbUndonePallet', params: { pallet: e.removed ? palletName(e.removed) : e.pallet, from: palletLabel(e.fromPallet) } };
      view.recolor();
      saveState();
    } else if (e.undid === 'pallet_done') {
      feedback = { key: 'fbUndonePalletDone', params: { pallet: palletLabel(e.pallet), n: e.count } };
    } else if (e.undid === 'batch') {
      feedback = { key: 'fbUndoneBatch', params: { n: e.count } };
    } else {
      feedback = { key: 'fbUndone', params: { part: part.partNo, status: t(`statusWord_${e.restored}`) } };
    }
  } else if (e.type === 'deselect') {
    feedback = null;
  }
  render();
}

// Enter does what the big green button says ("Blue 1 done", or Confirm), so a push button or foot pedal
// set to send Enter can confirm at the station without touching the screen. True if it did something.
function mainActionByKey() {
  if (phase !== 'sort' || !session || panelMode !== 'work' || pendingCard) return false;
  if (!$('pallet-done-btn').hidden) return session.palletDone('key') > 0;
  if (!$('confirm-btn').hidden && session.can('confirm')) return session.confirm(undefined, 'key');
  return false;
}

// ---------- start ----------

async function start() {
  $('lang-btn').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'sv' : 'en');
    log.record('language', { detail: getLang() });
    render();
  });
  render();

  view = new SheetView($('sheet'));
  view.setMinimap($('minimap'));
  view.onZoomChange = (zoomed, can = {}) => {
    $('minimap-btn').hidden = !zoomed;
    $('zoom-controls').hidden = !view.job;
    $('zoom-in-btn').disabled = !can.canZoomIn;
    $('zoom-out-btn').disabled = $('zoom-fit-btn').disabled = !can.canZoomOut;
  };
  view.onUserZoom = ({ action, via }) => log.record('zoom', { uid: session?.current?.uid ?? '', via, detail: action });
  view.onPanMode = on => {
    $('tool-select-btn').setAttribute('aria-pressed', String(!on));
    $('tool-pan-btn').setAttribute('aria-pressed', String(on));
  };
  view.setZoomSmall(settings.zoomSmall);
  view.setOrientation({ rotation: settings.rotation, mirror: settings.mirror });
  view.onPartTap(onPartTap);

  // The pipeline service when the page came from it, otherwise this browser only (backend.js).
  backend = await connect();
  backend.onConflict = onTakenOver;
  backend.onChange = renderHealth;
  listState.machine = settings.stationId;
  await refreshList();

  // Open a job: the one this station was working on (after a reload), or one given as
  // ?job=path/to/job (no server only), or none (job list).
  const asked = backend.mode === 'local' ? new URLSearchParams(location.search).get('job') : null;
  let opened = false;
  try {
    const mine = await backend.resumable(settings.stationId, log.session.id);
    if (mine) {
      const e = jobs.find(j => j.key === mine.key) || mine;
      opened = await openJob(e, { resuming: true });
      if (opened) log.record('page_load', { detail: `${settingsDetail()}; job=${job.id}; phase=${phase}; window=${innerWidth}x${innerHeight}` });
    }
  } catch (err) { console.error(err); }
  if (!opened && asked) {
    const url = new URL(asked, location.href).href;
    opened = await openJob(jobs.find(j => j.url === url) || { file: asked.split('/').pop(), url, title: asked, key: asked });
  }
  if (!opened) {
    phase = 'jobs';
    log.record(log.rows.length ? 'page_load' : 'session_start', { detail: `${settingsDetail()}; window=${innerWidth}x${innerHeight}` });
  }
  // Keep the job list and the health line up to date (new jobs appear without touching the screen).
  if (backend.mode === 'server') {
    setInterval(async () => {
      await backend.refreshHealth();
      if (phase === 'jobs' && !job && panelMode === 'work') refreshList();
    }, REFRESH_MS);
  }

  $('station-id').addEventListener('change', () => {
    changeSettings({ stationId: $('station-id').value });
    listState = { ...listState, scope: 'today', q: '', date: '', machine: settings.stationId };
    refreshList();
  });
  $('next-sheet-btn').addEventListener('click', nextSheet);
  $('jobs-btn').addEventListener('click', () => closeJob());
  $('station-btn').addEventListener('click', () => setPanel('settings'));
  $('test-btn').addEventListener('click', () => setPanel('test'));
  $('done-btn').addEventListener('click', () => setPanel('work'));
  $('test-done-btn').addEventListener('click', () => setPanel('work'));
  $('turn-left-btn').addEventListener('click', () => turn('left'));
  $('turn-right-btn').addEventListener('click', () => turn('right'));
  $('mirror-btn').addEventListener('click', () => changeSettings({ mirror: !settings.mirror }));
  $('zoom-btn').addEventListener('click', () => changeSettings({ zoomSmall: !settings.zoomSmall }));
  document.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', () => changeSettings({ order: b.dataset.order })));
  document.querySelectorAll('[data-confirm]').forEach(b => b.addEventListener('click', () => changeSettings({ confirm: b.dataset.confirm })));
  $('reset-btn').addEventListener('click', () => changeSettings({ ...DEFAULTS }));
  $('export-btn').addEventListener('click', exportLog);
  $('new-session-btn').addEventListener('click', startNewTestSession);
  $('confirm-btn').addEventListener('click', () => session.confirm());
  $('pallet-done-btn').addEventListener('click', () => session.palletDone('button'));
  $('missing-btn').addEventListener('click', () => session.markMissing());
  $('scrap-btn').addEventListener('click', () => session.markScrap());
  $('reopen-btn').addEventListener('click', () => session.reopen());
  $('other-btn').addEventListener('click', () => { log.record('other_part_button'); feedback = { key: 'fbChooseOther' }; render(); });
  $('back-btn').addEventListener('click', () => session.clearSelection());
  $('undo-btn').addEventListener('click', () => session.undo());
  $('full-btn').addEventListener('click', () => session.palletFull());
  $('new-card-btn').addEventListener('click', () => {
    log.record('card_ready', { pallet: palletLabel(pendingCard?.pallet), detail: 'new pallet after "pallet full"' });
    pendingCard = null; saveState(); render();
  });
  $('next-job-btn').addEventListener('click', () => closeJob());
  $('minimap-btn').addEventListener('click', () => { log.record('zoom_overview', { uid: session?.current?.uid ?? '' }); view.showOverview(); });
  $('zoom-in-btn').addEventListener('click', () => view.zoomIn());
  $('zoom-out-btn').addEventListener('click', () => view.zoomOut());
  $('zoom-fit-btn').addEventListener('click', () => view.fitView());
  const setTool = (pan, via) => {
    if (!view.job || view.panMode === pan) return;
    view.setPanMode(pan);
    log.record('tool', { via, detail: pan ? 'move' : 'select' });
  };
  $('tool-select-btn').addEventListener('click', () => setTool(false, 'button'));
  $('tool-pan-btn').addEventListener('click', () => setTool(true, 'button'));
  // Keys for laptops and demos: + / − zoom, 0 shows the whole view, H = hand (move), V = arrow (select).
  // Not while typing in a field.
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || e.target.closest?.('input, textarea, select')) return;
    const key = e.key.toLowerCase();
    if (key === 'enter') { if (mainActionByKey()) e.preventDefault(); return; }
    if (key === 'h' || key === 'v') { setTool(key === 'h', 'key'); return; }
    const action = { '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '0': 'fitView' }[e.key];
    if (action) { e.preventDefault(); view[action]('key'); }
  });
  // The close-up's rings have a minimum size in pixels, so redraw them when the box changes size.
  new ResizeObserver(() => { if (session?.current && panelMode === 'work') renderCurrent(); }).observe($('next-drawing'));
  render();
}

start();
