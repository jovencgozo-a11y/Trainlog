# Trainlog → Lovable handoff

Read this first, then `MIGRATION.md` (the full technical spec) and
`src/core/README.md` (import boundaries).

**The one sentence that matters:** the UI is yours to rebuild; the training
logic is not yours to rewrite. Two packages of verified logic already exist —
import them and call them.

---

## 1 · What the application does

Trainlog is an offline-first strength-and-running log and program generator. A
lifter answers a short setup (experience, goals, days per week, equipment,
injuries, block length), and the app composes a whole training block: the split,
the movement for every slot, per-week set/rep/percentage targets, deload
placement, and the weekday schedule that carries it.

From then on it is a session app. You open the day, log sets, optionally tap how
each movement felt, and the next prescription is computed from what you actually
did — not from a fixed spreadsheet. A daily readiness check-in can lighten or
shorten the session. Running plans, mobility/PT routines, estimated 1RMs,
strength standards, XP/level/rank and badges sit alongside.

Everything runs client-side. No account, no backend, no telemetry.

The loading rules come from NSCA/CSCS programming references, and the
progression rules carry eight audited bug fixes. **They are the product.** A
wrong constant here does not throw — it prescribes a weight the lifter has not
earned, and the symptom appears weeks later as a stall or an injury.

---

## 2 · Architecture

```
index.html          the entire UI + the progression layer  (8,377 lines)
  └─ imports ──▶ src/core/                the four systems, DOM-free, verified
handoff/
  ├─ trainlog-core.js                     the progression decision core, DOM-free, verified
  ├─ systems-golden.json   3,006 cases    pins src/core/
  ├─ engine-golden.json   27,898 cases    pins trainlog-core.js
  └─ data/                                movements + classification tables as JSON
```

Dependency runs one way: `index.html → src/core/`. The core never imports the
shell, never touches `window`, `document`, storage, timers or the network.

There are **two** verified logic packages with different scopes, and this trips
people up:

| Package | Scope | Pinned by |
|---|---|---|
| `src/core/` (221 exports) | readiness, scoring, scheduling, program **generation** | `systems-golden.json`, 3,006 cases |
| `handoff/trainlog-core.js` (24 exports) | session-to-session **progression** + a safety envelope | `engine-golden.json`, 27,898 cases + 14,232 fuzz probes |

`src/core/` decides *what the block looks like*. `trainlog-core.js` decides
*what weight goes on the bar next time*. You need both.

---

## 3 · The four core systems

Full function tables, context shapes and constraints are in `MIGRATION.md` §2.
Summary:

- **readiness** (`src/core/readiness.js`, 24 exports) — a daily self-report plus
  active symptoms become a dose: train as written, trim a set, pull the session
  back, or make it a technique day.
- **scoring** (`src/core/scoring.js`, 54 exports) — aggregates the current block
  and every archived one into XP, level, rank, badges and the strength-standard
  gate. 1RM estimate is Epley, capped at ten reps by design.
- **scheduling** (`src/core/scheduling.js`, 38 exports) — places lifts and runs
  on weekdays (Monday = 0), keeps hard running off leg days and off the day
  before one, and provides the week view.
- **programGeneration** (`src/core/programGeneration.js`, 161 exports) —
  composes the block: split, movement selection, per-week targets, volume
  governance, and the schedule.

`engine.js` is the only real module; the four above re-export from it. Its
declaration order is load-bearing (`const` cross-references — reordering
reintroduces a temporal dead zone). Import whichever module is narrower for your
use.

---

## 4 · Public functions to call

### Program generation — the main entry point

```js
import { composeProgram } from './core/programGeneration.js';
const result = composeProgram(seed, setupCtx);
```

Same seed + same context ⇒ byte-identical program. It writes nothing; the
caller stores the returned object. See §5–§6 below for shapes.

### Readiness

`readinessScore(r)` · `readinessBand(score)` · `todayReadiness(ctx)` ·
`activeSymptoms(ctx)` · `autoReg(ctx)` · `autoRegPlan(ctx)` · `autoRegActive(ctx)`

### Scoring

`allHistory(ctx)` · `scoreState(ctx)` · `weekStats(week)` · `consistency(ctx)` ·
`bestOfAll(name, ctx)` · `maxOf(name, ctx)` · `gateLifts(ctx)` · `gateCheck(ctx)`

### Scheduling

`buildSchedule(liftNames, nRun, goalKey, startDow, chosenDows)` ·
`weekRows(week, ctx)` · `schedNow(ctx)` · `trainDows(ctx)` · `suggestDayId(ctx)` ·
`nextTrainDows(cur, d)` · `runSession(type, week, goal)`

### Progression — from `handoff/trainlog-core.js`

```js
import { judgeSession, decideLoad, decideReps, loadStep, speedCap,
         vetLoad, vetHold, vetPct, vetHistory } from './trainlog-core.js';
```

- `judgeSession({sets, targetReps, …})` → `{hit, eff, …}` — was the session hit,
  and how did it feel (silence is read conservatively, never as "solid").
- `decideLoad(history, opts)` → `{w, action:'progress'|'hold'|'deload', why}`
- `decideReps(history, opts)` → the bodyweight/hold equivalent, with a rep
  ceiling and a movement level-up instead of endless reps.
- `vetLoad` / `vetHold` / `vetPct` / `vetHistory` — the **safety envelope**.
  Call these on anything you are about to show a lifter. They reject runaway
  jumps, progression off a failed session, non-finite loads, percentages outside
  the prescribable band, holds outside 20–120 s, and inflated 1RM estimates.
  Keep them wired in; they are the last line of defence in a rebuilt UI.

---

## 5 · Required context shapes

Every core function takes its inputs through an explicit context object. Pass one
and no host binding is needed. (`bindHost()` exists only for the current
`index.html` shell — a port should never call it.)

| System | Context |
|---|---|
| readiness | `{ readiness, symptoms, plan, dayId, autoreg, today }` |
| scoring | `{ sessions, runs, archive, plan, sex, bw, liftDays, today }` |
| scheduling | `{ startDate, trainDows, liftDays, sched, plan, sessions, today }` |
| programGeneration | the setup object below |

**Setup / `composeProgram` context:**

```
exp, goal, goals, liftDays, runDays, runGoal, runPace, runExp,
equip, kit, injuries, weeks, startDate, splitStyle, focus,
emphasis, priorities, trainDows, sessionMax
```

`ctx` wins over any global — day count, block length, goal, experience and
injuries all follow the context. That is verified against deliberately
conflicting globals.

**Progression history** (what you assemble and hand to `decideLoad`), newest
first: `[{ date, week, w, r, targetR, hit, eff, assumed, dosed }]`.
`assumed` means nobody tapped how it felt; `dosed` means readiness lightened
that day. Both change the decision — carry them.

---

## 6 · Expected outputs

`composeProgram(seed, ctx)` returns a plain object:

```js
{ seed, plan, dayId, adaptations, setup, weeks, weekNames,
  runVisible, runGoal, runPace, runExp, sched, week, startDate }
```

- `plan[]` — `{ id, name, exercises[], dayIdx, stages[] }`
- `plan[].exercises[]` — `{ name, targets[], note, goal, slot }`, one `targets`
  entry per week, e.g. `"4×8–10 · 72.5% 1RM ≈ 127.5 lb · RPE 8 · heavy day"`
- `sched` — `{ liftDows[], lifts{dow:{name,lower}}, runs{dow:type}, goal, nLift, startDow, custom }`

`scoreState(ctx)` → `{ xp, lvl, into, need, rank, rankIdx, next, gate, stats, badges[] }`
`autoReg(ctx)` → `{ level 0–3, score, band, flags[], cluster, head, body }`
`decideLoad(...)` → `{ w, action, why }` — `why` is lifter-facing copy; show it.

---

## 7 · UI versus core

**Core — import, never reimplement:** everything in §3–§4. Loading percentages,
rep schemes, deload placement, hold durations, movement selection, volume
governance, readiness dosing, XP/rank maths, schedule placement, progression
decisions, the safety envelope.

**UI — rebuild freely:** rendering, routing, the five tabs, the session screen,
sheets and dialogs, the muscle map and 3D figure, drag-to-move scheduling,
theming, toasts, timers, GPS tracking, persistence, and `applyProgram()` (the
function that writes a composed program into the store — that write is the
shell's job, not the engine's).

> ### ⚠ The progression layer is not yet in `src/core/`
>
> `earnedThreshold`, `targetRepsAt`, `progHistory`, `loadRec`, `repCeiling`,
> `repRec`, `nextVariation`, `progLoadSeed`, `progRepSeed` still live in
> `index.html` (lines 6841–7100), and `bestOf` at line 2643. They are **business
> logic in the file you are replacing** — the highest-risk part of this
> migration.
>
> Do not re-derive their rules. They are thin wrappers that assemble history from
> stored sessions and then defer to `handoff/trainlog-core.js`:
>
> | `index.html` | call instead |
> |---|---|
> | `progHistory(name, limit)` | build the history array yourself from stored sessions (shape in §5) |
> | `loadRec(name)` | `decideLoad(history, {isLower})` |
> | rep/bodyweight progression | `decideReps(history, {ceiling, baseReps, prevRung})` |
> | hit/effort judgement | `judgeSession({sets, targetReps})` |
> | `earnedThreshold`, `loadStep`, `speedCap` | exported from `trainlog-core.js` |
>
> Rebuild only the history assembly and the plan lookups. Every threshold,
> filter and branch comes from the imported module.

---

## 8 · UI behaviour that must be preserved

These exist only in `index.html` and have to be recreated. Several are audited
fixes, not decoration — the notes say why.

**Session screen**
- Set logging with per-set weight/reps, plus an optional effort tap
  (easy / solid / hard / grind). Silence must stay meaningful: an untapped
  session progresses more cautiously, it does not count as "solid".
- Rest timer with vibration on completion; it must resume from *real time* after
  the app is backgrounded, not from where it was suspended.
- Warm-up rows, ticked off by swipe or tap. The completed swipe swallows the
  browser's synthetic follow-up click.
- PR detection and the celebration (XP gained, level up, rank up, new badges).
- A separate session dark mode, independent of the app theme.
- Screen wake lock while a session or run is active; re-acquired when the tab
  becomes visible again (iOS drops it).
- In-session muscle map: top-right by default, hideable, flippable to the left.

**Today / scheduling**
- Drag a session from the Today week strip onto another day. A mostly-vertical
  first move is handed back to the page as a scroll; only a sideways drag is
  claimed as a move. The dragged cell is excluded from its own hit test, and the
  drag swallows the follow-up click.
- Manage-schedule sheet, day reorder, reset schedule.
- `suggestDayId` is sequence-based: a missed day is picked up next, not skipped.

**Program building**
- Multi-step setup wizard: experience, goals, sport, days, equipment preset and
  kit toggles, injuries, block length, start date, session length cap.
- Custom program builder (add/rename/delete days and exercises, periodisation
  toggle).
- Movement swap, with an option to persist the swap across the block.
- Movement detail sheet with a "proper form" YouTube search link.

**Progress**
- XP / level / rank / badges, strength-standard gate, trend charts, wellness
  sparkline, consistency, week detail. Charts are inline SVG, no chart library.

**App-wide**
- Light/dark theme toggle, syncing `<meta name="theme-color">`.
- Pull-to-refresh on scroll containers.
- Toasts; `ask` / `askConfirm` / `askBig` / `askLong` sheets; "why" explainer
  sheets for prescriptions.
- Backup / restore of the whole dataset.
- Mobility & PT routines with a streak.

**Correctness behaviours — do not drop these**
- **Synchronous save on hide.** `visibilitychange`, `pagehide`, `beforeunload`,
  `freeze` and `blur` all write immediately, with no `await`. An async save from
  `pagehide` resolves in a microtask the OS is free to discard — that is how an
  in-progress workout was lost.
- **Cross-tab reconciliation.** Every write stamps `state.savedAt`. The `storage`
  listener only ever moves forward: an incoming copy with an older or missing
  stamp is rejected and the newer one written back. Mid-session it never adopts
  anything — it warns and keeps the screen.
- **Storage-unavailable detection.** A probe write on boot sets `canPersist`; a
  failed save surfaces a visible warning. A silent write failure is the worst
  thing this app can do.
- **Data migrations on load:** `normalizeData()` (shape + clamping),
  `repairPlanNames()` (heals free-text swaps from older versions),
  `migrateProgramming()` (brings stored prescriptions up to the current engine).
  Port these or write an equivalent migration on the new schema.

**Do not port**
- The last `<script>` block (~lines 8352–8375) is a **preview seeder**: if no
  plan exists it silently generates a program and fabricates session history so
  the artifact preview has something to show. Fabricated training history in a
  real product is a safety problem. Leave it behind.
- The service-worker block above it is dead code (`if(false && …)`) and `sw.js`
  does not exist.
- `inClaude` / `window.storage` is a Claude-artifact storage bridge with no
  meaning outside that host.
- The guided tour is disabled in this build (`ui.tour = null` on load).

---

## 9 · State and persistence

Four groups (full key lists in `MIGRATION.md` §5):

1. **UI state** — ephemeral, never persisted, safe to redesign.
2. **Setup / context** — the input to program generation.
3. **Generated program** — the output of `composeProgram`, written by `applyProgram`.
4. **User / session data** — `sessions, runs, readiness, symptoms, archive,
   savedPrograms, mobility, ptRoutines, bw, sex, progAck, openSession`. This is
   what a backend must own.

A session record: `{ id, date, week, dayId, dayName, entries, volume, minutes, efforts, autoreg }`,
where `entries` is `{ movementName: [{w, r}] }`.

### Everything currently in localStorage

| Key | Holds | Migrate to |
|---|---|---|
| `trainlog-data-v3` | the entire `state` blob — program, sessions, runs, readiness, symptoms, archive, saved programs, mobility, body stats | server (or a local DB) once accounts exist |
| `trainlog-data-v3-session` | the open, in-progress session, written on every set | **keep device-local** — two devices must not claim one day |
| `tl-theme` | `dark` / `light` | per-device preference |
| `tl-sess-dark` | session-screen dark mode | per-device preference |
| `tl-mm3-show` | muscle map shown | per-device preference |
| `tl-mm3-side` | muscle map `left` / `right` | per-device preference |
| `tl-swap-persist` | keep a movement swap for the block | per-device preference |
| `tl-tour` | walkthrough seen | per-device preference |

Every read and write is wrapped in `try/catch` and falls back to a default —
private mode and blocked site data must not break the app. Preserve that.

**Migration path.** Read the old keys once on first run and import them, so an
existing user does not lose their log. `trainlog-data-v3` is a single JSON blob;
`MIGRATION.md` §5 gives the schema.

---

## 10 · Supabase

**Not applicable today.** There is no backend, no account, no network call. Do
not add Supabase as part of the UI rebuild — land the port first, then wire the
backend as separate work.

When it is time, this is the shape:

- **Owned by the server:** the user/session data in group 4 above — sessions,
  runs, readiness, symptoms, archive, saved programs, mobility/PT, body stats.
  Row-level security per user.
- **Owned by the server, low churn:** setup and the generated program.
- **Stays device-local:** the open session (`trainlog-data-v3-session`) and the
  six UI preferences. Syncing the open session invites two devices claiming one
  day, which corrupts progression history.
- **Never on the server:** nothing needs to be. The core is pure — no function in
  `src/core/` or `trainlog-core.js` needs a network round trip. Program
  generation can stay entirely on the client.
- Keep offline-first. The app must work with no connection; sync is an
  enhancement, not a dependency.

---

## 11 · The 3,006-case golden master

`handoff/systems-golden.json` holds 3,006 input→output pairs recorded from the
app **before** any refactoring: scheduling 272, readiness 2,650, scoring 46,
program generation 38. `handoff/systems-golden.test.js` replays them against a
live app in headless Chromium and asserts every output still matches exactly.

A second fixture, `handoff/engine-golden.json`, holds 27,898 pairs pinning
`trainlog-core.js`.

This is what makes the migration low-risk: if you port a call site wrongly —
pass the context in the wrong shape, drop a field, reorder an argument — the
replay tells you immediately, with the exact case. Wire both into CI before you
write a line of UI.

> ### Never regenerate a fixture to make a test pass
>
> The fixture is the definition of correct behaviour, recorded before the
> refactor. If a replay diverges, **the port is wrong** — find the cause and fix
> the port. Editing `systems-golden.json` or `engine-golden.json` to agree with
> new output destroys the only evidence that behaviour was preserved, and the
> failure it hides is a wrong weight on a bar.
>
> An *intentional* behaviour change is allowed, but it must be named, separately
> tested, and recorded as a new fixture **alongside** the old one — never in
> place of it.

---

## 12 · Do not rewrite the core

Stated plainly, because prompts drift:

1. Do not rewrite, "clean up", "modernise", TypeScript-ify or reformat
   `src/core/*.js` or `handoff/trainlog-core.js`. Import them as they are. If you
   need types, write a `.d.ts` alongside — do not touch the implementation.
2. Do not reorder declarations in `src/core/engine.js`. The order is load-bearing.
3. Do not reimplement a training rule you can import. If a prompt is about
   loading, reps, deloads, progression, readiness dosing or scheduling, it should
   name the module and say *call it, do not reimplement it*.
4. Do not tune a constant because a number "looks wrong". Every one of them is
   either an NSCA/CSCS parameter or an audited fix.
5. Do not drop the safety envelope (`vetLoad`, `vetHold`, `vetPct`,
   `vetHistory`). It is what stops a UI bug from becoming an injury.
6. Do not regenerate either golden fixture.

---

## 13 · File disposition

### Migrate unchanged — copy in, do not edit

```
src/core/engine.js                 the four systems (single source, 221 exports)
src/core/readiness.js              re-export view
src/core/scoring.js                re-export view
src/core/scheduling.js             re-export view
src/core/programGeneration.js      re-export view
handoff/trainlog-core.js           progression decision core + safety envelope
handoff/data/*.json                248 movements + classification tables
                                   (goalModels, groups, kit, movements, presets,
                                    runGoals, runSessions, sports, standards)
```

### Migrate unchanged — tests and fixtures, wire into CI

```
handoff/systems-golden.json        3,006 cases   ← never regenerate
handoff/engine-golden.json        27,898 cases   ← never regenerate
handoff/systems-golden.test.js     replay harness (drives a served app)
handoff/engine-golden.test.js      replay harness
handoff/trainlog-core.test.js      14 characterization tests
handoff/package.json               `npm test`
```

`systems-golden.test.js` currently drives the live `index.html` through
Playwright. Keep `index.html` around and runnable until the port is finished —
it is the reference oracle. Re-pointing the harness at the ported call sites is
a task in its own right; do it deliberately, and only after the fixture passes
against the original.

### Rebuild — this is the actual work

```
index.html   → React + TypeScript + Tailwind + shadcn/ui
```

Everything in §8, in this order of dependency: shell/routing → store and
persistence → Today → session screen → Build wizard → Plan → Progress →
Mobility → the extras (3D figure, GPS tracking).

### Do not modify

```
src/core/**            business logic, pinned by 3,006 cases
handoff/trainlog-core.js   business logic, pinned by 27,898 cases + fuzzing
handoff/*-golden.json      the evidence that behaviour was preserved
MIGRATION.md               the spec this handoff summarises
```

### Reference only — read, do not port

```
index.html      the reference implementation and the test oracle
README.md       original single-file app notes
```

---

## 14 · Dependencies and setup

The current app has **no build step and no package dependencies**. It is served
statically.

**To run it:**

```bash
python3 -m http.server 8080     # then http://localhost:8080/index.html
```

**`file://` no longer works.** `index.html` is an ES module (it imports
`src/core/engine.js`), and the browser blocks module loading over `file://`. It
must be served over HTTP.

**To run the tests:**

```bash
npm install --no-save playwright   # NOT a declared dependency — install it
python3 -m http.server 8080 &      # the systems replay needs the app served
cd handoff && npm test             # 21 tests
APP_URL=http://localhost:8080/index.html node --test systems-golden.test.js
```

Node 22. Chromium is required for the replays.

**Runtime dependencies of the current app** (all CDN, all optional to keep):

| What | Where from | Notes |
|---|---|---|
| Inter (400–800) | `fonts.googleapis.com` | falls back to system UI font |
| Barlow Condensed | **referenced but never loaded** | `--font-display` names it; it silently falls back to Inter. Load it or drop it deliberately. |
| three.js 0.160.0 | `cdn.jsdelivr.net` importmap | only for the optional 3D figure |
| GLTFLoader | same importmap | only if `muscles.glb` is present |

Nothing else is fetched. No analytics, no API.

---

## 15 · Assets, styles and UI resources

**There are no binary assets in the repository.** Everything is inline.

| Resource | Where | Note |
|---|---|---|
| Design tokens | `index.html` lines 16–312 | "Nocturne" token set — OKLCH-derived colour ramps, type scale, spacing. **The source of truth for the look.** Port these to Tailwind theme tokens rather than eyeballing colours. |
| Component CSS | `index.html` lines 320–2055 | ~1,700 lines. Rebuild with Tailwind/shadcn, but take the token values from above. |
| Muscle-map geometry | `index.html` ~line 7595 | `MUSCLE_DATA` — anterior/posterior SVG polygons per muscle slug, from the MIT-licensed [body-highlighter](https://github.com/GV79/body-highlighter) project (© 2020 GV79). **Keep the attribution.** |
| Muscle group palette | `index.html` (`GROUP_HUE`) | Nine hues chosen so no two muscle groups that touch on the body sit within 55° of each other. Do not re-pick these casually. |
| Highlight colour | `--muscle-lit: #d4453f` | Red is the anatomical convention and keeps the body map distinct from the interactive accent. |
| Icons | 6 inline SVGs + text glyphs (`☾`, `☀`, `?`) | No icon font, no icon package. |
| Charts | inline SVG (`trendChart`, `wellSpark`) | No chart library. |
| 3D figure | `index.html` script block from line 7587 | CSS-3D fallback figure, built in code. Loads `./muscles.glb` first if present. |
| **`muscles.glb`** | **not in the repository** | The anatomical scan is user-supplied and gitignored-by-absence. The app 404s gracefully once per session and shows the stand-in figure with a "add muscles.glb for the anatomical model" credit line. **Get this file from the owner before porting the 3D view.** |
| PWA manifest / icons / `sw.js` | **do not exist** | The service-worker registration is dead code. If the port should be installable, that is new work. |

WebGL note: browsers cap live contexts at roughly 16. The current app is careful
to keep one figure alive at a time — a React port that mounts a canvas per card
will exhaust the budget and blank out.

---

## 16 · Recommended order

1. Copy `src/core/` and `handoff/` into the new project unchanged. Get
   `npm test` green in CI before writing UI.
2. Build the store and persistence layer (§9), including the localStorage
   import path for existing users.
3. Port `applyProgram` and the Build wizard — `composeProgram` is the first real
   core call and proves the context wiring.
4. Today + session logging, calling `judgeSession` / `decideLoad` / `decideReps`
   with the safety envelope wired in.
5. Plan, Progress, Mobility.
6. The extras: 3D figure, GPS tracking, drag-to-move, pull-to-refresh.
7. Re-point `systems-golden.test.js` at the ported call sites — deliberately,
   and only once it passes against the original.
8. Supabase, as separate work, after the port is stable.
