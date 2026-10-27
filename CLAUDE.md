# Operator Picking Support: project brief

## Background
- University project: course "Project in AI" (7.5 hp), University West (Högskolan Väst), autumn 2026.
- Industry partner: Brålanda Industri AB. They cut sheet-metal parts on a TRUMPF laser.
- Problem: after a sheet is cut, an operator has to take the parts out of the sheet skeleton and sort them onto the right pallets or kits for each order. Many parts look alike, so this is slow and parts get mixed up.
- Goal: a digital operator support system. A monitor mounted at the unloading station shows the cut sheet exactly as the operator sees it. Every part is drawn in its real position and colored by its destination pallet. The operator picks the part, confirms it, and the kit progress updates.
- Team: Tijani-Ahmed Oboirien (technical lead, systems/data), Hussein Lekis (research/documentation lead), Ch Emaan Wasay (Design & Testing lead: UI/UX, test planning).
- Deliverable: a working mock-up/simulation plus a report on the engineering design process. Final presentation is on **27 Oct 2026**, and the report is due 8 Nov 2026.

## Design decisions (keep these)
- **No computer vision.** The metal parts are reflective, so camera recognition is unreliable. Parts are matched by **position on the sheet**, which comes from the nesting layout. They are not matched by appearance.
- **The screen must match the operator's view.** The sheet orientation (rotation 0/90/180/270 and mirror) is a per-station setting, so the same corner of the sheet is top-left on the screen and in reality.
- **Show the marked part number.** The .GEO files contain a text entity (for example "1045572") that the laser probably marks on the part. Draw it at the same spot and angle, so the operator can check a part by reading it.
- **Built for the shop floor:** big touch targets (operators wear gloves), high contrast, readable from about 1.5 m, one main action at a time. Target screen is 1920×1080, landscape, possibly touch.
- **Honest kit status:** besides "picked", the operator needs "part missing", "scrap / damaged" and "picked out of order". Small parts may already have dropped out, or may still hang on micro-joints.

## Workflow (decided 23 Oct 2026, built in step 9: keep this)
- **A. Setup per job:** choose the job → number of pallets (app suggests one per order) → check the proposed assignment (move a part, split a quantity, add/remove a pallet; warn about look-alikes on different pallets and show the difference) → hang the cards ("Hang Blue 1, Orange 2, …") → Ready.
- **Pallets come from the operator, not from the job file.** Colours follow a fixed order by pallet number (Okabe–Ito: Blue 1, Orange 2, Green 3, Yellow 4, Pink 5, Sky blue 6, Red 7, Black 8, then repeat), always shown with the number. Reusable hanging cards.
- **B. Sorting one pallet at a time:** only the active pallet is highlighted, the rest grey; next pallet starts by itself; **confirm per pallet** (decided 26 Oct 2026: one tap on "Blue 1 done" or the Enter key / a push button; tap a piece only for missing / scrap / a single pick; a tap only selects, never picks) or, as a station setting, per piece (tap each piece or "picked N"); "Pallet full" adds the next colour/number and moves the remaining pieces; always on screen: count per pallet broken down by part, sheet progress, Undo.
- **C. Summary:** "3 pallets · 33 pieces · 0 corrections".
- **Look-alikes are computed from the .GEO outlines** (size, area, holes, overlap; mirror images detected). Shown side by side with the difference circled in red during setup, and as small red markers on the pieces during sorting.

## Data pipeline (decided 24 Oct 2026, built in step 10: keep this)
Design doc: "Data pipeline: scenarios, fixes and architecture" (scenarios S1–S18). Code in `server/`, acceptance test `npm test`.
- **Z:\ is the source of truth and is only ever read.** The programmer copies the LST + GEO files to it from his own PC with copy and paste. File dates are his, so "today" uses our own `first_seen` and run activity.
- **One Windows PC on the LAN runs the service** (`server/main.js`, Node 22.13+, no dependencies); the monitors open `http://<server-ip>:8080/`. In `config.json` use the UNC path of the share, not the drive letter.
- **Plain polling every 15 s** (names, sizes, dates); only new or changed files are opened. No file-change events.
- **Accept a file only when complete:** seen unchanged twice, not locked by the copy, ends with its `ED` line (then `C`), pieces in `PARTS_IN_PROGRAM_POS` = sum of counts in `PARTS_IN_PROGRAM`. A missing GEO is "waiting" for a few minutes, then the job is listed as "incomplete" (part drawn as its box). A GEO must end with `#~EOF` and pass `geoProblem` (area vs header ±0.01, vs LST ±0.05; size vs LST), otherwise the part is drawn as its box ("suspect").
- **Storage:** one SQLite file (`picking.db`: `files`, `jobs`, `sorting_runs`, `events`, `scan_log`) + raw copies of accepted jobs by content hash + nightly `VACUUM INTO` backup. Parsed jobs are never stored.
- **Identity:** job content = SHA-256 of the LST + its GEOs. It never blocks anything: a rerun of the same program is a new **run** (program content + run number). Sorting state is keyed by run, never by job name.
- **Jobs and sorting runs (decided 25 Oct 2026):** a job has many sorting runs, but **at most one open run** (setup or sort) at a time; the server refuses a second one (409). Run phases: setup → sort → done, or **abandoned** (stopped on purpose: kept with its picks and log, never deleted). **Restart = fresh start:** the open run is abandoned and a new run (`started_as` restart, `parent_run_id`) starts at "How many pallets?"; picks are not carried over and the operator is warned about pieces already on pallets ("change setup, keep picks" is left for later). A new test session also starts a new run. Tapping a job that has runs shows a run card (continue / take over / restart / new sheet); a job without runs opens straight into setup.
- **Stations:** a station ID per screen (e.g. L95), no operator login. A run is claimed by one station; others see "In progress at L95" and can take it over; the old screen is told (HTTP 409).
- The browser keeps only the station settings, the language, the test log (also sent to the server) and an outbox of unsent changes. Without a server (`python tools/serve.py`) the app still runs as before, from `data/jobs/`.

## Data
1. **Part geometry:** one TRUMPF `.GEO` file per part (format below). A real example is `data/parts/1045572.GEO`.
2. **Nest layout:** where each part instance sits on a cut sheet. **The real format is the TruTops Boost `.LST` file** (e.g. `data/jobs/J14.LST`), read by `src/nest-loader.js`: `SHEET_TECH` (sheet), `PARTS_IN_PROGRAM` (part numbers, .GEO names, sizes), `PARTS_IN_PROGRAM_POS` (lower-left corner of each piece's box, angle, mirrored), `PARTORDER_IN_PRODORDER` (order per piece). The invented example sheet still uses the JSON below.
3. **Orders:** each piece's order comes from the job file. Pallets are no longer in the job: the operator decides them at the start of the job (see Workflow). A `pallets` list in an old JSON file is only read to find each part's order.

```json
{
  "sheet": "S-2026-1005-014",
  "size": [3000, 1500],
  "thickness": 8,
  "material": "S235JR",
  "example": true,
  "parts": [
    { "uid": "S014-01", "partNo": "1045572", "geo": "1045572.GEO",
      "x": 412.5, "y": 220.0, "rot": 90, "mirror": false, "order": "AO-1182" }
  ]
}
```
`x, y` = where the part's own origin (0,0 in its .GEO) is placed on the sheet, in mm. `rot` = degrees counter-clockwise around that origin, applied after the mirror (mirror about the part's Y axis). Sheet origin is bottom-left.

Real parts so far: 1045572 and 1045574 (.GEO), and job J14 (.LST; the .GEO for its part 1045575 is still missing, so it is drawn as its box). For the mock-up, create a few **invented** example parts (rectangles with holes, round flanges, L-brackets, small tabs, and some near-duplicates of each other) as `.GEO` files in the same format. Put them in `data/parts/examples/`, mark them as examples in the UI, and nest about 15–30 instances on a 3000×1500 sheet for 3–4 orders.

## TRUMPF .GEO format (reverse-engineered from 1045572.GEO; checked: the computed net area matches the header exactly)
- Plain text, **Windows-1252** encoding (contains "Plåt"). Units are mm.
- Sections start with `#~<code>`, usually end with `##~~`, and the file ends with `#~EOF`.
- `#~1` header: version (`1.03`), a number, a date, the bounding box min `x y z`, the bounding box max `x y z`, then the **net area in mm²** (13818.84 for this part).
- `#~11` part info, one value per line: ident (`Plåt 8mm`), name (`Lagerpall`), two blanks, order (`*BELEGT*`), material (`st37-80`), **thickness** (`8.0`), then flags.
- `#~3` process: name, then the process (`LASER`), then transforms and bounding box.
- `#~30` attributes, one `KEY@VALUE` per line, until `#~TTINFO_END`. Useful keys: `BEZCH` (name), `MAT`, `WERKSTOFF` (`1.0038` = S235JR), `ROTALLOWED` (0/1, rotation allowed in the nest), `TEILANZAHL` (quantity), `SOURCE_FILE_NAME` (the original DXF).
- `#~31` points. Each point is 4 lines: `P`, then the id, then `x y z`, then `|~`. Points are shared by all contours.
- `#~32` text: `TXT`, `3 1`, **anchor point id** (37), `10 1 0`, **`height angle`** (`3.0 90.0`), `18 1 1`, then **the text** (`1045572`), `1`, `1`, `|~`.
- `#~33` contour. First comes a blank line, then `index 24 flag`, where **flag 0 = outer contour and flag 1 = inner contour (hole)**. After that: a count, the normal (`0 0 1` outer / `0 0 -1` hole), bounding box min, bounding box max, center, area. Then `##~~`, then `#~331`, then the elements, then `##~~` and `#~KONT_END`.
  - `LIN`, `1 0`, `startId endId`, `|~`
  - `ARC`, `1 0`, `centerId startId endId`, then **direction** (`1` = counter-clockwise, `-1` = clockwise), `|~`
  - Handle `CIR` (full circle) too if it shows up. Fail with a clear message on any unknown element type.
- Outer contours run counter-clockwise (positive area) and holes run clockwise (negative). Net area = sum of signed contour areas, where each arc adds its circular-segment area `0.5·r²·(sweep − sin sweep)` to the chord polygon.
- Example part 1045572: a 165 × 90 mm plate, 8 mm, with chamfered/rounded corners and four 17 × 15 mm rounded slots. Net area is 13818.84 mm², which is about 0.87 kg in steel.

A working JavaScript parser for this format (contours to polylines, arc sweep, exact area check) is in `reference/geo-viewer.html`. It is inside the `parseGEO` and `buildContour` functions. Reuse that logic instead of rewriting it.

## Mock-up features (in priority order)
1. Load a job JSON and its .GEO parts, then draw the whole sheet top-down (2D, SVG or canvas) with every part in place, filled with its pallet's color and labeled with its part number at the text anchor.
2. Pallet panel: each pallet shows its order, its color, and progress such as "3 / 7 picked".
3. Guided picking: highlight the **next** part to pick (configurable order: by pallet, or nearest to the operator's edge of the sheet), and show where it goes in big letters ("→ PALLET 2").
4. Confirm a pick by tapping the part or pressing a big Confirm button. The part turns grey and the progress updates. Undo for the last action.
5. Exception buttons: missing, scrap, picked out of order (tap any part to confirm it, even if it is not the highlighted one).
6. Station setting: rotate/mirror the sheet view to match the operator's viewpoint, saved locally.
7. **Test logging (needed for the usability study):** record a timestamp for every action (part shown, confirmed, undo, exception) and export it as CSV, so we can measure time per pick and error rate.
8. Optional: a "sheet complete" summary, and a simulated put-to-light signal (a pallet tile flashes when it should receive the current part).

## Tech preferences
- Keep it simple and runnable on a school laptop: plain HTML/CSS/JavaScript, no build step, served with a simple local server (`python tools/serve.py`) or by the pipeline service (`npm run demo`, Node 22.13+, no npm packages). Tell me if you think a framework is really needed.
- Folder layout:
  ```
  CLAUDE.md
  index.html, src/ (geo-parser.js, nest-loader.js, ui.js, setup-view.js, plan.js, lookalike.js, picking.js, sheet-view.js, log.js, backend.js, …)
  server/ (main.js, pipeline.js, catalog.js, store.js, api.js, config.example.json, test/scenarios.test.js)
  tools/ (serve.py, make_examples.py, make-demo-z.mjs, projector-3d.html, vendor/three/), package.json (scripts only)
  data/parts/1045572.GEO, data/parts/examples/*.GEO
  data/jobs/index.json, data/jobs/J14.LST, data/jobs/example-sheet.json
  reference/geo-viewer.html
  ```
- Keep the .GEO parser as its own module with a small test that checks part 1045572: the net area must be 13818.84 mm² (±0.01) and there must be 1 outer contour + 4 holes.

## How to work with me
- Plan first and show me the plan. Then build in small steps I can run and look at after each one.
- Explain what each file does in plain terms. I am the UI/UX and testing lead and need to present and justify design decisions.
- Never present invented example data as real Brålanda data.
