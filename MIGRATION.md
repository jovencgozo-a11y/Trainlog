# Trainlog — migration handoff specification

For a team porting this app to another stack (Lovable: React + TypeScript +
Tailwind + shadcn/ui + Supabase). It describes what exists, what must not change,
and how to prove nothing did.

The short version: **the UI is yours to rebuild; the engine is not yours to
rewrite.** `src/core/` is already framework-free, DOM-free and importable. Import
it, call it, and keep the regression suites green.

---

## 1 · Core modules

```
src/core/engine.js             221 exports — every declaration the four systems reach
src/core/readiness.js           24 exports — re-exported from engine.js
src/core/scoring.js             54 exports
src/core/scheduling.js          38 exports
src/core/programGeneration.js  161 exports
```

`engine.js` is the single source. The four system modules re-export from it
rather than redeclaring anything: several declarations are `const` and the file
order they had in the original single-file app is load-bearing, so splitting them
into separate physical modules would create a temporal-dead-zone that did not
exist before. Import whichever module names the system you need; they resolve to
the same functions.

### The context convention

Every system takes its inputs through an explicit context object. Omit it and the
function falls back to host objects bound by `bindHost()` — which is how the
existing app's call sites work unchanged. **Pass a context and no host is
needed**; that is the path a new front end should use.

```js
import { bindHost } from './core/engine.js';
bindHost({ get state(){ return store.state }, get setup(){ return store.setup },
           get ui(){ return store.ui } });      // optional; only for fallbacks
```

---

## 2 · The four systems

### readiness — `src/core/readiness.js`

Turns a daily self-report and any active symptoms into a dose for today's
session: whether to train as written, trim a set, pull the load back, or make it
a technique day.

| Function | Input | Returns |
|---|---|---|
| `readinessScore(r)` | `{sleep,sore,energy,stress}` 1–5 each | `0–100` snapped to 5, or `null` |
| `readinessBand(score)` | number or null | `{key:'green'\|'steady'\|'amber'\|'red', label, col}` |
| `todayReadiness(ctx)` | ctx | today's entry or `null` |
| `activeSymptoms(ctx)` | ctx | latest entry per region inside a 10-day window, severity ≥ 1 |
| `autoReg(ctx)` | ctx | `{level 0–3, score, band, flags[], cluster, head, body}` |
| `autoRegPlan(ctx)` | ctx | `{level, moves[], setDrop, rpeCap}` or `null` |
| `autoRegActive(ctx)` / `autoRegDelta(ex)` | ctx / exercise | today's applied dose · set delta |
| `todaysDay`, `dayGroups`, `dayLoadsLower`, `inLowerCluster`, `sevBand` | — | supporting reads |

**Context** `{ readiness, symptoms, plan, dayId, autoreg, today }`

**Constraints** Level 1 trims a set on the primaries; 2 and 3 pull the whole
session back and cap RPE. The Tue–Thu lower-limb window escalates a sub-par read,
it never creates one. Symptoms below severity 4 do not drive the session.

### scoring — `src/core/scoring.js`

Aggregates history across the current block and every archived one, and derives
XP, level, rank and the strength-standard gate.

| Function | Input | Returns |
|---|---|---|
| `allHistory(ctx)` | ctx | `{sessions, runs, …}` — archive + current, sorted, incomplete filtered out |
| `scoreState(ctx)` | ctx | `{xp, lvl, into, need, rank, rankIdx, next, gate, stats, badges[]}` |
| `weekStats(week)` | week number | `{planned, done}` |
| `consistency(ctx)` | ctx | `{lift:{iso:true}, run:{iso:true}}` |
| `bestOfAll(name, ctx)` / `maxOf(name, ctx)` | movement, ctx | estimated 1RM (Epley, capped at 10 reps) |
| `gateLifts(ctx)` / `gateCheck(ctx)` | ctx | lifts with published standards · `{known, why, tier, lifts}` |

**Context** `{ sessions, runs, archive, plan, sex, bw, liftDays, today }`

**Constraints** The 1RM estimate is capped at ten reps by design — a high-rep set
can confirm a max, never inflate one. `weekStats` reads the schedule, so
scheduling must be available.

### scheduling — `src/core/scheduling.js`

Places lifts and runs on weekdays and provides the week view over that placement.

| Function | Input | Returns |
|---|---|---|
| `buildSchedule(liftNames, nRun, goalKey, startDow, chosenDows)` | explicit args | `{liftDows[], lifts{dow:{name,lower}}, runs{dow:type}, goal, nLift, startDow, custom}` |
| `weekRows(week, ctx)` | week, ctx | 7 rows `{i, d, label, lift, run}` |
| `schedNow(ctx)` | ctx | the stored schedule, or one derived from the plan |
| `trainDows(ctx)` / `defaultDows(n)` / `startDow(ctx)` / `dowOf(iso)` | — | weekday helpers, Monday = 0 |
| `suggestDayId(ctx)` | ctx | next session id — sequence-based, so a missed day is picked up, not skipped |
| `nextTrainDows(cur, d)` | current days, day | `{days[], refused}` — at least one, at most six |
| `scheduleNote(ctx)` / `isLowerDay(name)` / `runSession(type, week, goal)` | — | supporting reads |

**Context** `{ startDate, trainDows, liftDays, sched, plan, sessions, today }`

**Constraints** `buildSchedule` keeps hard running off leg days and off the day
before one, and puts the long run at the weekend. Weekday index is 0 = Monday.

### programGeneration — `src/core/programGeneration.js`

Composes a whole training block: split, movement selection, per-week targets,
volume governance and the schedule that carries it.

Principal export is `composeProgram` (§3). Also exported and useful on their own:
`genTargets`, `holdSecs`, `loadPct`, `phaseOf`, `blockIndex`, `primaryGoal`,
`styleFor`, `buildDay`, `pickForSlot`, `buildStagesFor`, `governVolume`,
`dayNames`, `splitFor`, `dayMinutes`, `weekCount`.

**Context** the setup object (§5).

**Constraints** Deload placement, the NSCA-derived loading bands, the Epley cap,
per-pattern hold durations and the volume governor are all covered by the golden
master. Do not tune them.

---

## 3 · `composeProgram(seed, ctx)`

The whole contract of program generation.

```js
import { composeProgram } from './core/programGeneration.js';
const result = composeProgram(4242, setupContext);
```

**Inputs**

- `seed` — integer. The draw. Same seed + same context ⇒ byte-identical program.
- `ctx` — the setup object: `exp, goal, goals, liftDays, runDays, runGoal, equip,
  kit, injuries, weeks, startDate, splitStyle, focus, emphasis, priorities,
  trainDows, runPace, runExp, sessionMax`.

**Returns** a plain object, written nowhere:

```js
{ seed, plan, dayId, adaptations, setup, weeks, weekNames,
  runVisible, runGoal, runPace, runExp, sched, week, startDate }
```

- `plan[]` — `{ id, name, exercises[], dayIdx, stages[] }`
- `plan[].exercises[]` — `{ name, targets[], note, goal, slot }`, one `targets`
  entry per week, e.g. `"4×8–10 · 72.5% 1RM ≈ 127.5 lb · RPE 8 · heavy day"`
- `sched` — as `buildSchedule` returns

**Guarantees, all under test**

- Pure with respect to the app: reads no global `state`/`ui`, mutates neither.
- Deterministic: same seed + context ⇒ identical plan and targets.
- `ctx` wins over any global: day count, block length, goal, experience and
  injuries all follow the context, verified against deliberately conflicting
  globals.

**Writing it into an app** is the shell's job, not the engine's:

```js
applyProgram(composeProgram(seed, ctx));   // applyProgram owns all state writes
```

---

## 4 · Integration layer — `index.html`

8,377 lines, all UI. It is the reference implementation and the thing being
replaced; it is not a dependency of the core.

**Belongs to the UI (rebuild freely)** — rendering and the `render()` cycle, the
five tabs, the session screen and set logging, sheets and dialogs, the muscle map
and 3D figure, drag-to-move scheduling, theming, toasts, timers, localStorage
persistence, and `applyProgram()`.

**Belongs to the core (import, do not reimplement)** — everything in §2 and §3.

The shell imports the engine, optionally binds live `state`/`setup`/`ui` for the
context fallbacks, and republishes names its inline handlers use. A React port
replaces all of that with ordinary imports and a store.

---

## 5 · State

**Application / UI state** — ephemeral, never persisted, safe to redesign:
`tab, dayId, dayPicked, sess, tour, editPlan, logTab, swap, entered, w, r, pr,
bodyKey, bodyOff, swapPersist, mm3show, mm3side`.

**Setup / context** — the input to program generation, and what `ctx` is:
`exp, goal, goals, liftDays, runDays, runGoal, runPace, runExp, equip, kit,
injuries, weeks, startDate, splitStyle, focus, emphasis, priorities, trainDows,
sessionMax`.

**Generated program** — produced by `composeProgram`, written by `applyProgram`:
`plan, seed, weeks, weekNames, sched, adaptations, setup, startDate, week,
runVisible, runGoal, runPace, runExp`.

**User / session data** — what a backend must own:
`sessions, runs, readiness, symptoms, archive, savedPrograms, mobility,
ptRoutines, bw, sex, progAck, openSession`.

A session record: `{ id, date, week, dayId, dayName, entries, volume, minutes,
efforts, autoreg }`, where `entries` is `{ movementName: [{w, r}] }` and
`autoreg` records that readiness lightened that day.

Today everything lives under the `trainlog-data-v3` localStorage key, with the
open session under `trainlog-data-v3-session` and three small UI preferences
under `tl-swap-persist`, `tl-mm3-show`, `tl-mm3-side`.

---

## 6 · Regression protection

Three layers. All must stay green through a migration.

**Golden master — 3,006 cases** (`handoff/systems-golden.json`)
Recorded from the app *before* any of the extraction work: scheduling 272,
readiness 2,650, scoring 46, program generation 38. Replayed by
`handoff/systems-golden.test.js` against a live app.

**Handoff suite — 21 tests** (`handoff/`)
14 characterization tests over the decision core, plus a second golden master of
27,898 recorded input/output pairs (`engine-golden.json`) and the safety-envelope
tests.

**App regression** — headless-browser checks: the progression ladder, five tabs in
both themes, drag-to-move scheduling with swap and persistence, the plank-swap
prescription, and the injury A/B and conflicting-global tests.

```bash
npm install --no-save playwright                  # the replay drives the live app
python3 -m http.server 8080 &                     # the app must be served
cd handoff && npm test                            # 21 tests
APP_URL=http://localhost:8080/index.html \
  node --test systems-golden.test.js              # the 3,006 cases
```

Playwright is not a declared dependency — `npm test` reports a module-not-found
failure without it, and `ERR_CONNECTION_REFUSED` without the server. Neither is
a regression; both are missing prerequisites.

> **The golden fixture must never be regenerated to make a migration pass.**
> It is the definition of correct behaviour, recorded before the refactor. If a
> replay diverges, the port is wrong — find the cause and fix the port. Editing
> `systems-golden.json` or `engine-golden.json` to agree with new output destroys
> the only evidence that behaviour was preserved.

---

## 7 · Migration requirements

1. **Core behaviour must not change.** The engine encodes NSCA/CSCS loading
   decisions and a series of audited fixes. A wrong constant does not throw — it
   prescribes a weight the lifter has not earned, and the symptom appears weeks
   later.
2. **Import the core; do not rewrite it.** `src/core/` is already
   framework-free and DOM-free. Prompts that touch training logic should name the
   module and say *call it, do not reimplement it*.
3. **The UI may be rebuilt** in React/Tailwind/shadcn without restriction.
4. **Supabase wiring is separate work** — see §5 for what belongs in a database.
   Keep the open session device-local so two devices cannot claim one day.
5. **Any intentional behaviour change must be identified and separately tested.**
   Say what changed and why, add a test that pins the new behaviour, and record a
   new fixture *alongside* the old one — never in place of it.

---

## 8 · Known constraint

The app is now an ES module, so **it must be served over HTTP**. Opening
`index.html` from the filesystem no longer works — `file://` blocks module
loading. Any local run, test or demo needs a static server:

```bash
python3 -m http.server 8080
```
