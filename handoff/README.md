# Trainlog handoff kit

Everything a new front end needs in order to build on this app rather than
re-derive it. Drop this folder into the target project.

```
trainlog-core.js        the decision engine + safety envelope, no DOM, no globals
trainlog-core.test.js   14 characterization tests — the rules that matter
engine-golden.test.js   replays the golden master + the envelope's own tests
engine-golden.json      27,898 recorded input→output pairs from the shipping app
systems-golden.test.js  replays program generation, scheduling, readiness, scoring
systems-golden.json     3,006 recorded cases for those four (needs the app served)
data/                   248 movements + the tables that classify them
package.json            `npm test` runs all 17
```

## The one rule

**Do not rewrite anything in `trainlog-core.js`.** Import it and call it.

Every function in that file encodes either an NSCA/CSCS loading decision or one
of eight audited bug fixes. Progression bugs are silent — a wrong constant does
not throw an error, it prescribes a weight the lifter has not earned, and the
symptom shows up weeks later as a stall or an injury. There is no test a language
model can run against a prompt that would catch it.

`trainlog-core.js` was verified against the shipping app across **9,456 direct
comparisons with zero mismatches**, then fuzzed over **14,232 probes** for outputs
that could actually hurt someone — runaway jumps, progression off a failed
session, non-finite loads, percentages outside the prescribable band, holds
outside 20–120 s, inflated 1RM estimates. It reports no violations.

Treat any diff to that file that did not come with a matching test as a defect
and revert it.

```
npm test        # 21 passing — wire this into CI before anything else
```

The four system suites drive a live `index.html` in headless Chromium, because
those systems still read the app's global state. Serve the repo root and point
them at it:

```
python3 -m http.server 8831 &
APP_URL=http://localhost:8831/index.html npm test
```

## The safety net, and how to use it

This engine puts weight on a bar. A wrong number is not a rendering glitch, so
the net has three independent layers and you should keep all three.

**1 · Characterization tests** (`trainlog-core.test.js`) — 14 rules that were each
wrong once: the untapped-effort ladder, the streak counted at the current weight,
the Epley cap, per-pattern holds, deload spacing at every block length, the
bodyweight rungs in both directions. These say *the important behaviour still
holds*.

**2 · Golden master** (`engine-golden.json`) — 27,898 input→output pairs captured
from the audited build, replayed in about 130 ms. These say *nothing moved at
all*. Port the engine to TypeScript, to another language, or hand it to an agent
to refactor: point `engine-golden.test.js` at the new implementation and a green
run is proof of behavioural identity. A red run names the exact input that
diverged.

**3 · Safety envelope** (`vetLoad`, `vetHold`, `vetPct`, `vetHistory`) — runtime
bounds for the failure mode tests cannot catch: a caller that wires a *correct*
engine up *wrongly*. Pass sessions oldest-first and the ratchet reads the wrong
session as "last". Forget to filter warm-ups and the top set is a 50% bar. Lose
the archive and the history is empty. None of those throw — they just show a
number. Run every prescription through the envelope before it reaches a screen:

```js
const rec = decideLoad(history, { exp, isLower });
const { rec: safe, breaches } = vetLoad(rec, { history, movement });
if (breaches.length) report(breaches);   // log it, alert, do not swallow
render(safe);                            // always safe to display
```

A breach is a bug in the calling code, not a value to clamp quietly. The envelope
returns the safe number *and* says what was wrong, so it surfaces instead of
hiding.

## Using the core

The core takes explicit arguments; it holds no state of its own.

```js
import { judgeSession, decideLoad, holdSecs, loadPct } from './trainlog-core.js';

// newest first, across ALL blocks including archived ones — dropping the
// archive throws away earned weight every time a program is rebuilt
const history = sessions.map(s => judgeSession({
  sets:       s.entries[movementName],
  effort:     s.efforts?.[movementName],   // optional; silence is read from reps
  targetReps: targetRepsFor(movementName, s.week),
  autoreg:    s.autoreg                    // a readiness-lightened day
}));

const next = decideLoad(history, { exp: profile.experience, isLower });
// → { w: 145, action: 'progress', why: 'Clean reps 2 sessions running at 135 lb…' }
```

`next.why` is written for the athlete, not the developer. Show it. It is the
single most distinctive thing this app does, and the reason people trust the
number: the app can always explain the weight it is asking for.

## What is NOT in here

Program generation, scheduling, readiness and scoring are DOM-free, covered by
`systems-golden.json`, and now take their inputs through an explicit context
object — `rdCtx`, `scCtx`, `schCtx`, `pgCtx`. Omitting it falls back to the live
globals, which is what every existing call site does, so behaviour is unchanged;
passing one drives the system with no global reads at all. Verified by emptying
`state` and `setup` and running all four purely from injected context.

`composeProgram(seed, ctx)` now **returns** the finished program as a plain
object — plan, seed, weeks, weekNames, sched, adaptations, setup, startDate —
and writes nothing. `applyProgram(result)` is the shell that puts it into
`state`, and `generateProgram` is the DOM wrapper that archives, applies, saves
and navigates. Verified with every relevant global emptied: the returned program
is complete and correct, `state` and `ui` are byte-identical before and after,
and the same seed and context produce the same program twice.

The block length and draw seed used to be published by writing `state.weeks` and
`state.seed` partway through the build, where `stageWeeks`, `setsPeak`, `reSets`
and the seeded movement pickers read them back. They are now carried in two
compose-scoped variables set at exactly the points those writes used to happen
and restored in a `finally`, so nothing persists and the helpers that ran before
the boundary still see the old values — which is what keeps the produced program
identical.

`genTargets`, `primaryGoal`, `goalsNow`, `styleFor`, `styleAllowed`, `waveSets`
and `blockPhase` all take the context explicitly now, so the prescription follows
the injected setup rather than the global one. Verified against a global setup
deliberately set to conflict: with `setup` saying health/beginner/4 weeks and the
context saying power/advanced/12 weeks, the produced program follows the context
on day count, block length, week names, goal and the experience-driven RPE shift.

One exception is kept on purpose: `styleFor` still derives its phase from
`weekCount()` rather than from `genTargets`'s own `n`. In the original those two
were allowed to differ, and unifying them changes which weeks carry a style cue.

`ctx.injuries` now controls movement selection too. The candidate-pool helpers
`loadableFor`, `bandFinisherFor`, `compoundAvailable`, `betterPrimaryExists` and
`injBlocked` take the context, as do `pairBandWork`, `primaryFit` and
`guardPrimaries` on the way to them — and `buildDay` now passes its context to
`pickForSlot`, which was the actual leak: the filter was already parameterised
but the argument was never handed over.

Verified both ways. Same seed and context, `injuries: []` vs `['knee']`: four
knee-flagged movements selected, then none. With the global saying
`['knee','shoulder']` and the context saying `[]`, the flagged movements are used
— the context wins; with the global empty and the context `['knee']`, they are
dropped.

The muscle-map slug tables stay behind: they are coupled to the SVG and the 3D
figure.

Until then, the parent `index.html` is the reference implementation for those.
It is a single file with no build step: open it, or serve the directory.

## Data

`data/movements.json` is the movement bank. One record:

```json
{ "n": "Barbell Bench Press", "p": "hpress", "g": ["chest","arms"],
  "tier": 1, "skill": 2, "kit": ["barbell","bench"], "eq": "free",
  "x": ["shoulder","wrist"], "note": "Primary horizontal press — …" }
```

`p` pattern · `g` muscle groups · `tier` 1 primary … 3 accessory ·
`skill` technical demand, which drives the bodyweight progression ladder ·
`x` contraindicated for these flagged injuries · `eq` free / machine / bodyweight.

`holdSecs` keys off `p` for timed movements, so the pattern strings matter.
