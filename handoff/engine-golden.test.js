/**
 * Golden-master replay.
 *
 * engine-golden.json holds ~28,000 input→output pairs captured from the shipping
 * app. This test replays every one of them against trainlog-core.js. It is the
 * proof that a port did not change behaviour — the characterization tests say
 * the important rules still hold, this says NOTHING moved at all.
 *
 * If you port the engine to TypeScript, to another language, or let an agent
 * refactor it, point this file at the new implementation. A green run means the
 * new code is behaviourally identical to the build that was audited. A red run
 * tells you exactly which input diverged.
 *
 * Run:  node --test engine-golden.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './trainlog-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'engine-golden.json'), 'utf8'));

/** How each recorded call maps onto the core's signature. */
const CALL = {
  e1rm:       a => core.e1rm(a[0], a[1]),
  pctForReps: a => +core.pctForReps(a[0]).toFixed(10),
  phaseOf:    a => core.phaseOf(a[0], a[1]),
  blockIndex: a => core.blockIndex(a[0], a[1]),
  adaptFor:   a => core.adaptFor(a[0], a[1], a[2]),
  loadPct:    a => core.loadPct(a[0], a[1], a[2], a[3], a[4]),
  holdSecs:   a => core.holdSecs(a[0], a[1], a[2], a[3]),
  loadStep:   a => core.loadStep(a[0], a[1]),
  decideLoad: a => core.decideLoad(a[0], a[1])
};

test(`golden master: ${golden.cases.length} recorded cases still reproduce`, () => {
  const failures = [];
  const seen = new Set();
  for (const c of golden.cases) {
    const fn = CALL[c.fn];
    if (!fn) { failures.push(`no binding for ${c.fn}`); continue; }
    seen.add(c.fn);
    let got;
    try { got = fn(c.args); }
    catch (e) { failures.push(`${c.fn}(${JSON.stringify(c.args).slice(0, 90)}) threw ${e.message}`); continue; }
    if (JSON.stringify(got) !== JSON.stringify(c.out)) {
      failures.push(`${c.fn}(${JSON.stringify(c.args).slice(0, 90)})\n    expected ${JSON.stringify(c.out)}\n    got      ${JSON.stringify(got)}`);
    }
    if (failures.length > 8) break;      // enough to diagnose; stop flooding
  }
  assert.deepEqual(failures, [],
    `${failures.length} divergence(s) from the audited build:\n  ${failures.join('\n  ')}`);
  assert.ok(seen.size >= 9, `expected every engine function to be exercised, saw ${seen.size}`);
});

test('the safety envelope catches the wiring mistakes a port actually makes', () => {
  const hist = [{ w:135, r:8, hit:true, eff:'solid', assumed:false, dosed:false }];

  // a correct recommendation passes untouched
  const ok = core.vetLoad({ w:140, action:'progress', why:'' }, { history:hist });
  assert.equal(ok.safe, true);
  assert.equal(ok.rec.w, 140);

  // history read in the wrong order, or warm-ups left in, produce a runaway jump
  const wild = core.vetLoad({ w:400, action:'progress', why:'' }, { history:hist, movement:'Bench' });
  assert.equal(wild.safe, false);
  assert.ok(wild.rec.w < 400 && wild.rec.clamped, 'an unsafe load must be clamped, not shown');

  // a rep count relabelled as seconds — the swap bug, if it ever came back
  const short = core.vetHold(8, { movement:'Plank' });
  assert.equal(short.safe, false);
  assert.ok(short.secs >= core.LIMITS.minHoldSecs);

  // oldest-first history makes the ratchet read the wrong session as "last"
  assert.ok(core.vetHistory([
    { w:135, r:8, hit:true, date:'2026-01-01' },
    { w:145, r:8, hit:true, date:'2026-06-01' }
  ]).length > 0, 'reversed history must be reported');

  // raw sets passed in without judgeSession
  assert.ok(core.vetHistory([{ w:135, r:8 }]).length > 0, 'unjudged history must be reported');

  // a percentage outside the prescribable band
  assert.equal(core.vetPct(140, { movement:'Squat' }).safe, false);
  assert.equal(core.vetPct(75, {}).safe, true);
});

test('a large relative step has to be earned twice', () => {
  const j = (w, r, eff) => core.judgeSession({ sets:[{ w, r }, { w, r }, { w, r }], effort:eff, targetReps:8 });
  // 5 lb → 7.5 lb is a 50% jump; one easy session is not enough on its own
  const once = core.decideLoad([j(5, 8, 'easy')], { exp:'intermediate' });
  assert.equal(once.action, 'hold', 'a 50% step must not move on a single session');
  const twice = core.decideLoad([j(5, 8, 'easy'), j(5, 8, 'easy')], { exp:'intermediate' });
  assert.equal(twice.action, 'progress', 'two clean sessions do earn it');
  // a proportionate step still moves on one easy session
  const big = core.decideLoad([j(315, 8, 'easy')], { exp:'intermediate', isLower:true });
  assert.equal(big.action, 'progress', 'a 3% step should not need extra evidence');
});
