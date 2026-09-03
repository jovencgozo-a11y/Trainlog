# Final Lovable readiness audit

Audit date: 2026-09-03 · commit `8713591` · branch `claude/new-session-quqsqz`

Documentation only. Nothing under `src/core/`, `handoff/` or `index.html` was
touched; no fixture was regenerated. Every figure below was re-measured for this
audit, not copied from earlier notes.

Companion documents: `LOVABLE_HANDOFF.md` (the brief), `MIGRATION.md` (the full
spec), `src/core/README.md` (import boundaries).

---

## 1 · Frozen core

### Ready to migrate unchanged — confirmed

`git diff HEAD` over `src/core/`, `handoff/` and `index.html` is empty. Nothing
in either package imports the DOM, `window`, `document`, `localStorage`, timers
or the network; both are plain ES modules with no build step and no runtime
dependencies.

### Handoff tests — 21/21 ✅

```
handoff/trainlog-core.test.js    14 pass    characterization tests, pure Node
handoff/engine-golden.test.js     3 pass    27,898-case replay + envelope, pure Node
handoff/systems-golden.test.js    4 pass    the 3,006-case replay, needs Playwright + a served app
                                 ──
                                 21 pass, 0 fail   (npm test, 15.8 s)
```

### Golden master — 3,006/3,006 ✅

```
scheduling          272 recorded cases still reproduce   ok
readiness         2,650 recorded cases still reproduce   ok
scoring              46 recorded cases still reproduce   ok
programGeneration    38 recorded cases still reproduce   ok
                  ─────
                  3,006   0 divergences
```

Neither `systems-golden.json` nor `engine-golden.json` has been modified since it
was recorded.

### Standalone Node imports — confirmed ✅

All six modules import and **execute** in plain Node — no DOM, no `bindHost()`,
no globals:

| Module | Exports | Live call |
|---|---|---|
| `src/core/engine.js` | 221 | — |
| `src/core/readiness.js` | 24 | `readinessScore` → `50`; `autoReg().level` → `0` |
| `src/core/scoring.js` | 54 | `scoreState().xp` → `0` on an empty history |
| `src/core/scheduling.js` | 38 | `buildSchedule(...).liftDows` → `[0,1,3,4]` |
| `src/core/programGeneration.js` | 161 | `composeProgram(4242, setup)` → 4 days × 6 exercises, targets rendered |
| `handoff/trainlog-core.js` | 24 | `judgeSession` → `{hit:true, eff:'solid', assumed:true}`; `decideLoad` → `{w:140, action:'progress'}`; `vetLoad` catches a bad rec |

Import is not the same as working, so the audit called each one rather than just
resolving it. All returned sane values.

**Verdict: the core is frozen, green, and portable.**

---

## 2 · Progression — the mapping

`src/core/` does **not** contain the progression layer. These functions are still
in `index.html` and Lovable will rewrite their call sites. **Do not re-derive
their rules** — every threshold and branch already exists, verified, in
`handoff/trainlog-core.js`. The `index.html` versions differ only in that they
look things up (movement bank, plan, stored sessions) before deferring to the
same arithmetic.

| `index.html` | line | Call instead | What the UI must supply |
|---|---|---|---|
| `progHistory(exName, limit)` | 6856 | `judgeSession(s)` per session | Assemble the array yourself: read sessions **across the archive as well as the current block**, newest first, then judge each one. |
| `loadRec(exName)` | 6914 | `decideLoad(history, {exp, isLower})` | `isLower`, `setup.exp` |
| `repRec(exName, baseReps)` | 6982 | `decideReps(history, {baseReps, ceiling, nextRung, prevRung, exp})` | the ceiling and the two ladder rungs |
| `loadStep(exName, w)` | 6890 | `loadStep(w, isLower)` | `isLower` — derived from the movement's groups ∩ {quads, hamstrings, glutes, calves} |
| `speedCap(exName, target, floor)` | 6901 | `speedCap(recentWeights, target, floor)` | `progHistory(name, 3).map(h => h.w)` |
| `earnedThreshold()` | 6841 | `earnedThreshold(exp)` | `setup.exp` — the UI version reads the global |
| `repCeiling(exName)` | 6977 | → `opts.ceiling` | derived from the plan's rep target, default 15 |
| `nextVariation` / `prevVariation` | 7017 | → `opts.nextRung` / `opts.prevRung` | the UI owns the movement ladder |
| `targetRepsAt(exName, week)` | 6845 | → `judgeSession({targetReps})` | the rep target **as prescribed in that week**, not this week's |
| `progLoadSeed` / `progRepSeed` | 7092 / 7097 | first-exposure seed, UI-side | both core functions return `null` on first exposure by design |
| `bestOf(exName)` | 2643 | `bestOfAll(name, ctx)` in `src/core/scoring.js` | already in core |

So the rebuild is: **history assembly + plan lookups in the UI; every decision
imported.** Bodies below the lookup line are byte-identical between the two
copies — the audit diffed `loadStep` and `speedCap` and confirmed it.

### What must be preserved

Each of these is an audited fix. Losing one is silent — no error, just a wrong
weight weeks later.

1. **History spans every block.** `progHistory` reads the archive *and* the
   current block. Reading only `state.sessions` throws away earned weight the
   moment a program is filed, and re-seeds the lift from a percentage.
2. **Newest-first ordering.** `decideLoad` reads `history[0]` as "last session".
   Reverse it and it progresses off the wrong session. `vetHistory` detects this
   — keep it wired in.
3. **Silence is not "solid".** An untapped effort is inferred from reps
   (`assumed: true`) and asks for one extra clean session. Reading silence as
   solid turns the ratchet into an unbounded linear progression.
4. **Dosed days are filtered.** A day readiness deliberately lightened, and that
   was cleared, is not evidence — it must not become the base. A dosed day that
   was still *ground through* stays, because that is information.
5. **The streak counts at the current weight.** Consecutive earned sessions reset
   on a weight change. Running the streak through a bump made the threshold bite
   once in a lift's life.
6. **Big relative steps cost an extra session.** Below ~17 lb the smallest plate
   is a >15 % jump; the step cannot shrink, so it is made harder to earn.
7. **Epley is capped at ten reps.** A high-rep set can confirm a max, never
   inflate one.
8. **A swap regenerates the prescription.** Swapping a rep movement for a hold
   must re-derive targets — otherwise an 8–10 rep target becomes an 8–10 *second*
   plank with a meaningless "% 1RM" attached. `index.html:4951` (`doSwap`).
9. **Keep the safety envelope.** `vetLoad`, `vetHold`, `vetPct`, `vetHistory` on
   everything shown to a lifter. `LIMITS`: max jump 12 % / 12 lb, max load
   1500 lb, reps ≤ 60, holds 15–120 s, 25–95 % 1RM. (The 15 s envelope floor is
   deliberately looser than the 20 s floor `holdSecs` prescribes at — it catches
   a rep count mislabelled as seconds.)

No code was moved.

---

## 3 · Persistence — every localStorage key

Eight keys. Every read and write in `index.html` is wrapped in `try/catch` with a
default, so private mode and blocked site data degrade rather than break.
**Preserve that.**

| Key | Stores | Read | Written | Migration |
|---|---|---|---|---|
| `trainlog-data-v3` | the entire `state` blob — plan, seed, weeks, sched, adaptations, setup, sessions, runs, readiness, symptoms, archive, savedPrograms, mobility, ptRoutines, bw, sex, progAck, `savedAt` | once on `load()` at boot; also by the cross-tab `storage` listener | `saveNow()` — after every set, session close, program build, settings change, and on every hide event | **Yes.** Import once on first run so an existing user keeps their log. Single JSON blob; schema in `MIGRATION.md` §5. |
| `trainlog-data-v3-session` | the open, in-progress session (`ui.sess`) | `readOpenSession()` on boot and on resume | `writeOpenSession()` on every set edit, and on hide | **Yes, but keep it device-local.** Syncing it lets two devices claim one day and corrupts progression history. |
| `tl-theme` | `dark` \| `light` (app theme) | `appTheme()` on every `applyTheme()` | `toggleTheme()` | Per-device preference. Optional import. |
| `tl-sess-dark` | `1` \| `0` — session-screen dark mode, independent of the app theme | `sessDark()` on every `renderSession()` | `toggleSessDark()` | Per-device preference. |
| `tl-mm3-show` | `1` \| `0` — in-session muscle map visible | at `ui` initialisation (boot) | `toggleSessModel()` | Per-device preference. |
| `tl-mm3-side` | `left` \| `right` — which side the muscle map sits on | at `ui` initialisation (boot) | `flipSessModel()` | Per-device preference. |
| `tl-swap-persist` | `1` \| `0` — does a movement swap persist for the block, or just this session | at `ui` initialisation (boot) | `toggleSwapPersist()` | Per-device preference. **Behaviourally significant** — it changes whether `doSwap` rewrites the plan or only the open session. |
| `tl-tour` | `1` — walkthrough seen | `tourSeen()` | `markTourSeen()` | Per-device preference. The tour is disabled in this build (`ui.tour = null` on load). |

Probe key `__tl` is written and removed once at boot to set `canPersist`; it is
not storage, it is a capability test.

### Persistence behaviours that must survive the port

- **Synchronous writes on hide.** `visibilitychange`, `pagehide`, `beforeunload`,
  `freeze` and `blur` all call `saveNow()` / `saveSession()` with no `await`. An
  async save from `pagehide` resolves in a microtask the OS may discard — that is
  how an in-progress workout was lost.
- **Cross-tab reconciliation.** Every write stamps `state.savedAt`. The `storage`
  listener only moves forward: an incoming copy with an older or missing stamp is
  rejected and the newer one written back with a toast. Mid-session it adopts
  nothing at all — it warns and keeps the screen.
- **Visible failure.** `canPersist` is probed at boot; a failed save raises a
  banner. A silent write failure is the worst thing this app can do.
- **Load-time migrations:** `normalizeData()` (shape + clamping),
  `repairPlanNames()` (heals free-text swaps from older versions),
  `migrateProgramming()` (brings stored prescriptions up to the current engine).
  Port these or write equivalents against the new schema.

---

## 4 · UI behaviour to reproduce

### Tabs and navigation

Five tabs: **Today · Plan · Mobility · Progress · Build** (`TABS`,
`index.html:4524`). Bottom nav with an animated indicator dot (`paintNav`).
Progress has four inner segments — Rank · Trends · Log · History (`ui.logTab`,
default `rank`). First run with no plan lands on **Build**.

### Build wizard

Seven steps (`STEPS`, `index.html:4039`): `exp → split → goals → kit → days →
run → review`.

- Experience picker; beginners additionally get a session-length cap (35–45 or
  45–60 min) — everything is built to fit that.
- Split style, plus injuries beside it (what you work around shapes which
  movements the split can use).
- Goals, sport presets and season.
- Equipment preset + individual kit toggles. **New kit keys must follow the
  active preset, never default to off** — otherwise an existing user silently
  loses movements.
- Lift days, run days, block length, start date, training weekdays.
- Review, then generate. `resetSetup()` ("new client") on every step.
- Separate custom builder (`viewCustom`): add/rename/delete days and exercises,
  periodisation toggle.
- "Shuffle movements" re-rolls the seed.

### Today

Greeting and date header · readiness card · today's session card · the week
calendar strip · rest-day note · post-session prompt · drift banner.
`suggestDayId` is sequence-based, so a missed day is picked up next rather than
skipped.

### Session logging

- Per-set weight and reps, add/remove/skip/nudge set, warm-up rows separate from
  working sets.
- Optional effort tap: **easy / solid / hard / grind**. Silence stays meaningful
  (see §2).
- Rest timer with vibration at zero; **it must resume from real time** after the
  app is backgrounded, not from where it was suspended.
- Warm-up rows ticked by swipe or tap; the completed swipe swallows the browser's
  synthetic follow-up click.
- PR detection and the celebration (XP, level up, rank up, new badges).
- Movement swap sheet (`doSwap`) — regenerates the prescription; honours
  `tl-swap-persist`.
- Movement detail sheet with a "proper form" YouTube search link.
- "Why this weight" explainer sheets — `decideLoad().why` is lifter-facing copy;
  show it.
- Screen wake lock while a session or run is active, re-acquired on visibility
  (iOS drops it).
- Session-specific dark mode; muscle map overlay with layout clearance
  (`mm3Cls`).
- Discard / finish / resume an open session.

### Readiness and safety gates

- Readiness check-in: sleep, soreness, energy, stress → score 0–100 → band
  (green / steady / amber / red). Not checked in shows a single quiet prompt,
  nothing more.
- Symptom logging per body region with severity; a symptom stays active for 10
  days.
- `autoRegPlan` → apply: levels 0–3. Level 1 trims a set on the primaries; 2 and
  3 pull the whole session back and cap RPE. Applying it to an already-open
  session trims **undone** working sets only, and **never below one working
  set**. Stamped into `state.autoreg` so progression knows the day was dosed.
- "Keep today as written" clears the dose.
- **Plan-drift banner** (`driftBanner`): warns when movements need equipment you
  no longer have, when movements are flagged for a listed injury, or when the
  program's day count or block length no longer matches settings.

### Plan

Week picker as one dash per week, coloured by the quality that week trains and
filled when complete. Block phase line. Movement search within the block. Week
calendar with lifts and runs. "What this week trains" explainer. Day open/close,
per-day editing, manage-schedule entry point.

### Progress

- **Rank** — XP, level, progress to next, rank, badges, strength-standard gate.
  Points come only from what is logged; nothing for opening the app.
- **Trends** — estimated 1RM from the top set each session; wellness sparkline.
- **Log** — every session and run.
- **History** — archived programs kept whole, sessions and runs still attached.
- Backup / restore of the whole dataset.
- Charts are inline SVG. No chart library.

### Mobility

Routine cards with duration and item list, "mark done" per day, day streak, hero
card with streak and total logged. Counts on rest days.

### Drag and swap

- **Drag a session onto another day** from the Today week strip
  (`index.html:8243`). Delegated from `document` because `render()` replaces the
  grid wholesale. An 8 px threshold arms the drag; a mostly-**vertical** first
  move is handed back to the page as a scroll; only a sideways drag is claimed.
  The dragged cell is **excluded from its own hit test** (it is translated under
  the cursor and would always win). Drop zone has a ±30 px vertical tolerance.
  On drop the follow-up click is swallowed for 350 ms. Landing on an occupied
  day **swaps** the two sessions rather than overwriting.
- **Manage-schedule sheet** — move a session to a day, reorder the sequence
  Trainlog works through (`moveDayOrder` — the lever for "I missed Monday, do
  that one next"), reset to the suggested schedule. Nothing logged is affected.

### Pull-to-refresh

On any `.scroll` container at `scrollTop === 0`. Indicator grows at half the pull
distance, capped at 64 px, label flips PULL → RELEASE past 46 px, fires `render()`
and a toast. `pointercancel` must tear the listeners down — a system gesture or
an incoming call means `pointerup` never arrives.

### Themes

App light/dark toggle, persisted to `tl-theme`, applied as `.theme-dark` on
`<html>`, syncing `<meta name="theme-color">` (`#10131a` / `#fbfdfc`) and the
button glyph (☀ / ☾). Separate session dark mode scoped to `.sess.dark`.

### 3D anatomy

In-session muscle map: default top-right, hideable, flippable to the left, both
persisted. Flat SVG map from `MUSCLE_DATA` (anterior + posterior polygons per
muscle slug). Optional 3D figure: loads `./muscles.glb` first, every time; a 404
is cached for the session so opening the map a dozen times does not fire a dozen
doomed requests (a network error stays retryable); otherwise a procedural
mannequin stands in, with the credit line switching to say so. Drag to rotate,
pinch to zoom.

**WebGL budget:** browsers cap live contexts at ~16. The current app keeps one
figure alive at a time. A React port that mounts a canvas per card will exhaust
the budget and blank out.

### GPS run tracking

`navigator.geolocation.watchPosition` with a **1-D Kalman filter** over position —
each fix is blended in proportion to its claimed accuracy, and the estimate's
uncertainty grows with time. Summing raw fix-to-fix hops both invents distance
while standing still and loses it while running, so this is not optional
polish. Haversine for distance, live pace, pause/resume, wake lock held and
re-acquired on visibility, cancel/finish writes a run record.

### Everything else

Toasts · sheet system (`ask`, `askConfirm`, `askBig`, `askLong`, `askBodyweight`)
· "why" explainer sheets · empty states that read as a state the product knew
about, not a failure to load · `resumeUI()` on `visibilitychange` and
`pageshow(persisted)` — a backgrounded page may come back with a discarded DOM
and stopped timers.

---

## 5 · Assets and dependencies

The current app has **no build step, no package dependencies, and no binary
assets in the repository.** Everything is inline and it is served statically.

### Runtime dependencies (all CDN)

| Dependency | Source | Used for | Required? |
|---|---|---|---|
| **Inter** 400–800 | `fonts.googleapis.com` / `fonts.gstatic.com` (preconnected) | the entire type system (`--font-body`, `--font-heading`) | Falls back to system UI. Load it — the design assumes it. |
| **Three.js 0.160.0** | `cdn.jsdelivr.net` via `<script type="importmap">` | the optional 3D figure | Only for the 3D view. |
| **GLTFLoader** | same importmap (`three/addons/`) | loading `muscles.glb` | Only if the model is present. |
| **Barlow Condensed** | **referenced, never loaded** | `--font-display` names it for headings and numerals | ⚠️ It silently falls back to Inter today. Either add the font link or drop it from the token deliberately. |

Nothing else is fetched. No analytics, no API, no backend.

### Assets

| Asset | State | Note |
|---|---|---|
| **`muscles.glb`** | ⚠️ **MISSING — not in the repository** | The anatomical scan is user-supplied and dropped in next to `index.html`. The app 404s gracefully and shows the procedural stand-in. **Lovable must obtain this file from the owner** before porting the 3D anatomy view, or ship the stand-in knowingly. |
| Design tokens | `index.html` lines 16–312 | "Nocturne" — OKLCH-derived colour ramps, type scale, spacing. **The source of truth for the look.** Port to Tailwind theme tokens; do not eyeball the colours. |
| Component CSS | `index.html` lines 320–2055 | ~1,735 lines. Rebuild in Tailwind/shadcn using the tokens above. |
| `MUSCLE_DATA` | `index.html:7596` | Anterior + posterior SVG polygons per muscle slug, from the MIT-licensed [body-highlighter](https://github.com/GV79/body-highlighter) (© 2020 GV79). **Keep the attribution.** |
| `GROUP_HUE` | `index.html` (3D script) | Nine muscle-group hues chosen so no two groups that touch on the body sit within 55° of each other. Do not re-pick casually. |
| `--muscle-lit: #d4453f` | token | Red is the anatomical convention and keeps the map distinct from the interactive accent. |
| Icons | 6 inline SVGs + text glyphs (☾ ☀ ?) | No icon font, no icon package. |
| Charts | inline SVG (`trendChart`, `wellSpark`, `emptyChart`) | No chart library. |
| Movement bank | `handoff/data/movements.json` | 248 records, plus 8 classification tables. Migrate unchanged. |
| PWA manifest / app icons / `sw.js` | **do not exist** | Only Apple meta tags are present. If the port should be installable, that is new work. |

### Lovable must obtain separately

1. **`muscles.glb`** — from the project owner. Nothing else can supply it.
2. **Barlow Condensed** — decide: load it, or remove it from the token.
3. **PWA icons and manifest** — if installability is wanted.

---

## 6 · Do NOT migrate

| What | Where | Why |
|---|---|---|
| **Preview seeder** | `index.html` lines 8352–8375 (last `<script>`) | If no plan exists it silently generates a program **and fabricates session history** — invented sets, weights and effort ratings — so the artifact preview has something to show. Fabricated training history in a real product is a safety problem, not a demo convenience. **Leave it behind entirely.** |
| Service-worker registration | lines 8336–8350 | Dead code — guarded by `if(false && …)`, and `sw.js` does not exist. |
| `inClaude` / `window.storage` | lines 2382, 2447, 2505, 2530 | A Claude-artifact storage bridge. Meaningless outside that host; adds a second, divergent persistence path. |
| Guided tour | `renderTour`, `startTour`, `tourSeen`, `tl-tour` | Disabled in this build — `load()` sets `ui.tour = null` unconditionally. Ship it deliberately or not at all. |
| `window` republishing | the integration shell tail | ~349 names re-exported onto `window` so inline `onclick=` handlers resolve. An artefact of the single-file shell; React uses imports and handlers. |
| `bindHost()` | `src/core/engine.js` header | A compatibility shim for the current shell's context fallbacks. **A port passes contexts explicitly and never calls it.** Keep the function (it is core, frozen); just do not use it. |
| Inline `onclick="fn()"` strings | throughout `index.html` | HTML-string rendering with global handlers. Rebuild as normal React event handlers. |
| `index.html` itself | — | Reference implementation and test oracle. Keep it in the repo and runnable; do not port it line by line. |

---

## 7 · CI — what needs to change later

**Not fixed here.** `.github/workflows/engine.yml` today:

```yaml
on:
  push:         { paths: ['handoff/**'] }
  pull_request: { paths: ['handoff/**'] }
steps:
  - actions/checkout@v4
  - actions/setup-node@v4 (node 22)
  - run: npm test            # working-directory: handoff
```

Four problems, all in the harness rather than the tests:

1. **Playwright is not installed and is not a declared dependency.**
   `handoff/package.json` has no `devDependencies` and there is no lockfile, so
   `systems-golden.test.js` fails with `ERR_MODULE_NOT_FOUND: playwright`.
   *Fix:* add Playwright as a devDependency (with a lockfile) and run
   `npx playwright install --with-deps chromium`.
2. **No static server, so the app is not reachable.** The replay drives a live
   `index.html`; without a server it fails with `ERR_CONNECTION_REFUSED` at
   `http://localhost:8831/index.html`.
   *Fix:* start `python3 -m http.server 8080` from the repo root before the test
   step and pass `APP_URL=http://localhost:8080/index.html`. Note the harness
   default port is **8831**, not 8080.
3. **`working-directory: handoff` cannot reach the app.** The server must be
   started from the repository root — `index.html` imports `src/core/`, so the
   whole tree has to be served.
4. **The trigger misses the core.** `paths: ['handoff/**']` means a change to
   `src/core/**` or `index.html` runs **nothing** — precisely the changes the
   3,006-case fixture exists to catch.
   *Fix:* add `src/core/**` and `index.html` to both path filters.

Consequence today: the workflow is red for any `handoff/**` change (4 of 21 tests
fail on the runner) and silent for every core change. Both suites pass locally
with the prerequisites in place, so this is packaging, not a test defect.

Recommended split once the port begins: one job for the pure-Node suites
(`trainlog-core.test.js`, `engine-golden.test.js` — 17 tests, no browser) that
gates every PR, and one browser job for `systems-golden.test.js`.

---

## 8 · Migration checklist

Work in this order. Each step is verifiable before the next begins.

- [ ] **1.** Copy `src/core/` and `handoff/` into the new project **unchanged**.
      Verify: `node --test handoff/trainlog-core.test.js handoff/engine-golden.test.js` → 17 pass.
- [ ] **2.** Fix CI per §7. Get the pure-Node suites gating PRs before writing UI.
- [ ] **3.** Port the design tokens (`index.html` 16–312) into the Tailwind theme.
      Decide the Barlow Condensed question.
- [ ] **4.** Build the store and persistence layer (§3), including the one-time
      localStorage import, `savedAt` cross-tab rule, synchronous save on hide,
      and the three load-time migrations.
- [ ] **5.** Port `applyProgram` + the Build wizard. `composeProgram(seed, ctx)`
      is the first real core call — it proves the context wiring end to end.
- [ ] **6.** Today + session logging. Wire `judgeSession` / `decideLoad` /
      `decideReps` per §2, with `vetLoad` / `vetHold` / `vetPct` / `vetHistory`
      on everything shown.
- [ ] **7.** Readiness, symptoms, autoregulation and the plan-drift banner.
- [ ] **8.** Plan, Progress, Mobility.
- [ ] **9.** Interaction layer: drag-to-move, swipe-to-tick, pull-to-refresh,
      themes, wake lock, resume-on-visible.
- [ ] **10.** Extras: 3D anatomy (needs `muscles.glb` — §5), GPS tracking.
- [ ] **11.** Re-point `systems-golden.test.js` at the ported call sites —
      deliberately, and only after it passes against the original `index.html`.
- [ ] **12.** Supabase, as separate work, after the port is stable. Keep the open
      session device-local.

Throughout: **never regenerate a fixture to make a test pass.** A divergence
means the port is wrong.

---

## Outstanding items — and why none of them block

| Item | Severity | Why it is not a blocker |
|---|---|---|
| Progression layer still in `index.html` | Medium | Every rule already exists, verified, in `handoff/trainlog-core.js`. §2 maps each function. It is a porting task with a known target, not missing work. |
| `muscles.glb` missing | Low | The app degrades to the procedural figure by design. Blocks only the 3D anatomy view, which is step 10. |
| CI cannot run the browser suite | Medium | Both suites pass locally and 17 of 21 tests need no browser. §7 gives the fix. It slows verification; it does not block starting. |
| Barlow Condensed referenced, not loaded | Cosmetic | Falls back to Inter today. |
| No PWA manifest / icons / `sw.js` | Low | Not present in the current app either; new work if wanted. |

Nothing in this list prevents Lovable from beginning the UI rebuild. The core is
frozen, green, importable, and documented; the boundary is explicit; the
fixtures will catch a wrong port immediately.

---

# READY FOR LOVABLE
