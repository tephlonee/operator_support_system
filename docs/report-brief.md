# Report brief: Operator Picking Support

This file summarises the project so that an AI assistant (for example Claude on claude.ai) or a team member can help write the **project report** and the **literature review**. It contains facts about what was built, why, and what was found. It is updated after each build step.

Last updated: 23 October 2026, after build step 9 (the pallet-by-pallet workflow, look-alike check and real J14 job).

---

## 1. Rules for the assistant writing from this brief

1. **Never invent sources.** Every reference in the literature review must be a real publication that the team has found and checked. Do not produce author names, titles, years, DOIs or page numbers from memory. If a claim needs a source and none has been provided, write `[SOURCE NEEDED: what kind of source]` instead.
2. **Never invent results.** The usability study has not been run yet. Do not write numbers for time per pick, error rates, questionnaire scores or participant feedback. Use placeholders such as `[RESULT: mean time per pick]`.
3. **Never present invented data as real Brålanda data.** Real Brålanda data: the part files 1045572 and 1045574, and the job file `J14.LST` (sheet, positions and orders of job J14). The .GEO file for part 1045575 is still missing, so the app shows that part as its box only. Everything in the example sheet EX-S001 (layout, orders and all `EX-` parts) is invented for demonstration.
4. **Ask when unsure.** If something is not in this brief, ask the team rather than guess. Section 9 lists what is still unknown.
5. **AI use.** Check the course rules on AI-assisted writing and how AI use must be declared in the report, and follow them.

## 2. Project context

- **Course:** "Project in AI" (7.5 credits), University West (Högskolan Väst), autumn 2026.
- **Industry partner:** Brålanda Industri AB, which cuts sheet-metal parts on a TRUMPF laser cutter.
- **Team and roles:**
  - Tijani-Ahmed Oboirien: technical lead (systems, data)
  - Hussein Lekis: research and documentation lead
  - Ch Emaan Wasay: design and testing lead (UI/UX, test planning)
- **Deliverables:** a working mock-up/simulation, and a report on the engineering design process.
- **Dates:** final presentation 27 October 2026; report due 8 November 2026.

## 3. Problem

After the laser cuts a sheet, an operator removes the parts from the sheet skeleton and sorts them onto the correct pallets or kits, one per customer order. Many parts look alike. This makes the work slow and leads to mix-ups.

**Goal:** a digital operator support system. A screen at the unloading station shows the cut sheet exactly as the operator sees it. Every part is drawn in its real position and coloured by its destination pallet. The operator picks a part, confirms it, and the kit progress updates.

## 4. Key design decisions and their reasons

| Decision | Reason |
| --- | --- |
| **No computer vision.** Parts are identified by their position on the sheet, which comes from the nesting layout, not by how they look. | The metal parts are reflective, so camera recognition would be unreliable. The nesting software already knows exactly where every part is. This is a deliberate choice in an AI course: a simpler, more reliable data-driven method was chosen over an AI method that fits the conditions poorly. |
| **The screen matches the operator's view.** The sheet can be rotated (0/90/180/270°) and mirrored, as a setting per station. | If the screen and reality are turned differently, "top-left" means different corners and the operator picks the wrong part. |
| **Show the marked part number.** Each .GEO file contains the text the laser probably marks on the part (for example "1045572"). | The operator can confirm a part by reading the number on the metal. Whether the laser really marks this text has not been confirmed yet (section 9). |
| **Built for the shop floor:** touch targets at least 64 px (operators wear gloves), large text, high contrast, readable from about 1.5 m, one main action at a time. Target screen 1920×1080, landscape. | Working conditions at the unloading station. |
| **Colour is never the only cue.** Every part, tile and card shows the pallet's number with its colour ("Blue 1"). The colours are the Okabe–Ito palette, chosen to stay distinguishable for colour-blind people. | Colour-blind operators, and colours that can look alike under workshop lighting. |
| **The operator sets up the pallets at the start of every job (build step 9).** Four short setup steps: choose the job; choose the number of pallets (the app suggests one per order); check the proposed assignment of parts to pallets (move a part, split a quantity one piece at a time, add or remove a pallet); hang the cards, then Ready. | Which pallets a job needs depends on the job and on the operator (some pallets take two or three part numbers). Deciding *before* sorting moves the decisions to a calm moment, so that during sorting the operator only follows colours: fewer decisions at the point of work. The app's proposal means the operator rarely starts from a blank screen. |
| **Colours follow a fixed order, not a fixed place.** Pallet 1 is always Blue, 2 Orange, 3 Green, 4 Yellow …; with more than 8 pallets the colours repeat with new numbers. Reusable hanging cards (colour + number) go on the pallets. | The number of pallets changes from job to job, and pallets move around, so colours cannot belong to a floor position. A fixed order is quick to learn ("1 is blue"). |
| **Proposal rule:** one pallet per order. With fewer pallets than orders, the biggest orders get a pallet each and the others are added where look-alikes of their parts already are (if that pallet is not much fuller), otherwise to the least loaded pallet. | Look-alikes on the same pallet cannot be mixed up. The balance limit stops the proposal from piling everything onto one pallet. |
| **Sorting one pallet at a time.** Only the pallet being sorted is highlighted on the sheet; all other parts are grey. When it is complete, the next pallet starts by itself. Any highlighted piece can be picked in any order (it is not "out of order"). The old "nearest part first, all pallets" order stays as a station setting, as a comparison condition for the usability study. | The operator searches only among the pieces of one destination: a much smaller search set and one decision at a time. Several pieces for the same pallet can be carried together, which can cut walking. |
| **"Picked N".** Besides one tap per piece, the operator can report several pieces at once (2, 3, 4 or all remaining of the pallet). One Undo takes them all back. | Small parts are often picked by the handful. |
| **"Pallet full".** Adds a pallet with the next colour and number and moves the pieces still open for the full pallet onto it; it is sorted next. The screen then asks for the new card to be hung (one thing to do), and Undo takes it all back. | A pallet can fill up before all its pieces are on it. |
| **Always on screen while sorting:** the running count per pallet, broken down by part number ("Blue 1: 14 / 23 · 8/12 × 1045572 · 6/11 × 1045574"), the sheet's overall progress in the header, and Undo. | The operator and a supervisor can see at a glance what is left; Undo is always one tap away. |
| **Look-alike check computed from the .GEO outlines (no camera).** Pairs are compared on size, area, number of holes and outline overlap (the share of shared material in the best of 40 positions: turned 0/90/180/270°, mirrored or not, lined up at each corner or the centre). Pairs with at least 85 % overlap are look-alikes. The material only one of the two has is the distinguishing feature (an extra hole, a notch, a longer leg). Mirror images are detected and labelled ("mirrored: extra material on the left"). | Near-identical parts are the main cause of mix-ups. The outlines are already in the job files, so the difference can be found exactly and shown, instead of relying on the operator spotting it. |
| **Where the difference is shown:** during setup, both outlines side by side with the differing features circled in red, and a warning if look-alikes end up on different pallets; during sorting, a small red marker on the feature of every highlighted look-alike piece, the full red circle in the close-up, and a picture of the look-alike with the same marks. | The operator learns the difference once, before sorting, and can check it on every piece while picking. |
| **The outlines are compared on a fine grid (about 360 cells along the long side) instead of with a polygon library such as Shapely.** | Same result for finding and circling features of a few mm, and no library or install is needed (the app must run on any laptop, offline). |
| **The real job file is read directly:** the TruTops Boost `.LST` file gives the sheet, every part's position and angle, and its order. A part whose .GEO file is missing is shown as its box (dashed), with a banner, and is left out of the look-alike check. | The app can run on Brålanda's real data now, and degrades honestly when a file is missing. |
| **Screen split into "where" and "what now".** On the left: the sheet, with pallet tiles under it. On the right: one next part, where it goes, and the Confirm/Undo buttons, always in the same place. | Supports "one main action at a time". The operator's eyes go to one fixed place for the current task. |
| **Guided picking with a highlighted next part.** The part gets a pulsing yellow ring on the sheet, plus a close-up showing where its number is marked, and its destination in large letters in the pallet colour ("→ PALLET 2"). The target pallet's tile is highlighted. | Reduces searching and mix-ups between near-identical parts. The pulse stops for users who have asked their system for reduced motion. |
| **Two ways to confirm:** a large Confirm button (104 px high), or tapping the highlighted part on the sheet. The highlighted part always has a tap area of at least 72 × 72 px, even if the part itself is tiny. | Gloves, and small parts that are only about 50 × 25 px on screen. |
| **Tapping the wrong part explains, instead of doing nothing silently** ("EX-2008 is not the highlighted part…"). | Immediate feedback on errors. Step 5 will turn this into the "picked out of order" option. |
| **Default pick order: one pallet at a time**, nearest part first within each pallet. The alternative order, "nearest part first regardless of pallet", is built in and becomes a station setting in step 6. | The operator's standing position is unknown, and completing one kit at a time is easy to understand. |
| **Unlimited undo, step by step.** | Mistaken confirmations (a double tap, the wrong button) must be easy to reverse. |
| **Honest kit status:** besides "picked", the operator can report "missing", "scrap/damaged" and "took another part" (picked out of order). Missing and scrap are counted separately from picked parts. A pallet with a missing or scrapped part ends as **"Incomplete"**, never "Complete". The sheet ends with a summary ("24 picked · 1 missing · 1 scrap"). | Small parts may have dropped through the grid or still hang on micro-joints, parts can be damaged, and the real process does not always follow the planned order. A kit that only looks complete on screen would cause problems downstream. |
| **Each status looks different on the sheet,** not only by colour: open = pallet colour; picked = grey; missing = pale with a red dashed outline and the word "MISSING"; scrap = red hatching and the word "SCRAP". | Readable at a glance from 1.5 m, and also without colour vision. |
| **Out of order is a two-step action.** Tapping a part that is not the suggested one first shows it in the panel, with its own destination ("→ PALLET 3"). A second tap, or Confirm, picks it. The suggested part keeps a dashed ring, with a "Back" button. *(This differs from the brief's "tap any part to confirm it".)* | The operator must see where an unexpected part goes before placing it, and an accidental touch with a glove must not count as a pick. Tapping the suggested part still confirms it in one tap. |
| **Station settings: turn (left/right in 90° steps), mirror, and pick order.** They are opened with a "⚙ Station" button and saved on that screen, so each station keeps its own. While open, they replace the right-hand panel and the **whole sheet** is shown, with its 0,0 corner marked in yellow, so it can be matched against the real sheet. Changes apply live. | The screen must show the sheet the same way round as the operator sees it. Matching is easiest when you can see the sheet's edges and corners. |
| **No separate "operator edge" setting.** Once the picture matches the operator's view, the side of the sheet nearest them is always at the bottom of the screen. The app works out the near edge from the orientation, and the "nearest part first" order uses it. | One setting instead of two: fewer ways to set the station up wrong. |
| **"Mirror" always flips the picture left↔right on the screen, and "Turn left" always turns it left, mirrored or not.** | Buttons must do what their label says, whatever was pressed before. |
| **Auto-zoom on small parts** *(suggested by the design & testing lead after using the mock-up)*. When the part to pick would be smaller than about 90 × 40 px on that screen, the sheet zooms smoothly (450 ms) to centre on it, at most 3×, so neighbouring parts stay visible. An overview map in the corner shows where the zoomed view is on the sheet, and tapping it shows the whole view. It can be switched off in Station settings, and that setting is logged. | Small parts were hard to see and tap (about 50 × 25 px). The rule is in screen pixels, not millimetres, so the same part zooms on a small laptop screen but not on the big shop-floor screen. The smooth movement and the overview map keep the operator oriented. On/off also gives the usability study a variable to compare. |
| **Undo one specific part ("reopen")** *(suggested by the design & testing lead)*. Tapping a grey (picked) part shows it in the panel with "↶ Undo this pick (the part is still on the sheet)". This sets only that part back to open, however many actions ago it was picked. The same works for parts marked missing or scrap. For picked or scrapped parts the button takes the place of Confirm, which cannot be used for them. | The normal Undo only steps back through the most recent actions. A wrong pick noticed later (the part is still lying on the sheet but shown as picked) must be fixable without undoing all the correct picks made since. The sheet itself shows the mistake: a grey part that is physically still there. |
| **Test log for the usability study:** a "📋 Test" panel for the moderator with participant ID, condition and note, "Start new session" (resets the sheet), and "Export log (CSV)". Every event is logged with a time: part shown, confirm, missing, scrap, undo, reopen, taps on the sheet, selections, setting and language changes, panel use, and page reloads. | The study needs time per pick and error rate. Ready-made timing columns save manual work in Excel. Taps and selections show how operators actually use the screen. |
| **The log and the picking progress survive a page reload.** | A reload or a mis-click during a test must not lose a participant's data. |
| **Exceptions are recoverable.** A missing part can still be picked if it is found. A picked part can later be marked as scrap (damage noticed afterwards). Every action can be undone. A scrapped part cannot be picked. | Real situations at the station, and fast correction of mistakes without a confirmation dialog on every press. |
| **English and Swedish**, switchable on screen. | Operators are likely to be Swedish speakers. The Swedish text is a draft that still needs checking by a native speaker. |
| **Plain HTML, CSS and JavaScript with no frameworks, no build step and no installs.** It runs in any browser with Python's built-in web server. System fonts only. | Simple to run on any laptop, easy for the team to understand and present, and it works offline on the shop floor. |
| **The job format is isolated in one module** (`src/nest-loader.js`). | The real export format from Brålanda's nesting software and ERP system is not known yet. When it arrives, only this one file needs changing. |

## 5. Data

- **Part geometry:** TRUMPF `.GEO` files. This is a plain-text CAD format (Windows-1252 encoding, units in mm). The team reverse-engineered it from the real file 1045572. It stores numbered points, then contours built from lines (`LIN`), arcs (`ARC`) and full circles (`CIR`), plus the marked text with its position, height and angle.
- **Real parts from Brålanda (2):**
  - **1045572:** "Lagerpall" plate, 165 × 90 mm, 8 mm steel (st37-80 / S235JR, material no. 1.0038), 4 slots, net area 13 818.84 mm².
  - **1045574:** "Lagerpall" part, 833 × 135 mm, 8 mm, 3 round holes, net area 62 502.80 mm².
  - Both files say rotation is not allowed when nesting (`ROTALLOWED 0`).
- **Invented example parts (8),** created for the demo as four near-duplicate pairs. They imitate what makes picking hard:
  - EX-2001 / EX-2002: a plate with 4 or 3 corner holes
  - EX-2003 / EX-2004: a flange with 6 or 8 bolt holes
  - EX-2005 / EX-2006: a right-hand and a left-hand (mirrored) L-bracket
  - EX-2007 / EX-2008: a small tab with 1 or 2 holes
- **Invented example job:** 26 parts on a 3000 × 1500 mm sheet, for 4 orders (8 / 7 / 5 / 6 parts). Near-duplicates are placed next to each other but belong to different orders, to provoke the mix-up the system should prevent. The job file has no pallets any more: the operator chooses them.
- **Real job J14 (`data/jobs/J14.LST`, TruTops Boost):** sheet 2000 × 1000 × 8 mm, St37-80; 33 pieces: 12 × 1045572 (order OR17), 10 × 1045575 (OR14), 11 × 1045574 (OR13). The `.LST` tables used: `SHEET_TECH` (sheet), `PARTS_IN_PROGRAM` (part numbers, .GEO file names, sizes), `PARTS_IN_PROGRAM_POS` (position of each piece's box, angle, mirrored), `PARTORDER_IN_PRODORDER` (order of each piece). The .GEO file for 1045575 has not been received yet.
- **Found in the J14 data:** 1045572 and 1045574 are not look-alikes. 1045575 cannot be checked until its .GEO file arrives; by its size from the LST (350 × 135 mm, against 833 × 135 mm for 1045574) it would not count either, although the two share the 135 mm profile and a 3-hole tab. The look-alike features are therefore demonstrated with the invented example sheet.
- **Not yet available:** the ERP export of order → customer/pallet, if pallets should ever be proposed from it.

## 6. Engineering process so far (build log)

The work follows a plan of 8 small steps. Each step can be run and checked before the next starts.

| Step | Status | What was done | Findings |
| --- | --- | --- | --- |
| 0. Plan | Done, 5 Oct | Requirements in the project brief turned into an 8-step plan. Open questions identified. | The operator's standing position at the unloading station is unknown. It matters for screen orientation and for the "nearest part first" pick order. |
| 1. Parser | Done, 5 Oct | `.GEO` reader based on an earlier prototype viewer, with an automated test. | **Problem found in real data:** the round holes in 1045574 are stored as `CIR` elements with no direction, so a naive area calculation counts them as material instead of holes. Fixed by using each contour's hole flag. **Validation:** the computed net area matches the area stored in each file's header to within 0.01 mm² for both real parts. This is strong evidence that the geometry is read correctly. |
| 2. Example data | Done, 5 Oct | A generator script creates the invented parts and the example job, and refuses layouts where parts overlap or leave the sheet. | Real parts are placed unrotated, as their files require. |
| 3. Sheet view | Done, 5 Oct | The sheet is drawn top-down with every part in place, coloured by pallet and labelled with part number and pallet. It has an example-data banner, a pallet panel, and an English/Swedish switch. | **The real laser marking is too small to read on screen.** Text 3 mm high is about 2 px. Solution: a large, readable label centred on the marking's position on each part (the true-size marking will be shown in a zoomed detail view). **Small parts are hard to see and tap.** An 80 × 40 mm tab is only about 50 × 25 px on a 1920×1080 screen, even with the view zoomed to the used part of the sheet. Planned solutions: a zoomed "next part" view and larger invisible tap areas. |
| 4. Guided picking | Done, 5 Oct | The picking rules are in a separate module with no screen code: pick order, next part, confirm, undo, and progress per pallet. Every action is sent out as a timestamped event for the test log in step 7. On screen: the yellow ring on the next part, the close-up, the destination in large letters, Confirm/Undo, pallet tiles with "3 / 8" and a progress bar, and feedback text after every action. Checked in English and Swedish, at 1920×1080, mid-session. | Even zoomed in, the true-size 3 mm marking is too small to read for long parts (1045574 is 833 mm long). The close-up therefore shows **where** the number is (a yellow ring) and prints the number large underneath. **Limitations:** progress is lost if the page is reloaded; pallet names come from the data file, so they stay English ("Pallet 2") when the screen is in Swedish. |
| 5. Exceptions | Done, 5 Oct | Missing, scrap/damaged, and "took another part" (out of order). Each part now has a status of open, picked, missing or scrap, with rules for which changes are allowed. Pallet tiles show the problems in red and end as "Complete" or "Incomplete". The sheet ends with a summary. Every exception is sent out as a timestamped event, marked as in or out of order, for the test log. Checked with screenshots mid-sheet and at the end of a sheet with problems, in English and Swedish. | The brief's "tap any part to confirm it" was changed to a two-step action (show first, then confirm) for safety; see section 4. The "Took another part" button is mostly there so operators discover the option. Tapping another part on the sheet works without pressing it first. The SCRAP/MISSING words on very small parts (80 × 40 mm tabs) are hard to read; the pattern and outline still show the status. |
| 6. Station setting | Done, 6 Oct | A settings panel with turn left/right, mirror, and pick order ("one pallet at a time" / "nearest part first"), plus Reset and Done. Settings are saved in the browser and only valid values are accepted. Changing the pick order mid-sheet keeps all parts already handled and is sent out as an event for the test log. Checked with screenshots: the settings panel after one turn, and the rotated picking view. | **Trade-off:** turned 90° or 270°, the 3000 × 1500 mm sheet becomes portrait on a landscape screen, so parts get smaller (labels of the small tabs crowd together). Matching the operator's view was judged more important. **Open question for Brålanda:** which physical corner of the sheet is the nesting software's 0,0 corner? Knowing it would make station setup a single step ("put the yellow corner where the machine's zero corner is"). **Possible misuse:** an operator could open the settings by accident; protecting them (for example with a long press) is left for later. **Found when the team tested it on a laptop:** (1) the browser kept showing the old version, because Python's built-in server lets browsers keep copies of files. Fixed with a small server (`tools/serve.py`) that forbids this. (2) On a laptop screen (about 1536 × 700 usable pixels at 125 % Windows scaling), the exception and Undo buttons were pushed off screen. Fixed with a compact layout for short screens. In it, buttons stay at least 52 px high, while the 1920 × 1080 shop-floor screen keeps the full sizes. Lesson: test on the real target screen, and on the screens used for demos. |
| 7. Test logging (+ two improvements) | Done, 6 Oct | A test log with CSV export, a Test panel, and saving of log and progress across reloads. Two improvements were requested by the design & testing lead after trying the mock-up: **auto-zoom on small parts** and **undo of one specific part**. Every action now also records how it was done (button or tap). Checked: 116 automated checks; screenshots at 1920 × 1080 and at laptop size (1536 × 700); and an end-to-end run in the real app (pick, out-of-order tap, missing, reopen, undo), whose saved log rows were inspected one by one. | **Testing pitfall found again:** the test browser itself had kept old copies of a test file, so 7 new checks silently did not run. They were found only because the number of checks was lower than expected. Lesson: compare the check count after each change. **CSV and Excel:** the file uses commas. Swedish Excel expects semicolons, so it may need Data → From Text/CSV. **Limitation:** after a reload, `ms_since_shown` for the current part counts from the reload. |
| 8. Extras (optional) | Partly done in step 9 | "Sheet complete" summary (now with pallets, pieces and corrections). Put-to-light is still open. | |
| 9. Workflow v2 | Done, 23 Oct | The workflow decided by the team: setup per job (choose job → number of pallets → assignment → hang cards), sorting one pallet at a time with "picked N" and "pallet full", the look-alike check, the summary, and reading the real `J14.LST`. New modules: `plan.js`, `lookalike.js`, `setup-view.js`. Checked: 147 automated checks; a full run in a real browser on both jobs (setup, split, taps, picked N, pallet full and its undo, reload mid-sheet, complete) in English and Swedish, at 1920 × 1080 and 1536 × 700, with the panel measured to fit without scrolling. | **Proposal pitfall:** the first rule ("put an order where its look-alikes are") put every order of the example on pallet 1, because every order shares a look-alike with another. Fixed: each pallet first gets an order, and the look-alike preference only applies within a balance limit. **Message pitfall:** after "pallet full" the screen first said "Blue 1 complete", which was wrong (it was full, not complete); the pallet-change event now says why it happened. **Real data:** J14's 1045575 has no .GEO file yet; it is shown as its box. |
| 10. Data pipeline | Done, 24 Oct | A small pipeline service on one Windows PC on the LAN (Node.js, no extra packages): it polls Z:\ every 15 s, accepts a pasted job only when it is complete and checked, keeps a catalog, raw copies and the sorting runs in one SQLite file, and serves the app to the monitors. The design was tested first as 16 scenarios against a deliberately simple version (only 2 passed), reviewed with the team (S17 corrupted GEO and S18 rerun added), and the built service passes all 18 as automated acceptance tests on the real J14 files. Also checked end to end in a browser with two stations (claim, takeover, reload) and with the server stopped mid-sort. | **Findings:** a half-copied LST parses without error and showed 9 of 33 pieces (now refused: end line `ED`, lock, piece count). A garbled coordinate in a GEO still parses; only the exact area check catches it (13817.86 vs 13818.84 mm²). Pasted files keep the programmer's file date, so "today" uses the server's own first-seen time. Identical content is recognised by hash but never blocked: cutting a program again is a new run. **Limitation:** each poll stats every LST; over SMB this is about 1 ms per file, so a few seconds for thousands of old jobs. |

**Verification so far:** 151 automated checks in the browser and 20 acceptance tests of the pipeline service (scenarios S1–S18, `npm test`) pass. The browser checks cover:
- the parser on both real parts
- all 8 example parts
- the placement maths (move, rotate, mirror)
- the example job (all parts on the sheet, no overlaps)
- clear error messages for bad input
- the picking rules (both pick orders, confirm, progress, undo, refusing a double confirm, sheet complete)
- the exceptions (missing, found again, scrap after picking, scrap cannot be picked, out-of-order selection and logging, completion summary)
- the station settings (bad saved values refused, the near edge correct for all 8 turn/mirror combinations, mirror flips left↔right at every rotation, pick order change mid-sheet)
- undo of one specific part, and saving/restoring progress
- the test log (timings, CSV format and escaping, file name, complete rows from real picking events)
- the real J14.LST job (sheet, counts per part, orders, a piece's exact position, the missing .GEO shown as a box) and the LST reader
- the GEO integrity check (a garbled coordinate and a wrong size are caught; a damaged part is drawn as its box)
- the pallet plan (colour order, proposal with fewer/more pallets than orders, move, split, add/remove pallet, look-alike warning, which pieces go where, save/restore)
- one pallet at a time, picked N with one undo, pallet full and its undo, the running count per part, save/restore with an added pallet
- the look-alike check (exactly the four invented pairs found; the missing corner hole found at the right spot; holes on both flanges; the mirrored L-brackets detected with the feature on opposite sides; a part turned 90° still recognised; different parts rejected with the reason)

The screen was also checked visually with screenshots at 1920×1080.

## 7. Planned evaluation (usability study)

- **Measures from the app's log (built, step 7):** time per pick and error rate.
  - The CSV has one row per event, with these columns: `session_id, participant, condition, note, seq, time_local, t_session_ms, event, uid, part_no, pallet, suggested_uid, suggested_part_no, out_of_order, from_status, to_status, via, ms_since_shown, ms_since_prev_action, detail`.
  - **Time per pick** = `ms_since_shown` on `confirm` rows (time from the suggested part being shown to the action). Rows with `via = batch` come from "picked N".
  - **Setup** = the rows from `job_selected` to `cards_ready` (setup time, and every change the operator made to the proposal: `pallet_count`, `plan_move`, `plan_split`, `plan_add_pallet`, `plan_remove_pallet`).
  - **Time per pallet** = between `pallet` rows. **Pallet full** = `pallet_full` rows.
  - **Corrections** = `undo` and `reopen` rows.
  - **Deviations** = `out_of_order = 1`.
  - **Selections and taps** (`tap`, `select`) show hesitation and mis-taps.
  - **Wrong pallet:** the system cannot detect this; it needs observation, or a check of the pallets after the test.
- **Session data:** each session records a participant ID, a test condition (free text, for example "with auto-zoom" / "without auto-zoom") and an optional note.
- **Still open:** questionnaires, the number of participants, the tasks, and whether testing happens with real operators at Brålanda or with students. The team has not decided these yet. Mark them `[TBD]`.

## 8. Literature review: topics to search

The team needs to find and verify the sources. Below are topics and search terms, not citations. Useful databases: Google Scholar, IEEE Xplore, ScienceDirect, the ACM Digital Library, and the University West library search.

1. **Order picking and kitting errors in manufacturing.** How often errors happen, what they cost, and their causes. Terms: "order picking errors", "kitting", "manual picking accuracy".
2. **Picking assistance systems.** Pick-by-light and put-to-light, pick-by-display and pick-by-vision (AR glasses), compared with paper lists. Terms: "pick-by-light", "put-to-wall", "order picking head-mounted display comparison".
3. **Operator assistance and cognitive load in Industry 4.0.** Terms: "Operator 4.0", "worker assistance systems", "cognitive assistance assembly", "digital work instructions".
4. **Part sorting after laser cutting.** The unloading/sorting problem, existing automated sorting from sheet-metal machine makers, and why automation is not always used. Terms: "laser cutting part sorting", "sheet metal unloading", "nesting".
5. **Why computer vision struggles here.** Recognition of reflective/metallic parts and of nearly identical parts. Terms: "specular surfaces object recognition", "reflective metal parts vision". This supports the decision not to use computer vision.
6. **Interface design for industrial touch screens.** Touch target size, gloves, viewing distance, and colour use. Terms: "touch target size gloves", "industrial HMI design guidelines". Standards worth checking: the ISO 9241 series (ergonomics of human-system interaction), and WCAG 2.x success criteria on use of colour and target size.
7. **Usability evaluation methods.** The System Usability Scale (SUS), NASA-TLX for workload, task time and error rate as performance measures, and think-aloud. Terms: "System Usability Scale", "NASA-TLX", "usability testing manufacturing".
8. **Engineering design process and human-centred design.** A framework to structure the report: for example a human-centred design process standard, and iterative prototyping.

For each source the team uses, record:
- the full reference
- what claim it supports
- where in the report it is used

## 9. Open questions (to ask Brålanda)

1. What is the export format of the nesting/CAM software: part positions, rotation and mirroring per sheet?
2. What does the ERP export of part number → order → pallet look like?
3. Does the laser really mark the part number from the .GEO text on the part? Is the text anchor at the bottom-left of the text?
4. Where does the operator stand at the unloading station, and is that position fixed? This decides screen orientation and the "nearest part first" pick order. Which physical corner of the sheet is the nesting software's 0,0 corner?
5. What screen hardware is planned (size, touch, mounting)? Do operators wear gloves at the station?
6. How are small parts and micro-joints handled today? How often do parts go missing or get scrapped?
7. Who could take part in a usability test, and when?
8. Can we have the .GEO file for 1045575 (job J14)?
9. How many part numbers or pieces fit on one pallet? Can the same part number go to two orders on one sheet?
10. Is Z:\ a share on the server PC or on another machine, and what is its folder layout (one folder per machine and per job)?
11. Does `NcProgramGuid` stay the same when a program is saved again? (A second export of J14 would show it.)
12. How many programs are cut per day, in how many shifts, and how long should sorting records be kept (e.g. for complaints)?

## 10. Suggested report outline (adapt to the course template if there is one)

1. **Introduction:** the problem at Brålanda, aim, scope, research questions `[team to decide]`.
2. **Background and literature review:** section 8 topics.
3. **Method:** the engineering design process followed, and how requirements were gathered.
4. **Requirements:** from the partner brief: shop-floor conditions, position-based matching, honest kit status.
5. **Concept and design decisions:** section 4, including why computer vision was rejected.
6. **Implementation:** the architecture (parser, job loader, sheet view, picking logic, logging), the data formats, and the example data.
7. **Verification and evaluation:** automated tests (section 6) and the usability study (section 7) `[results pending]`.
8. **Discussion:** limitations, such as invented example data, unknown real formats and no field test yet; what changes with real data; future work.
9. **Conclusion.**

## 11. Files in the mock-up (for the implementation chapter)

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | The app page and its look (1920×1080 shop-floor screen) |
| `src/ui.js` | Builds the screen and connects the pieces: setup → sorting → summary |
| `src/setup-view.js` | The setup screens: choose job, number of pallets, assignment with the look-alike check, hang the cards |
| `src/plan.js` | The pallet plan: colour order, proposal, move/split, add/remove pallet, which pieces go where (no screen code) |
| `src/lookalike.js` | Finds look-alike parts and where they differ, from the .GEO outlines (no screen code) |
| `src/picking.js` | The picking rules: one pallet at a time, next piece, piece status (open/picked/missing/scrap), picked N, pallet full, out of order, undo, progress per pallet and part (no screen code) |
| `src/sheet-view.js` | Draws the sheet, the parts, their colours and labels, the next-part ring and the close-up |
| `src/nest-loader.js` | Reads the job: the real TruTops `.LST` file or the example JSON (sheet, positions, orders); the only format-specific code |
| `src/geo-parser.js` | Reads TRUMPF .GEO part files |
| `src/matrix.js` | Maths for moving, rotating and mirroring shapes |
| `src/i18n.js` | English and Swedish screen text |
| `src/settings.js` | Station settings (turn, mirror, pick order, zoom on small parts), saved per screen |
| `src/log.js` | Test log for the usability study, CSV export |
| `src/backend.js` | Where jobs come from and progress goes: the pipeline service, or this browser when there is no server |
| `server/` | The pipeline service: poller and checks (`pipeline.js`), today's list and search (`catalog.js`), SQLite store (`store.js`), web API (`api.js`), start-up and nightly backup (`main.js`), acceptance test S1–S18 (`test/`) |
| `tools/make-demo-z.mjs` | Builds a stand-in Z:\ folder for demos |
| `tools/serve.py` | Local web server that stops browsers keeping old copies of files |
| `test/` | Automated test page (147 checks) |
| `tools/make_examples.py` | Generates the invented example parts and job |
| `data/` | Real parts, invented example parts, the real job J14.LST, the example job, and the job list (`data/jobs/index.json`) |
