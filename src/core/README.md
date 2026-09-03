# `src/core/` — import boundaries

The decision logic of Trainlog: readiness, scoring, scheduling and program
generation. Extracted verbatim from `index.html`; no formula, threshold or
declaration order was changed. Nothing in here touches the DOM, `window`,
`document`, `localStorage`, timers or the network.

`MIGRATION.md` at the repository root is the full specification (function
tables, context shapes, `composeProgram` contract, state taxonomy). This file
covers only how to import it.

## Files

| File | Role | Exports |
|---|---|---|
| `engine.js` | The single real module. All 220 declarations live here, in their original order. | 221 |
| `readiness.js` | Re-export view of the readiness system | 24 |
| `scoring.js` | Re-export view of the scoring system | 54 |
| `scheduling.js` | Re-export view of the scheduling system | 38 |
| `programGeneration.js` | Re-export view of the generator | 161 |

The four system modules contain no logic — they re-export from `engine.js`.
They exist so a consumer can import one system without pulling the whole
surface into scope, and so the system boundaries stay legible. Import from
whichever is narrower for your use; they are the same functions either way.

Declaration order in `engine.js` is load-bearing. Several exports are `const`
and reference each other at module-evaluation time; reordering them
reintroduces a temporal dead zone that did not exist in the single file. Do not
sort, group or "tidy" this file.

## Two ways to call in

**1. With an explicit context (preferred, and what a port should do).**
Each system takes its inputs through a context object. Pass one and the module
is fully standalone — no host, no globals, no browser:

```js
import { readinessScore, todayReadiness } from './src/core/readiness.js';
import { composeProgram } from './src/core/programGeneration.js';

const r = todayReadiness({ readiness, symptoms, plan, dayId, autoreg, today });
const program = composeProgram(seed, setup);   // returns; writes nothing
```

Context shapes (defined by `rdCtx` / `scCtx` / `schCtx` / `pgCtx` in `engine.js`):

- readiness — `{ readiness, symptoms, plan, dayId, autoreg, today }`
- scoring — `{ sessions, runs, archive, plan, sex, bw, liftDays, today }`
- scheduling — `{ startDate, trainDows, liftDays, sched, plan, sessions, today }`
- program generation — the `setup` object itself

**2. Bound to a host (what `index.html` does).**
When a call omits its context, the `*Ctx` helpers fall back to host objects
supplied once at boot:

```js
import * as CORE from './src/core/engine.js';
CORE.bindHost({ get state(){ return state; },
                get setup(){ return setup; },
                get ui(){ return ui; } });
```

`bindHost` exists so the app's existing call sites keep working
unchanged. It is a compatibility shim for the current shell, not part of the
target architecture — a port should pass contexts explicitly and never call it.

## Direction of dependency

```
index.html  ──imports──▶  src/core/
```

One way only. The core never imports from the shell, never reaches back through
`window`, and never assumes a browser. `index.html` re-publishes the core's
exports onto `window` after import; that is the shell's business, not the
core's, and a port drops it.

## Rules

- Do not modify the logic in these files. Behaviour is pinned by
  `handoff/systems-golden.json` (3,006 cases) and `handoff/engine-golden.json`
  (27,898 cases).
- Do not regenerate either fixture. They record the behaviour as it was
  verified; a replay that diverges means the change is wrong, not the fixture.
- Do not add DOM, storage or network access to this directory. The DOM-free
  property is what makes the core portable and testable.

Verify independence at any time — this runs in plain Node, no DOM, no `bindHost`,
and prints `161`:

```bash
node --input-type=module \
  -e "import('./src/core/programGeneration.js').then(m=>console.log(Object.keys(m).length))"
```

Replaying the fixtures needs two prerequisites (see `MIGRATION.md`): Playwright,
which is not a declared dependency, and the app served over HTTP.

```bash
npm install --no-save playwright
python3 -m http.server 8080 &
cd handoff && npm test
APP_URL=http://localhost:8080/index.html node --test systems-golden.test.js
```

## Serving note

`index.html` is now an ES module and must be served over HTTP
(`python3 -m http.server`), not opened as `file://`.
