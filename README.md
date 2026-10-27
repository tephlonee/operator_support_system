# Operator Picking Support (mock-up)

University West, "Project in AI", with Brålanda Industri AB. See CLAUDE.md for the full brief.

## Two ways to run it
| | With the pipeline service (as at Brålanda) | Demo without a server |
| --- | --- | --- |
| Start | `npm run demo` (or `npm start` with a real Z:\) | `python tools/serve.py` |
| Jobs come from | Z:\ (in the demo: the `demo-z` folder), polled every few seconds | `data/jobs/index.json` |
| Progress and test log | On the server (`picking.db`), shared by every screen | In this browser only |
| Open | http://localhost:8080/ and, on the monitors, http://&lt;server-ip&gt;:8080/ | http://localhost:8000/ |

The app works out which one it is talking to by itself (the header says "Demo mode" without a server).

### Demo with the pipeline service (on a laptop)
Needs **Node.js 22.13 or later** (nodejs.org). Nothing to `npm install`: the database is the SQLite built into Node.
1. Open a terminal (PowerShell) in this folder and run `npm run demo`.
   This writes a stand-in for Z:\ in `demo-z/` (the real J14, whose 1045575.GEO is really missing, and the invented example sheet as an LST) and starts the service. Leave the window open; stop it with Ctrl+C.
2. Open http://localhost:8080/, press **⚙ Station** and set a station ID (`L95` or `L96`: the demo's two machine folders).
3. Try it: copy a job folder into `demo-z/L95/` and it appears in the list within seconds; open the same job on a second browser window with another station ID and take it over; stop the service while sorting and start it again (nothing is lost).
4. The acceptance tests of the service (scenarios S1–S18 of the design doc, S19–S21 for sorting runs): `npm test`.

### Demo without a server
1. `python tools/serve.py` (Python 3, nothing to install), then open http://localhost:8000/.
2. The tests of the app: http://localhost:8000/test/ (also at http://localhost:8080/test/ with the service).
To open one job directly (no server only): http://localhost:8000/?job=data/jobs/J14.LST

## Running it at Brålanda (one Windows PC on the LAN)
1. Install Node.js 22.13+ on the PC that will be the server. Give it a fixed IP address and turn off sleep.
2. Copy this folder to it, e.g. `C:\OperatorPicking\app`, and create `server\config.json` from `server\config.example.json`:
   - `zRoot`: where the programmer pastes the jobs. **Use the UNC path** (`\\fileserver\share`), not `Z:\`: a program started as a Windows service or at startup does not see drive letters mapped by a logged-in user.
   - `dataDir`: where the database, raw copies and backups go (default `C:\OperatorPicking`).
3. Start it with `npm start`. To start it with Windows: Task Scheduler → "At startup", run `node --disable-warning=ExperimentalWarning server\main.js` in the app folder, as a user that can read the share.
4. Allow port 8080 in Windows Defender Firewall (inbound, private network).
5. On every monitor, open `http://<server-ip>:8080/` in a browser (full screen) and set its station ID once.

What the service keeps, in `dataDir`: `picking.db` (one SQLite file: catalog, runs, event log, scan log), `raw\` (a copy of every accepted job's files, by content hash), `backup\` (a copy of the database every night, the newest 14 kept). It never writes to Z:\.

## The workflow (for every job)
**A. Setup**
1. **Choose the job.** The app reads the parts, quantities and sheet map from the job file (the real TruTops `.LST` file, or the example JSON).
2. **How many pallets?** The app suggests one per order. Use − / +.
3. **Which parts on which pallet?** The app proposes an assignment. Tap a pallet number to move a whole part there; **Split** moves one piece at a time between pallets; **+ Pallet** / **×** add or remove a pallet. If look-alike parts end up on different pallets, the app warns and shows both outlines side by side with the differences circled in red.
4. **Hang the cards.** "Hang Blue 1, Orange 2, …", then **Ready**.

**B. Sorting, one pallet at a time**
- Only the pallet being sorted is highlighted on the sheet; everything else is grey. Look-alike pieces carry a small red marker on the feature that tells them apart.
- **Confirm per pallet (the default):** sort all the highlighted pieces onto the pallet, then press **✓ Blue 1 done** once (or the **Enter** key: a push button or foot pedal that sends Enter can be fitted at the station). Every piece still open on that pallet counts as picked. Tap a piece on the sheet only when something is wrong: it is shown in the panel with **Missing**, **Scrap** and **Confirm pick** (tapping it again also picks it). A tap never picks a piece by itself, so a glove brushing the screen does nothing. **Confirm this piece only** under the big button picks the highlighted piece on its own.
- **Confirm per piece** (⚙ Station → Confirming picks): the earlier way. Pick a piece and tap it on the sheet (or press Confirm). Took several? Press **2 / 3 / 4 / All**. A pallet with a missing or scrapped piece is reported as "done but incomplete", never "complete".
- When a pallet is complete, the next one starts by itself. If a pallet is full early, press **Pallet full → new pallet**: the next colour and number is assigned and the remaining pieces move to it.
- Always on screen: the count per pallet broken down by part, the sheet's progress in the header, and **Undo** (it also takes back "pallet done", "picked N" and "pallet full").

**C. Summary:** "3 pallets · 33 pieces · 0 corrections", then **Next job**.

**Zoom and move the sheet** with the buttons right of it: **＋ / −** zoom, **Fit** shows the whole view again. **↖** (arrow, the default): a tap on a part picks or selects it. **✋** (hand): drag with a finger or the mouse to move the view; taps pick nothing. Every job starts with the arrow. On a laptop the mouse wheel zooms around the pointer, and the keys are `+` `-` `0` (Fit), `H` (hand) and `V` (arrow). After a pick, a view zoomed by hand stays if the next part is in it; otherwise it glides back to the automatic view. Each zoom, move and tool change is a row in the test log (`zoom`, `tool`).

Progress (setup and sorting) survives a page reload. **☰ Jobs** goes back to the job list.

**With the pipeline service** the job list shows today's jobs for this station's machine (not finished yet, or worked on today); **Search** finds any job by name, part number or order, date and machine. A job being sorted at another station shows "In progress at L95 · 12/33". The header shows when the jobs were last read from Z:\, or that Z:\ or the server cannot be reached (nothing is lost: changes wait on the screen and are sent later).

**Jobs and sorting runs.** A *job* is what the programmer pasted on Z:\ (one LST and its GEOs). A *sorting run* is one attempt at sorting a sheet of it, with its own pallets, progress and log. A job can have many runs: more sheets of the same program, the same program cut again later, a restart, or a new test session. **Only one run of a job can be open at a time.** Tapping a job that has runs shows them (newest first) and what can be done:
- **Continue sorting**, or **Take over from L95** when another station has it (that screen is told and goes back to its list).
- **Restart from the beginning**: the open run is *stopped* and kept, with its picks and its log, and a new run starts at "How many pallets?" with nothing picked. Use it when the setup was wrong. Pieces already on pallets are not reset; the screen warns about this.
- With no open run: **New sheet, same pallets as run N** (the last sorted run), or **New sheet, new setup**. **Next sheet of this program** on the summary does the same in one tap.

A job without runs opens straight into setup, as before. Runs are never deleted once something happened in them; a run left during setup before anything was done is simply cancelled. **📋 Test → Start new session** starts a new run too, so every participant has their own run and log (a sorted sheet stays sorted).

## Laser projector concept (3D, for the presentation and report)
A concept visualisation, **not an optical simulation**: a laser outline projector on a pillar bracket, beside the sheet and outside the overhead crane's path, draws the outlines of the pallet being sorted onto the cut sheet.
- Open it with either server running: http://localhost:8000/tools/projector-3d.html (`python tools/serve.py`) or http://localhost:8080/tools/projector-3d.html (`npm run demo`). It works offline: three.js is in `tools/vendor/three/`.
- **◀ / ▶** change the pallet (its colour and number as in the app); **Show all pallets at once** draws everything and compares the total line length with the projector budget (red warning when over: the image would flicker). **− / +** move the outline closer to or further from the cut line; **Outline / Centre cross** chooses what is drawn. **Operator / Side (crane) / Projector** move the camera (drag to orbit, wheel to zoom). **Settings** hold the assumptions (projector position, crane envelope, budget); the line under them says whether the projector is clear of the crane.
- For a screen recording: **Hide controls** (or the H key), then **Auto-tour** (operator view → pallet 1 → 2 → 3 → side view).
- The default job is the invented example sheet. J14 can be chosen too; the page then says it is real company data that must not be shared.

## Running a usability test session
1. Press **📋 Test**. Enter the participant ID, the condition (e.g. "with auto-zoom") and an optional note.
2. Press **Start new session**. The job's setup starts again (from "How many pallets?") and a new log starts.
3. The participant picks the sheet. Every action is recorded with a time (part shown, confirm, missing, scrap, undo, taps…).
4. Press **📋 Test** → **Export log (CSV)**. The file lands in your Downloads folder, named after the participant. With the service, the same rows are also on the server: **Download this job's log from the server** (or `http://<server>:8080/api/log.csv?session=<session id>`), with the station and run added.
5. Repeat from step 1 for the next participant.

The log and the picking progress survive a page reload. Useful CSV columns: `ms_since_shown` (time from when the suggested part was shown to the action, i.e. time per pick), `out_of_order`, `via` (button, tap, key, batch for "picked N", or pallet for "pallet done"), and the `undo`/`reopen` rows (corrections, for the error rate). Setup is logged too (`job_selected`, `pallet_count`, `plan_move`, `plan_split`, `plan_add_pallet`, `plan_remove_pallet`, `cards_ready`), as are `pallet` (a new pallet is being sorted), `pallet_done` (with the number of pieces and the time since the pallet started) and `pallet_full`. Confirming per pallet, time per pallet replaces time per pick. Questions and their answers are `dialog` rows. If Excel shows everything in one column, open the file via Data → From Text/CSV and choose comma as the separator.

## Files
| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | The app page and its look (built for a 1920×1080 shop-floor screen). |
| `src/ui.js` | Builds the screen and connects the pieces: the job list, setup, sorting and the summary; keeps the panel, the sheet and the pallet tiles up to date; saves progress. |
| `src/setup-view.js` | The setup screens: choose the job, number of pallets, which parts on which pallet (with the look-alike comparison), hang the cards. |
| `src/plan.js` | The pallet plan, no screen code: the fixed colour order (Blue 1, Orange 2, …), the proposal, move / split / add / remove, and which physical piece goes on which pallet. |
| `src/lookalike.js` | Finds look-alike parts from their .GEO outlines (size, area, holes, overlap), where they differ, and whether they are mirror images. No screen code. |
| `src/picking.js` | The picking rules, no screen code: one pallet at a time, which piece is next, confirm, "picked N", "pallet done", "pallet full", missing, scrap, picked out of order, undo, undo of one specific piece (reopen), count per pallet and per part, save/restore. |
| `src/sheet-view.js` | Draws the sheet from above: every part in place, coloured by pallet (other pallets grey), labelled; rings the current part, marks look-alike features, shows each part's status (picked, missing, scrap), handles taps, zooms in on small parts (with an overview map), and zooming and moving by hand (＋ / − / Fit, mouse wheel, the hand tool). Also draws the close-up of the current part and the part pictures of the setup screens. |
| `src/log.js` | The test log for the usability study: every action with a timestamp, exported as CSV. Survives page reloads; with the service every row also goes to the server's event log. |
| `src/nest-loader.js` | The only file that knows the job formats: reads the real TruTops `.LST` file (sheet, part positions, orders) and the example JSON. A part whose .GEO file is missing, or fails the integrity check (`geoProblem`: area vs its header and the LST, size vs the LST), is shown as its box. Also reads the job list. |
| `src/backend.js` | Where jobs come from and progress goes: the pipeline service (job list, runs, claims, event log, with an outbox that survives a network drop) or, without a server, this browser. |
| `server/main.js` | Starts the pipeline service: settings (`server/config.json`), polling, the web server, the nightly backup and tidy-up. |
| `server/pipeline.js` | The poller: lists Z:\ every few seconds, waits until a pasted file is complete (not locked, ends with `ED`, piece counts match), finds the GEO files in any case, checks them, hashes the content and copies accepted jobs into the raw store. Never writes to Z:\. |
| `server/catalog.js` | Today's list and the search, from the catalog and the runs. |
| `server/store.js` | The SQLite database (one file): catalog (`files`, `jobs`), `sorting_runs` (with restart and stop), `events`, `scan_log`; upgrades an older `picking.db` in place; nightly backup with `VACUUM INTO`. |
| `server/api.js` | The web server for the monitors: the app's files and the JSON API (jobs, raw files, runs, claims, state, events, CSV export, health). |
| `server/test/scenarios.test.js` | The acceptance test: scenarios S1–S18 of the design doc, S19–S21 (restart a run, one open run per job, a run per test session) and the upgrade of an older database, against the real J14 files (`npm test`). |
| `tools/make-demo-z.mjs` | Builds the demo Z:\ folder (`demo-z/`): the real J14 and the invented example sheet written as an LST. |
| `src/geo-parser.js` | Reads a TRUMPF .GEO part file: outline, holes, marked part number, exact net area. |
| `src/dialog.js` | The app's own questions and messages (restart, leave a job, new session, taken over …): big buttons that say what they do, the safe choice first. Replaces the browser's small confirm/alert boxes. |
| `src/settings.js` | Station settings (station ID, turn/mirror the view, pick order, confirm per pallet or per piece, zoom on small parts), saved in this browser so each station screen keeps its own. |
| `src/matrix.js` | Small maths helpers to move, rotate and mirror shapes. |
| `src/i18n.js` | All screen text in English and Swedish, and the language switch. The Swedish is a draft to be checked. |
| `test/index.html` | Test page: checks the parser, the example data, the job loader (incl. J14.LST), the pallet plan, the look-alike check, the picking rules, the station settings and the test log, and draws every part. (It never touches a real study log.) |
| `data/parts/*.GEO` | Real part files from Brålanda. |
| `data/parts/examples/EX-*.GEO` | **Invented** example parts (not Brålanda data), in the same format. |
| `data/jobs/J14.LST` | **Real** job J14 from Brålanda (TruTops Boost): sheet, positions and orders. Real company data: do not share it outside the project. |
| `data/jobs/example-sheet.json` | **Invented** example job: where each part sits on a 3000×1500 sheet and which order it belongs to. |
| `data/jobs/index.json` | The list of jobs shown at the start. Add a line here to make another job choosable. |
| `tools/make_examples.py` | Creates the example parts and the example job. Run `python tools/make_examples.py` after changing it. |
| `tools/projector-3d.html`, `src/projector-3d.js` | The laser projector concept in 3D (page) and its geometry: outlines a few mm inside each part, centre crosses, line length per pallet, budget check (no 3D code, tested). `tools/vendor/three/` is the vendored three.js 0.186.1 with its licence. |
| `tools/serve.py` | The local web server for the demo without the pipeline. Like `python -m http.server`, but tells the browser not to keep old copies of the files. |
| `package.json` | Only the start and test commands (`npm start`, `npm run demo`, `npm test`); no dependencies. |
| `docs/report-brief.md` | Project summary for writing the report (decisions, findings, open questions). |
| `reference/geo-viewer.html` | The earlier 3D part viewer that the parser code comes from. |
