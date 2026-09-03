# Trainlog handoff kit

Everything a new front end needs in order to build on this app rather than
re-derive it. Drop this folder into the target project.

```
trainlog-core.js        the decision engine + safety envelope, no DOM, no globals
trainlog-core.test.js   14 characterization tests — the rules that matter
engine-golden.test.js   replays the golden master + the envelope's own tests
engine-golden.json      27,898 recorded input→output pairs from the shipping app
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
npm test        # 17 passing, ~0.2s — wire this into CI before anything else
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

The parts that are still coupled to the DOM in the parent app and need the module
split (phase 0 of the migration plan) before they can travel:

- program generation — `generateProgram`, `buildDay`, `genTargets`, `governVolume`
- scheduling — `buildSchedule`, `weekRows`
- the readiness/autoregulation reader and the scoring/rank system
- the muscle-map slug tables, which are coupled to the SVG and the 3D figure

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
