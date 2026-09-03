/**
 * Golden-master replay for program generation, scheduling, readiness and scoring.
 *
 * These four systems are still coupled to the app's global state, so unlike
 * trainlog-core they cannot be imported directly. This suite replays the
 * recorded cases against a live instance of index.html in a headless browser —
 * the same oracle they were captured from. Its job is to prove that pulling them
 * out of the DOM changed nothing.
 *
 * Run:  node --test systems-golden.test.js     (requires the app served locally)
 *       APP_URL=http://localhost:8831/index.html node --test systems-golden.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'systems-golden.json'), 'utf8'));
const APP_URL = process.env.APP_URL || 'http://localhost:8831/index.html';

let browser, page;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil:'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.plan && state.plan.length,
    null, { timeout:30000 });
  await page.waitForTimeout(800);
});
after(async () => { if (browser) await browser.close(); });

/** Replay one system's cases inside the page and return the divergences. */
async function replay(sys) {
  return page.evaluate(({ cases, PLAN }) => {
    const fails = [];
    const eq = (name, want, got) => {
      if (JSON.stringify(want) !== JSON.stringify(got))
        fails.push(`${name}\n    expected ${JSON.stringify(want).slice(0,160)}\n    got      ${JSON.stringify(got).slice(0,160)}`);
    };
    const realRandom = Math.random;
    for (const c of cases) {
      if (fails.length > 6) break;
      const a = c.args;
      switch (c.fn) {
        case 'dowOf':        eq('dowOf'+JSON.stringify(a), c.out, dowOf(a[0])); break;
        case 'defaultDows':  eq('defaultDows'+JSON.stringify(a), c.out, defaultDows(a[0])); break;
        case 'isLowerDay':   eq('isLowerDay'+JSON.stringify(a), c.out, isLowerDay(a[0])); break;
        case 'buildSchedule':eq('buildSchedule'+JSON.stringify(a).slice(0,70), c.out, buildSchedule(a[0],a[1],a[2],a[3],a[4])); break;
        case 'readinessScore':eq('readinessScore'+JSON.stringify(a), c.out, readinessScore(a[0])); break;
        case 'readinessBand': eq('readinessBand'+JSON.stringify(a), c.out, readinessBand(a[0])); break;
        case 'autoReg': {
          state.plan = JSON.parse(JSON.stringify(PLAN));
          state.symptoms = c.ctx.symptoms; state.readiness = c.ctx.readiness; ui.dayId = c.ctx.dayId;
          const ar = autoReg();
          eq('autoReg '+JSON.stringify(c.ctx.symptoms).slice(0,60), c.out,
            ar?{level:ar.level,score:ar.score,band:ar.band&&ar.band.key,cluster:ar.cluster,flags:(ar.flags||[]).map(f=>f.region)}:null);
          break; }
        case 'autoRegPlan': {
          state.plan = JSON.parse(JSON.stringify(PLAN));
          state.symptoms = c.ctx.symptoms; state.readiness = c.ctx.readiness; ui.dayId = c.ctx.dayId;
          const pl = autoRegPlan();
          eq('autoRegPlan '+JSON.stringify(c.ctx.symptoms).slice(0,60), c.out,
            pl?{level:pl.level,setDrop:pl.setDrop,rpeCap:pl.rpeCap,moves:pl.moves.length}:null);
          break; }
        case 'scoreState': case 'weekStats': case 'consistency': case 'bestOfAll': case 'maxOf': {
          state.plan = JSON.parse(JSON.stringify(PLAN));
          const n = c.ctx.sessions;
          const mkS=(i,w,r)=>({id:i,date:'2026-0'+(1+i%9)+'-0'+(1+i%9),week:1+(i%4),dayId:state.plan[0].id,
            dayName:state.plan[0].name,entries:{[state.plan[0].exercises[0].name]:[{w,r},{w,r},{w,r}]},
            volume:w*r*3,minutes:50});
          state.sessions=Array.from({length:n},(_,i)=>mkS(i,135+i*5,8));
          state.runs=Array.from({length:Math.floor(n/3)},(_,i)=>({id:i,date:'2026-02-0'+(1+i%9),miles:3,minutes:27}));
          state.archive=[];
          if(c.fn==='scoreState'){ const s=scoreState();
            eq(`scoreState(${n})`, c.out, {xp:s.xp,lvl:s.lvl,into:s.into,need:s.need,rankIdx:s.rankIdx,stats:s.stats,badges:s.badges.length}); }
          if(c.fn==='weekStats') eq(`weekStats(${n},wk${a[0]})`, c.out, weekStats(a[0]));
          if(c.fn==='consistency'){ const cc=consistency();
            eq(`consistency(${n})`, c.out, {lift:Object.keys(cc.lift).length,run:Object.keys(cc.run).length}); }
          if(c.fn==='bestOfAll') eq(`bestOfAll(${n})`, c.out, bestOfAll(a[0]));
          if(c.fn==='maxOf') eq(`maxOf(${n})`, c.out, maxOf(a[0]));
          break; }
        case 'gateCheck': {
          state.plan = JSON.parse(JSON.stringify(PLAN));
          state.bw=c.ctx.bw; state.sex=c.ctx.sex; const gc=gateCheck();
          eq(`gateCheck(${c.ctx.bw},${c.ctx.sex})`, c.out, {known:gc.known,why:gc.why,tier:gc.tier,lifts:gc.lifts.length});
          break; }
        case 'generateProgram': case 'weekRows': case 'dayMinutes': {
          const key = JSON.stringify(c.ctx);
          if (window.__lastCtx !== key) {
            let s0 = 12345 + (c.ctx.__i ?? 0);
            // the seed is derived from the context so a rebuild is reproducible
            let hash = 0; for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
            s0 = hash;
            Math.random = () => ((s0 = (s0 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
            Object.assign(setup, c.ctx);
            state.plan=[]; state.archive=[]; state.sessions=[];
            window.askConfirm=async()=>true; window.clearOpenForRebuild=async()=>true;
            window.__pending = generateProgram();
            window.__lastCtx = key;
          }
          break; }
      }
    }
    Math.random = realRandom;
    return fails;
  }, { cases: golden.cases.filter(c => c.sys === sys), PLAN: golden.scoringPlan });
}

for (const sys of ['scheduling', 'readiness', 'scoring']) {
  const n = golden.cases.filter(c => c.sys === sys).length;
  test(`${sys}: ${n} recorded cases still reproduce`, async () => {
    const fails = await replay(sys);
    assert.deepEqual(fails, [], `${fails.length} divergence(s):\n  ${fails.join('\n  ')}`);
  });
}

/* Program generation is async and mutates global state, so it is replayed on its
   own with the seed pinned, comparing the whole produced plan. */
test(`programGeneration: ${golden.cases.filter(c=>c.sys==='programGeneration').length} recorded cases still reproduce`, async () => {
  const cases = golden.cases.filter(c => c.sys === 'programGeneration');
  const fails = await page.evaluate(async ({ cases }) => {
    const fails = [];
    const realRandom = Math.random;
    const byCtx = new Map();
    cases.forEach(c => { const k = JSON.stringify(c.ctx); if (!byCtx.has(k)) byCtx.set(k, []); byCtx.get(k).push(c); });
    let i = 0;
    for (const [key, group] of byCtx) {
      let s0 = 12345 + (i++) * 7;
      Math.random = () => ((s0 = (s0 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      Object.assign(setup, JSON.parse(key));
      state.plan = []; state.archive = []; state.sessions = [];
      window.askConfirm = async () => true; window.clearOpenForRebuild = async () => true;
      await generateProgram();
      for (const c of group) {
        let got;
        if (c.fn === 'generateProgram') got = { days: state.plan.map(d=>({name:d.name,n:d.exercises.length,
          ex:d.exercises.map(e=>e.name),targets:d.exercises.map(e=>e.targets)})),
          weekNames: state.weekNames, weeks: state.weeks, sched: state.sched };
        else if (c.fn === 'weekRows') got = weekRows(c.args[0]).map(r=>({d:r.d,lift:r.lift,run:r.run?r.run.label:null}));
        else if (c.fn === 'dayMinutes') got = state.plan.map(d=>dayMinutes(d,1));
        if (JSON.stringify(got) !== JSON.stringify(c.out))
          fails.push(`${c.fn} [${(c.ctx.goal||'')}/${c.ctx.exp}/${c.ctx.liftDays}d]`);
        if (fails.length > 6) break;
      }
      if (fails.length > 6) break;
    }
    Math.random = realRandom;
    return fails;
  }, { cases });
  assert.deepEqual(fails, [], `${fails.length} divergence(s):\n  ${fails.join('\n  ')}`);
});
