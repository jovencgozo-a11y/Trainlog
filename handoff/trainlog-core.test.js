/**
 * Characterization tests for the Trainlog decision core.
 *
 * These do not ask "is this correct" — they ask "does this still do exactly what
 * it did". Every case below is a behaviour that was wrong once and was fixed, or
 * a loading parameter taken from the NSCA tables. If one of these fails after a
 * refactor, the refactor is wrong, not the test.
 *
 * Run:  node --test trainlog-core.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  e1rm, pctForReps, phaseOf, blockIndex, adaptFor, loadPct, holdSecs,
  loadStep, speedCap, earnedThreshold, judgeSession, decideLoad, decideReps, ADAPT
} from './trainlog-core.js';

/* helper: build a history newest-first at one weight */
const hist = (rows, targetReps = 8) =>
  rows.map(r => judgeSession({
    sets: [{ w:r.w, r:r.r }, { w:r.w, r:r.r }, { w:r.w, r:r.r }],
    effort: r.eff, targetReps, autoreg: r.dosed ? 2 : 0
  }));

test('Epley is capped at ten reps so a burnout set cannot inflate the max', () => {
  assert.equal(e1rm(135, 8), 171);
  assert.equal(e1rm(135, 10), 180);
  assert.equal(e1rm(135, 25), 180, 'a 25-rep set must not estimate above a 10-rep set');
  assert.equal(e1rm(200, 1), 200, 'a true single returns itself, not 1.033w');
});

test('load comes out of the rep prescription by inverse Epley', () => {
  assert.equal(Math.round(pctForReps(10) * 10) / 10, 75);
  assert.equal(Math.round(pctForReps(1) * 10) / 10, 96.8);
});

test('no block length produces back-to-back or orphaned deloads', () => {
  for (let n = 4; n <= 12; n++) {
    const wk = [];
    for (let w = 1; w <= n; w++) wk.push(phaseOf(w, n) === 3 ? 'D' : '.');
    const s = wk.join('');
    assert.ok(!/DD/.test(s), `${n}-week block has back-to-back deloads: ${s}`);
    assert.equal(s[s.length - 1], 'D', `${n}-week block must end on a deload: ${s}`);
  }
});

test('adaptation ramps across the block for each goal', () => {
  assert.equal(adaptFor('strength', 1, 6), 'strhyp');
  assert.equal(adaptFor('strength', 6, 6), 'maxstrength');
  assert.equal(adaptFor('health', 1, 6), 'endurance');
  assert.equal(blockIndex(1, 6), 0);
  assert.equal(blockIndex(6, 6), 2);
});

test('%1RM is RIR-adjusted and drops on a deload week', () => {
  const load = loadPct('hypertrophy', 1, 6, 8, '8');
  const deload = loadPct('hypertrophy', 6, 6, 8, '8');
  assert.ok(deload < load, 'a deload week must prescribe less load');
  assert.ok(load <= 95, 'never a true 1RM for a multi-rep set');
});

test('hold duration depends on the movement, not only the week', () => {
  assert.equal(holdSecs('hypertrophy', 1, 6, 'core_anti_ext'), 40, 'plank');
  assert.equal(holdSecs('hypertrophy', 1, 6, 'quad_iso'), 45, 'wall sit');
  assert.equal(holdSecs('hypertrophy', 1, 6, 'carry'), 40, 'loaded carry');
  assert.equal(holdSecs('hypertrophy', 1, 6, 'adductor'), 25, 'Copenhagen plank');
  assert.ok(holdSecs('hypertrophy', 6, 6, 'core_anti_ext') <
            holdSecs('hypertrophy', 1, 6, 'core_anti_ext'), 'holds shorten on a deload');
  assert.ok(holdSecs('strength', 1, 6, 'core_anti_ext') >= 20, 'never below a useful stimulus');
});

test('load steps stay proportional and light work is never stuck', () => {
  assert.equal(loadStep(315, true), 10);
  assert.equal(loadStep(15, false), 2.5);
  // the bug: rounding the 10% ceiling below the current weight froze light lifts
  for (const w of [5, 7.5, 10, 12.5]) {
    const capped = speedCap([w], w + loadStep(w, false), w + 2.5);
    assert.ok(capped > w, `${w} lb must be able to progress, got ${capped}`);
  }
});

test('an untapped session is provisional, not a full green light', () => {
  const j = judgeSession({ sets:[{ w:135, r:8 }], targetReps:8 });
  assert.equal(j.eff, 'solid');
  assert.equal(j.assumed, true);
  const beat = judgeSession({ sets:[{ w:135, r:10 }], targetReps:8 });
  assert.equal(beat.eff, 'easy', 'beating the range by two is objective reserve');
  assert.equal(beat.assumed, true);
});

test('untapped effort does not become an uncapped linear progression', () => {
  let w = 135, moves = 0;
  const log = [];
  for (let i = 0; i < 10; i++) {
    log.unshift({ w, r:8 });                       // reps hit, effort never tapped
    const rec = decideLoad(hist(log), { exp:'intermediate', isLower:true });
    if (rec.action === 'progress') moves++;
    w = rec.w;
  }
  assert.ok(w <= 175, `ten untapped sessions must not reach ${w} lb`);
  assert.ok(moves <= 4, 'an intermediate should not bump every session');
});

test('the earned streak is counted at the current weight', () => {
  const two = decideLoad(hist([{ w:100, r:8, eff:'solid' }, { w:100, r:8, eff:'solid' }]),
    { exp:'intermediate' });
  assert.equal(two.action, 'progress');
  const after = decideLoad(hist([
    { w:two.w, r:8, eff:'solid' }, { w:100, r:8, eff:'solid' }, { w:100, r:8, eff:'solid' }
  ]), { exp:'intermediate' });
  assert.equal(after.action, 'hold', 'one clean session at a NEW weight must hold');
});

test('two bad sessions deload about ten percent', () => {
  const r = decideLoad(hist([{ w:200, r:5, eff:'grind' }, { w:200, r:5, eff:'grind' }]),
    { exp:'intermediate' });
  assert.equal(r.action, 'deload');
  assert.equal(r.w, 180);
  const one = decideLoad(hist([{ w:200, r:5, eff:'grind' }]), { exp:'intermediate' });
  assert.equal(one.action, 'hold', 'one bad session holds, it does not deload');
});

test('a readiness-lightened day neither earns nor punishes', () => {
  const r = decideLoad(hist([
    { w:185, r:8, eff:'solid', dosed:true },
    { w:200, r:8, eff:'solid' }, { w:200, r:8, eff:'solid' }
  ]), { exp:'intermediate' });
  assert.equal(r.action, 'progress');
  assert.ok(r.w > 200, 'the base must stay at 200, not drop to the dosed 185');
});

test('bodyweight climbs to the ceiling, levels up, and can step back', () => {
  const up = decideReps(hist([{ w:0, r:8, eff:'easy' }], 8), { baseReps:8, ceiling:12 });
  assert.equal(up.action, 'progress');
  const top = decideReps(hist([{ w:0, r:12, eff:'easy' }], 12),
    { baseReps:12, ceiling:12, nextRung:'Archer Push-up' });
  assert.equal(top.action, 'levelup');
  assert.equal(top.next, 'Archer Push-up');
  const back = decideReps(hist([{ w:0, r:4, eff:'grind' }, { w:0, r:4, eff:'grind' }], 10),
    { baseReps:10, ceiling:12, prevRung:'Knee Push-up' });
  assert.equal(back.action, 'regress', 'two short sessions step down a rung');
  const once = decideReps(hist([{ w:0, r:4, eff:'grind' }], 10),
    { baseReps:10, ceiling:12, prevRung:'Knee Push-up' });
  assert.equal(once.action, 'hold', 'one short session holds');
});

test('NSCA loading parameters are intact', () => {
  assert.deepEqual(ADAPT.maxstrength.pct, [85, 100]);
  assert.deepEqual(ADAPT.maxstrength.reps, [1, 5]);
  assert.deepEqual(ADAPT.endurance.pct, [40, 60]);
  assert.deepEqual(ADAPT.power.pct, [30, 70]);
  assert.equal(earnedThreshold('beginner'), 1);
  assert.equal(earnedThreshold('intermediate'), 2);
});
