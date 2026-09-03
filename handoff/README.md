# Trainlog handoff kit

Everything a new front end needs in order to build on this app rather than
re-derive it. Drop this folder into the target project.

```
trainlog-core.js        the decision engine, pure, no DOM, no globals
trainlog-core.test.js   14 characterization tests — the guardrail
data/                   248 movements + the tables that classify them
```

## The one rule

**Do not rewrite anything in `trainlog-core.js`.** Import it and call it.

Every function in that file encodes either an NSCA/CSCS loading decision or one
of eight audited bug fixes. Progression bugs are silent — a wrong constant does
not throw an error, it prescribes a weight the lifter has not earned, and the
symptom shows up weeks later as a stall or an injury. There is no test a language
model can run against a prompt that would catch it.

`trainlog-core.js` was verified against the shipping app across **9,456
comparisons with zero mismatches**: estimation, periodization across every block
length from 4 to 12 weeks, four goals, the full RPE and rep range, and 225
progression scenarios covering every combination of logged effort, weight and rep
outcome. Treat any diff to that file that did not come with a matching test as a
defect and revert it.

```
node --test trainlog-core.test.js      # 14 passing — run this in CI
```

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
