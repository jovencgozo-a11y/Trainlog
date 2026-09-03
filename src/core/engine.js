/**
 * Trainlog core engine — readiness, scoring, scheduling and program generation.
 *
 * Extracted verbatim from index.html. No logic, thresholds, formulas or ordering
 * were changed: the declarations below appear in the same order they had in the
 * single file, which matters because several are `const` and would otherwise hit
 * a temporal-dead-zone that did not exist before.
 *
 * Nothing here touches the DOM. Each system takes its inputs through an explicit
 * context (rdCtx / scCtx / schCtx / pgCtx); when none is passed those fall back to
 * the host objects bound by bindHost(), which is how the app's own call sites keep
 * working unchanged. Imported standalone, pass a context and no host is needed.
 */

/* The app's live state/setup/ui, bound once by the UI shell. Only the context
   fallbacks read these — pass an explicit context and they are never consulted. */
let HOST = { state:{}, setup:{}, ui:{} };
export function bindHost(h){ HOST = h; return HOST; }
const state = new Proxy({}, { get:(_,k)=>HOST.state[k], set:(_,k,v)=>{ HOST.state[k]=v; return true; },
  has:(_,k)=>k in HOST.state, ownKeys:()=>Reflect.ownKeys(HOST.state),
  getOwnPropertyDescriptor:(_,k)=>Object.getOwnPropertyDescriptor(HOST.state,k) });
const setup = new Proxy({}, { get:(_,k)=>HOST.setup[k], set:(_,k,v)=>{ HOST.setup[k]=v; return true; },
  has:(_,k)=>k in HOST.setup, ownKeys:()=>Reflect.ownKeys(HOST.setup),
  getOwnPropertyDescriptor:(_,k)=>Object.getOwnPropertyDescriptor(HOST.setup,k) });
const ui = new Proxy({}, { get:(_,k)=>HOST.ui[k], set:(_,k,v)=>{ HOST.ui[k]=v; return true; },
  has:(_,k)=>k in HOST.ui, ownKeys:()=>Reflect.ownKeys(HOST.ui),
  getOwnPropertyDescriptor:(_,k)=>Object.getOwnPropertyDescriptor(HOST.ui,k) });

export const localISO = d => {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0');
};
export const todayISO = () => localISO(new Date());
export const E1RM_MAX_REPS = 10;
export const e1rm = (w,r) => {
  if(!(r > 0)) return w;
  const n = Math.min(r, E1RM_MAX_REPS);
  return n <= 1 ? Math.round(w) : Math.round(w*(1+n/30));
};
export const pace = (mi,min) => mi>0 ? min/mi : 0;
export const day = id => state.plan.find(d=>d.id===id);
export function topSet(sets){ return sets.reduce((a,b)=> e1rm(b.w,b.r)>e1rm(a.w,a.r)?b:a); }
export function stripLoad(str){
  let s = String(str||'');
  s = s.replace(/^\s*\d+(?:\.\d+)?\s*(?:lb|s|kg)\b\s*/i,'');
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:lb|kg)\b\s*/gi,'');
  return s.replace(/^\s*[+·-]\s*/,'').trim();
}
/* composeProgram used to publish its block length by writing state.weeks partway through, and
   a wide set of helpers — stageWeeks, setsPeak, reSets, fillDeficiencies — read it back through
   weekCount(). It now returns its result instead of writing, so the length is carried here for
   the duration of the build only: set at exactly the point the write used to happen, restored
   in a finally. Nothing persists, and the helpers that ran BEFORE that write still see the old
   value, which is what keeps the produced program identical. */
export let _composeWeeks = null;
/* Same treatment for the draw seed. composeProgram used to publish it by writing state.seed on
   its first line; the seeded movement pickers below read it back. It is carried here for the
   build only and restored afterwards, so nothing persists. */
export let _composeSeed = null;
export const genSeed = () => (_composeSeed != null ? _composeSeed : state.seed);
export function weekCount(){ return Math.max(4, Math.min(12, _composeWeeks || state.weeks || (state.weekNames ? state.weekNames.length : 4))); }
export function phaseOf(week, total){          // the 4-week wave repeats; the final week is always a deload
  const n = total || weekCount();
  if(week >= n) return 3;
  const ph = (week - 1) % 4;
  /* Two rules used to fire independently — every fourth week deloads, AND the last week always
     deloads — so wherever they landed near each other the block lost its taper. A five-week
     block spent its last two weeks unloading back to back; a nine-week block did the same; a
     six-week block put one lone loading week between two deloads and gave a third of the block
     to recovery. The scheduled deload gives way when the forced final one is already within
     reach, leaving one unbroken run into the taper. Lengths 4, 8 and 12 are unaffected. */
  if(ph === 3 && (n - week) < 3) return 2;
  return ph;
}
export const waveOf = week => Math.floor((week - 1) / 4) + 1;
/* "60% 1RM" cannot be acted on without knowing the max. Where enough has been logged to
   estimate one, show the weight beside the percentage; where it has not, say so rather than
   leave a percentage hanging. Added after stripLoad, which would otherwise remove it. */
export function withEstimate(ex, text){
  const m = String(text).match(/(\d+(?:\.\d+)?)% 1RM/);
  if(!m || !ex || !ex.name) return text;
  const max = trainingMax(ex.name, ex);
  /* No max means the percentage is a percentage of nothing. The RPE on the same line already
     prescribes the effort, so drop the percentage rather than restate the effort a second
     time in reps-in-reserve. */
  if(!max) return text.replace(new RegExp('\\s*·\\s*' + m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');
  const w = Math.round(max * (+m[1] / 100) / 2.5) * 2.5;
  return text.replace(m[0], m[0] + ' ≈ ' + w + ' lb');
}
/* The prescription exactly as written, with no load estimate folded in.

   Every parser that reads sets or reps must use THIS and not tgt(). tgt() annotates the
   line with an estimated working weight, and computing that estimate needs the rep target
   — so a parser that called tgt() re-entered the estimator and recursed until the stack
   gave out, killing the workout screen. It only bit once a lift had a logged best (with no
   best, trainingMax returns 0 before it ever asks for reps), which is why testing against
   an empty log never showed it. */
export function rawTarget(ex, wk){
  const w = wk || state.week;
  const t = ex.targets || [];
  if(!t.length) return '';
  return stripLoad(t[w-1] !== undefined ? t[w-1] : t[phaseOf(w)] || t[t.length-1]);
}
export function tgt(ex, wk){
  const raw = rawTarget(ex, wk);
  return raw ? withEstimate(ex, raw) : '';
}
export function repHint(target){
  const m = String(target).match(/×\s*([\d–\-]+)/);
  return m ? m[1] : '';
}

/* Applying a sport sets the same fields a person could set by hand — nothing hidden. */
export const ADAPT = {
  maxstrength: { label:'max strength',       pct:[85,100], reps:[1,5],   sets:[3,6], rest:[180,300] },
  strhyp:      { label:'strength + size',    pct:[75,85],  reps:[5,8],   sets:[3,5], rest:[120,240] },
  hypertrophy: { label:'hypertrophy',        pct:[65,80],  reps:[8,15],  sets:[3,5], rest:[60,180] },
  hyphigh:     { label:'hypertrophy, light', pct:[50,65],  reps:[15,30], sets:[2,4], rest:[60,120] },
  endurance:   { label:'muscular endurance', pct:[40,60],  reps:[15,30], sets:[2,4], rest:[30,90] },
  power:       { label:'power',              pct:[30,70],  reps:[1,5],   sets:[3,6], rest:[120,300] }
};
/* Three steps per goal, walked in order — a gradual build toward the quality the goal is
   after, rather than a different emphasis every week. */
export const GOAL_RAMP = {
  hypertrophy: ['hypertrophy','hypertrophy','strhyp'],
  strength:    ['strhyp','maxstrength','maxstrength'],
  power:       ['strhyp','power','power'],
  /* Endurance first, then the light-hypertrophy band, then hypertrophy proper — a gradual
     build in load across the block rather than a jump from 40–60% to 65–80% in one step.
     This step was also the only adaptation in the table nothing could ever reach. */
  health:      ['endurance','hyphigh','hypertrophy']
};
export const adaptFor = (goalKey, week, total) =>
  (GOAL_RAMP[goalKey || primaryGoal()] || GOAL_RAMP.hypertrophy)[blockIndex(week, total)];

/* The load comes OUT of the rep prescription rather than being chosen beside it, so the two
   can never contradict. Inverse Epley. */
export const pctForReps = r => 3000 / (30 + Math.max(1, r));
export function loadPct(goalKey, week, total, reps, rpe){
  const a = ADAPT[adaptFor(goalKey, week, total)];
  if(!a) return null;
  const n = total || weekCount(), ph = phaseOf(week, n);
  const hi = Math.min(a.pct[1], 95);                   // never a true 1RM for a multi-rep set
  /* Epley's inverse gives the load at which the rep count is MAXIMAL — reps in reserve zero.
     The app prescribes RPE 5–9 alongside it, so reading the percentage straight off the rep
     target asked for a load 2.5–7.5% of 1RM too heavy: at 12 reps and RPE 5 the lifter cannot
     both reach twelve and stop five short. The load is taken from the reps the set WOULD run
     to failure — prescribed reps plus the reps left in reserve. */
  const rir = Math.max(0, Math.min(6, 10 - (+String(rpe || '').replace(/\D+/g, '').slice(-1) || 8)));
  const eff = Math.max(1, (reps || a.reps[0]) + rir);
  /* Power is velocity work: the point is bar speed, not proximity to a maximum, so it sits in
     the lower half of its wide band and climbs a little across the blocks rather than pinning
     to the top of it. Your own note — the right load depends heavily on the movement. */
  if(a === ADAPT.power){
    const lo = a.pct[0], span = (a.pct[1] - lo) * 0.55;
    const t = ph === 3 ? 0 : Math.min(1, blockIndex(week, n) / 2);
    return Math.round((lo + span * t) / 2.5) * 2.5;
  }
  let p = pctForReps(eff);
  /* An easy week is a real reduction in load, so it is allowed BELOW the band — clamping it
     to the band floor cancelled the reduction outright. Effort also outranks the band on a
     normal week: %1RM is a guide, and reps plus proximity to failure are the real control, so
     a small undershoot of the floor is honest where forcing the floor would not be. */
  if(ph === 3) return Math.round(Math.max(35, Math.min(hi, p * 0.85)) / 2.5) * 2.5;
  return Math.round(Math.max(a.pct[0] - 7.5, Math.min(hi, p)) / 2.5) * 2.5;
}
/* Reps in reserve is the same statement as RPE from the other end: RIR ≈ 10 − RPE. */
export function rirFrom(rpeText){
  const m = String(rpeText || '').match(/(\d+)(?:\s*–\s*(\d+))?/);
  if(!m) return '1–2 RIR';
  const lo = +m[1], hi = m[2] ? +m[2] : lo;
  const a = Math.max(0, 10 - hi), b = Math.max(0, 10 - lo);
  return (a === b ? a : a + '–' + b) + ' RIR';
}
export function loadText(kind, goalKey, week, total, reps, rpeText){
  if(kind === 'bw') return 'bodyweight';
  if(kind === 'rir') return rirFrom(rpeText);
  const p = loadPct(goalKey, week, total, reps, rpeText);
  return p ? p + '% 1RM' : rirFrom(rpeText);
}
export function loadKindOf(m){
  if(!m) return 'rir';
  if(/^plyo/.test(m.p || '')) return 'bw';
  /* Nobody has a one-rep max for a plank or a carry, so a percentage of one is meaningless —
     "3×30s · 57.5% 1RM" is not a prescription. Effort is the currency for a hold. */
  if(isTimedMove(m)) return 'rir';
  /* A band is not bodyweight and has no percentage to take: its tension is ascending and
     unmeasurable, so effort is the only honest currency for it. */
  if(isBandMove(m)) return 'rir';
  if(!kitFor(m).some(k=>LOADABLE.indexOf(k) > -1)) return 'bw';
  return (m.tier || 2) <= 2 ? 'pct' : 'rir';
}
/* A max the lifter entered wins over one estimated from history: they know whether a set was
   a true effort and the estimate does not. */
/* A max is read from the log, not asked for. Typing one in is guesswork that then silently
   governs every percentage in the program, and it goes stale the moment the lifter gets
   stronger. The best set ever recorded for a movement — across the current block and every
   archived one — is turned into an estimated 1RM, so the number tracks training on its own. */
export function maxOf(exName, ctx){
  let est = 0;
  try{ est = bestOfAll(exName, ctx) || 0; }catch(e){ est = 0; }
  return Math.round(est);
}
/* The set the estimate came from, so the number is always attributable. */
export const isBandMove = m => /^band/i.test(m.n || '') ||
  (kitFor(m).length === 1 && kitFor(m)[0] === 'bands');
/* Band work is not training the program is built on. Ascending, unmeasurable tension makes it
   too easy to be a stimulus once a loadable option exists, so a band movement is REPLACED by a
   loadable one from the same pattern. The one place it earns is the very end of a lower-body
   day, where a high-rep glute or leg burnout does something no dumbbell does as well. Bands
   also live in the warm-up and in the Mobility tab, which is where the rest of their value is.

   The burnout is deliberately narrow: last position only, glutes or lower body only, one per
   day. Anything else is substituted or dropped. */
/* Band work is not training the program is built on. Ascending, unmeasurable tension makes it
   too easy to be a stimulus once a loadable option exists, so a band movement is REPLACED by a
   loadable one — same pattern where one exists, otherwise anything loadable training the same
   muscle group, because shortening the day is worse than substituting across patterns. Bands
   also live in the warm-up and in the Mobility tab, which is where the rest of their value is.

   The one place a band earns a slot in the session is the END of a lower-body day, as a glute
   or leg burnout: high-rep work under continuous tension that no dumbbell does as well. That
   is APPENDED, not waited for — leaving it to the slot draw meant it never appeared at all. */
export const BURNOUT_GROUPS = ['glutes','quads','hamstrings','calves'];
/* Substitute across patterns when the pattern itself has no loadable option — a band triceps
   pressdown has no loadable same-pattern peer in the bank, and dropping it cost Push its only
   direct arm work and left the day three movements shorter than the others. */
export function loadableFor(m, inUse, seed, ctx){
  const _s = pgCtx(ctx);
  const usable = x => !inUse.has(x.n) && !isBandMove(x) && equipPick(x).include &&
    !(x.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1);
  const draw = (pool)=>{
    if(!pool.length) return null;
    pool.sort((a, b)=> (b.tier || 2) - (a.tier || 2));
    return pool[Math.abs(seed) % Math.max(1, Math.min(4, pool.length))] || pool[0];
  };
  /* pickForSlot scores the whole pattern and can hand back the band movement itself, so the
     pattern is searched directly against the bank with bands excluded first. Skipping this
     turned a band triceps pressdown into forearm and grip work, because 'arms' is one tag
     shared by biceps, triceps and forearm. */
  const samePattern = draw(BANK.filter(x=>x.p === m.p && usable(x)));
  if(samePattern) return samePattern;
  const alt = pickForSlot(m.p, seed, inUse, null, wantedGroups(), false, _s);
  if(alt && !isBandMove(alt)) return alt;
  /* No loadable movement shares the pattern. Fall back on the muscle group, but prefer a
     candidate from the same pattern family so triceps work is replaced by triceps work. */
  const groups = m.g || [], fam = String(m.p || '').split('_')[0];
  const byGroup = BANK.filter(x=>usable(x) && (x.g || []).some(g=>groups.indexOf(g) > -1));
  return draw(byGroup.filter(x=>String(x.p || '').split('_')[0] === fam)) || draw(byGroup);
}
export function bandFinisherFor(list, ctx){
  const _s = pgCtx(ctx);
  const have = new Set(list.map(x=>x.name));
  const trains = new Set();
  list.forEach(x=>{ const m = byName[x.name]; (m ? m.g : []).forEach(g=>trains.add(g)); });
  if(!BURNOUT_GROUPS.some(g=>trains.has(g))) return null;      // not a lower-body day
  const pool = BANK.filter(x=>
    !have.has(x.n) && isBandMove(x) && equipPick(x).include &&
    !(x.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1) &&
    (x.g || []).some(g=>BURNOUT_GROUPS.indexOf(g) > -1));
  if(!pool.length) return null;
  const glute = pool.filter(x=>(x.g || []).indexOf('glutes') > -1);
  const pick = (glute.length ? glute : pool);
  return pick[Math.abs((genSeed() || 1) * 13 + list.length * 29) % pick.length];
}
export function pairBandWork(list, ctx){
  const _s = pgCtx(ctx);
  const kept = [], inUse = new Set(list.map(x=>x.name));
  list.forEach((item, idx)=>{
    const m = byName[item.name] || item;
    if(!isBandMove(m)){ kept.push(item); return; }
    const alt = loadableFor(m, inUse, (genSeed() || 1) * 7 + idx * 97, _s);
    if(alt){ inUse.add(alt.n); kept.push(Object.assign({}, item, { name:alt.n, note:alt.note })); }
    /* Nothing loadable trains this at all under the current kit — leave the slot out rather
       than keep easy work in the middle of a session. */
  });
  /* pairAntagonists returns its input by reference on the non-superset early return, so emptying
     kept before reading it wiped both. Hand it a copy — our kept is then never aliased. */
  const withPairs = pairAntagonists(kept.slice());
  kept.length = 0; withPairs.forEach(x=>kept.push(x));
  const fin = bandFinisherFor(kept, _s);
  if(fin){
    const label = (fin.g || []).indexOf('glutes') > -1 ? 'glutes' : 'legs';
    const m0 = byName[kept[kept.length - 1] && kept[kept.length - 1].name];
    const weeks = Math.max(1, weekCount());
    kept.push({ name:fin.n, burnout:true,
      targets: Array.from({ length:weeks }, ()=> '1×25+ · bodyweight · to the burn'),
      note:'Finisher — one long set for the ' + label + ', high reps to a burn. Not a working set: there is nothing to add load to, so chase the burn and stop there.' });
  }
  return kept;
}


/* Unloadable movements are moved out of the primary slots BEFORE pairing, so pairing never
   has to reorder and no superset is separated from its parent. */
/* Whether a movement can carry the front of a session. primaryOk only asks whether load can be
   added, which a landmine press satisfies — so a tier-2 accessory kept the opening slot and every
   later stage inherited it. A primary slot is only satisfied by a compound when a compound is
   available for that pattern. */
export function betterPrimaryExists(m, ctx){
  const _s = pgCtx(ctx);
  if(!m) return false;
  const mine = isBandMove(m) ? 0 : (m.tier || 2) === 1 ? 3 : 2;
  return BANK.some(x=>{
    if(x.p !== m.p || x.n === m.n) return false;
    if(!equipPick(x).include) return false;
    if((x.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1)) return false;
    if((SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(x.skill || 2) - 1] <= -50) return false;
    if(hasLoadable() && !primaryOk(x)) return false;
    const theirs = isBandMove(x) ? 0 : (x.tier || 2) === 1 ? 3 : 2;
    return theirs > mine;
  });
}
export function primaryFit(m, ctx){
  if(!m || !primaryOk(m)) return false;
  /* A band never satisfies a primary slot while anything loadable remains. */
  if(isBandMove(m) && hasLoadable() && betterPrimaryExists(m, ctx)) return false;
  if((m.tier || 2) === 1) return true;
  return !betterPrimaryExists(m, ctx);
}
/* How well a movement can carry the front of a session: a loaded compound above a loaded
   accessory, both above bodyweight, and a band last. */
export function primaryRank(m){
  if(!m) return -1;
  if(isBandMove(m)) return 0;
  const loadable = kitFor(m).some(k=>LOADABLE.indexOf(k) > -1);
  if(!loadable) return 1;
  return (m.tier || 2) === 1 ? 4 : (m.tier || 2) === 2 ? 3 : 2;
}
export function guardPrimaries(list, ctx){
  for(let i = 0; i < Math.min(2, list.length); i++){
    if(primaryFit(byName[list[i].name], ctx)) continue;
    /* Take the strongest movement left in the day rather than the first acceptable one — with
       every compound hinge filtered out by an injury, the difference is a band pull-through
       opening leg day versus a loaded single-leg movement that was already in it. */
    let j = -1, bestRank = primaryRank(byName[list[i].name]);
    for(let k = i + 1; k < list.length; k++){
      if(list[k].burnout) continue;
      const r = primaryRank(byName[list[k].name]);
      if(r > bestRank){ bestRank = r; j = k; }
    }
    if(j > -1){ const t = list[i]; list[i] = list[j]; list[j] = t; }
  }
  return list;
}

/* ── Stages ──────────────────────────────────────────────────────────────────
   A workout has to be run more than once before it means anything. Four weeks runs a stage a
   week; anything longer runs each stage twice, then shifts — same patterns and body parts,
   a different movement or the same movement under a different tempo. */
export const stageLen = () => (weekCount() <= 4 ? 1 : 2);
export const stageCount = () => Math.min(6, Math.ceil(weekCount() / stageLen()));
export function buildStagesFor(d, seedBase, ctx, totalIn){
  const _s = pgCtx(ctx);
  const _total = () => totalIn || weekCount();
  /* Stages are derived from the stored list, which already holds the finisher appended last
     time — so a new one accumulated on every version bump, and a bodyweight mobility drill
     could be left carrying a stale burnout flag beside its own working-set target. Clear both
     before deriving anything: exactly one finisher is appended per day per rebuild. */
  const base = guardPrimaries(d.exercises
    .filter(x=>!(x.burnout && isBandMove(byName[x.name] || { n:x.name })))
    .map(x=>{ const c = Object.assign({}, x); delete c.burnout; return c; }), _s);
  /* Stages are derived from the stored exercise list, so a day an earlier version left short
     would stay short for good — a rebuild of stages is not a re-draw. Top it back up from the
     regions the day already trains, the same way buildDay finishes its own draw. */
  const want = Math.min(6, Math.max(4, (state.plan || []).reduce((a, x)=>Math.max(a, (x.exercises || []).length), 0)));
  if(base.length < want){
    const have = new Set(base.map(x=>x.name));
    const regions = new Set();
    base.forEach(x=>{ const m = byName[x.name]; (m ? m.g : []).forEach(g=>regions.add(g)); });
    /* A day's region set comes from its compound lifts, so 'arms' is present on a push day
       even when nothing isolates the triceps. Filling the slot with a second lateral raise
       when one was already there added nothing — patterns already in the day are excluded, and
       a muscle with no isolation work yet is preferred over one that has some. */
    const patterns = new Set();
    const isolated = new Set();
    base.forEach(x=>{ const m = byName[x.name]; if(!m) return;
      patterns.add(m.p);
      if((m.tier || 2) >= 3) (m.g || []).forEach(g=>isolated.add(g));
    });
    const pool = BANK.filter(x=>
      !have.has(x.n) && !isBandMove(x) && equipPick(x).include && !patterns.has(x.p) &&
      !(x.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1) &&
      /* The technical ceiling applies here too. Topping a short day back up ignored it, which is
         how a beginner was handed an archer push-up. */
      (SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(x.skill || 2) - 1] > -50 &&
      (x.g || []).some(g=>regions.has(g)))
      .sort((a, b)=>{
        const fresh = y => (y.g || []).some(g=>regions.has(g) && !isolated.has(g)) ? 0 : 1;
        return fresh(a) - fresh(b) || (b.tier || 2) - (a.tier || 2);
      });
    let k = 0;
    while(base.length < want && k < pool.length){
      const m = pool[k++];
      if(have.has(m.n) || patterns.has(m.p)) continue;
      have.add(m.n); patterns.add(m.p);
      (m.g || []).forEach(g=>isolated.add(g));
      const gk = goalForTier(m.tier, m.p);
      base.push({ name:m.n, note:m.note, goal:gk,
        targets:genTargets(m.tier === 1 ? 4 : 3, gk, _total(), m.p, m.tier, d.dayIdx || 0, 0, loadKindOf(m), m.n, _s) });
    }
  }
  if(hasLoadable()){
    const held = new Set(base.map(x=>x.name));
    base.slice(0, 2).forEach((x, i)=>{
      const m = byName[x.name];
      if(!m || primaryFit(m, _s)) return;
      held.delete(x.name);
      const alt = pickForSlot(m.p, seedBase + i * 53, held, null, wantedGroups(), true, _s);
      if(alt && primaryFit(alt, _s)){ base[i] = Object.assign({}, x, { name:alt.n, note:alt.note }); held.add(alt.n); }
      else held.add(x.name);
    });
  }
  const ROTATE = 4;
  /* Each stage is reordered independently — the opener guard moves a stronger movement forward,
     and a band finisher is placed after whatever it finishes. Position therefore says nothing
     about which movement replaced which, so the slot a movement occupies is stamped on it and
     carried through every substitution. That is what makes a progression traceable. */
  base.forEach((x, i)=>{ x.slot = i; });
  const history = base.map(x=>new Set([x.name]));
  /* Where each slot currently stands. Candidates used to be judged against the stage-0 movement
     for the whole block, so stage 1 could step up to a barbell variant and stage 2 drop back to a
     dumbbell one — each defensible against the original, but a reduction in load from the week
     before it, which is the opposite of overload. Progression is monotonic: every step is judged
     against what the client actually did last, not against where they started. */
  const cur = base.map(x=>byName[x.name] || null);
  const chains = [], holds = [];
  /* A progression has to be a progression OF something: the same tissue, the same way of
     loading it, and no easier than what it replaces. Swapping a weighted movement for a
     bodyweight one, or a bodyweight one for a band, reads as variety and is actually a
     reduction in stimulus — the client loses the load they had earned and the program stops
     overloading. Modality is therefore held constant and complexity is never allowed to fall. */
  /* pickForSlot returns the single best-scoring movement for a pattern, so once the current one
     is excluded the runner-up is usually rejected by the progression test and the slot keeps
     what it had — which is why an eight-week block ran the same floor press for eight weeks.
     A slot therefore gets an ordered CHAIN of valid progressions built up front, and each stage
     takes the next link: same tissue, same way of loading it, and rising demand. */
  /* How much load a movement can ever carry. A kettlebell deadlift cannot be a progression from
     a trap-bar deadlift — the implement caps it far lower, so the client is handed less absolute
     load and calls it week five. Ranked by implement rather than by exercise so the rule holds
     across the whole bank. */
  const loadCeiling = m => {
    const k = kitFor(m);
    if(k.indexOf('barbell') > -1) return 6;
    if(k.indexOf('machines') > -1 || k.indexOf('cable') > -1) return 4;
    if(k.indexOf('dumbbell') > -1) return 4;
    if(k.indexOf('kettlebell') > -1) return 3;
    if(k.indexOf('bands') > -1) return 1;
    return 2;                                    // bodyweight
  };
  const progressionChain = (m, primary)=>{
    if(!m) return [];
    const gate = k => (SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(k || 2) - 1] > -50;
    const groups = m.g || [];
    const usable = x =>
      equipPick(x).include &&
      !(x.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1) &&
      !isBandMove(x) && gate(x.skill) &&
      loadKindOf(x) === loadKindOf(m) &&
      (x.g || []).some(g=>groups.indexOf(g) > -1) &&
      (x.tier || 2) <= (m.tier || 2) &&
      loadCeiling(x) >= loadCeiling(m) &&
      /* A main lift has to be able to carry the session. Tier 2 accessory presses — a landmine
         press, a floor press — belong after the primary work, not in front of it, so a primary
         slot only accepts a movement at least as compound as what it replaces. */
      (!primary || (x.tier || 2) <= Math.min(2, m.tier || 2)) &&
      (!primary || !hasLoadable() || primaryOk(x));
    /* Same pattern first — the closest thing to the same movement done harder. Then movements on
       the same PRIMARY muscle from a neighbouring pattern.

       Requiring every muscle group to match was too strict to be useful: a shoulder-safe floor
       press lists chest and arms, and the incline presses that could legitimately follow it list
       chest and shoulders, so nothing qualified and the slot sat on one movement for the whole
       block. An injury filter can empty a pattern by itself — with a shoulder flagged, every
       other horizontal press in the bank is contraindicated — and when it does, the progression
       has to come from a neighbouring pattern on the same tissue or it cannot come at all. */
    const same = BANK.filter(x=>x.p === m.p && x.n !== m.n && usable(x));
    const primaryGroup = groups[0];
    const kin = BANK.filter(x=>x.p !== m.p && x.n !== m.n && usable(x) &&
      (x.g || []).indexOf(primaryGroup) > -1);
    /* For a main lift, the most compound and most loadable option comes first — that is what
       progression means at the front of a session. Accessories climb by skill instead. */
    const rank = primary
      ? (a, b)=> ((a.tier || 2) - (b.tier || 2)) || (loadCeiling(b) - loadCeiling(a)) || a.n.localeCompare(b.n)
      : (a, b)=> ((a.skill || 2) - (b.skill || 2)) || ((a.tier || 2) - (b.tier || 2)) || a.n.localeCompare(b.n);
    same.sort(rank); kin.sort(rank);
    /* Start from where the current movement sits, so the chain climbs rather than restarting. */
    const startSkill = m.skill || 2;
    const ahead = same.filter(x=>(x.skill || 2) >= startSkill).concat(same.filter(x=>(x.skill || 2) < startSkill));
    return ahead.concat(kin);
  };
  const progressionOK = (from, to)=>{
    if(!from || !to) return false;
    if(loadKindOf(to) !== loadKindOf(from)) return false;      // weighted stays weighted
    if(isBandMove(to) && !isBandMove(from)) return false;       // never progress into a band
    const g1 = from.g || [], g2 = to.g || [];
    if(!g2.some(g=>g1.indexOf(g) > -1)) return false;           // same tissue
    if((to.tier || 2) > (from.tier || 2)) return false;         // never less demanding
    if(loadCeiling(to) < loadCeiling(from)) return false;        // never a lighter implement
    const need = k => kitFor(to).indexOf(k) > -1;
    if(kitFor(from).some(k=>LOADABLE.indexOf(k) > -1) && !kitFor(to).some(k=>LOADABLE.indexOf(k) > -1)) return false;
    return true;
  };
  d.stages = [pairBandWork(guardPrimaries(base.map(x=>Object.assign({}, x)), _s), _s)];
  for(let st = 1; st < stageCount(); st++){
    /* One set per stage, shared across slots — rebuilding it per slot let two slots on the
       same pattern both take the winner, and the movement appeared twice. It holds the
       accessories plus everything already chosen this stage, and NOT the whole base list,
       which used to empty the pool and freeze the main lift. */
    const chosen = new Set(base.slice(ROTATE).map(x=>x.name));
    const list = base.map((x, i)=>{
      const m = byName[x.name];
      if(!m || i >= ROTATE) return Object.assign({}, x);
      const taken = new Set(chosen);
      history[i].forEach(nm=>taken.add(nm));
      const chain = chains[i] || (chains[i] = progressionChain(m, i < 2));
      const from = cur[i] || m;
      /* The next link this slot has not used, that nothing else this stage has taken, and that is
         a step up from where the slot stands now. */
      let alt = chain.find(c=>!history[i].has(c.n) && !taken.has(c.n) &&
        progressionOK(m, c) && progressionOK(from, c)) || null;
      if(!alt){
        const p = pickForSlot(m.p, seedBase + st * 911 + i * 37, taken, null, wantedGroups(), i < 2, _s);
        if(p && !history[i].has(p.n) && progressionOK(m, p) && progressionOK(from, p)) alt = p;
      }
      const fit = !!alt;
      /* Nothing legitimate to move to — every alternative on this tissue is contraindicated by a
         flagged injury, missing from the kit, or beyond this experience level. The movement holds
         and progresses by execution instead. */
      if(!fit && st === 1 && chain.length === 0) holds[i] = true;
      if(fit){
        history[i].add(alt.n); chosen.add(alt.n); cur[i] = alt;
        return Object.assign({}, x, { name:alt.n, note:alt.note });
      }
      /* Nothing left to progress to. HOLD where the slot stands — returning the stage-0 item, as
         this used to, sent week nine back to the week-one movement: a barbell bench earned in the
         middle of the block became a pec deck again, which is a reduction in load dressed up as
         variety. A slot that runs out of progressions keeps what it reached and advances by sets,
         reps, load and execution instead. */
      const stay = cur[i] || byName[x.name];
      const mm = stay || byName[x.name];
      chosen.add(mm ? mm.n : x.name);
      const sets = parseInt(String((x.targets || [])[0] || ''), 10) || (mm && mm.tier === 1 ? 4 : 3);
      const gk = mm ? goalForTier(mm.tier, mm.p) : (x.goal || primaryGoal());
      const next = mm ? genTargets(sets, gk, _total(), mm.p, mm.tier, d.dayIdx || 0, st, loadKindOf(mm), mm.n, _s) : null;
      return Object.assign({}, x,
        mm ? { name:mm.n, note:mm.note, goal:gk } : {},
        next && next.length ? { targets:next } : {});
    });
    d.stages.push(pairBandWork(guardPrimaries(list, _s), _s));
  }
  /* Enforce the progression invariant on the finished stages, not only at the moment a candidate
     is chosen. Selection is one of several paths that can set a slot's movement — the chain, the
     scored fallback, the top-up fill, the opener guard — and a rule applied inside just one of
     them is a rule that holds most of the time. Checked here, against the stage before it and by
     slot, it holds for every path: any slot that came out easier than the week before reverts to
     what it had, which is always safe. */
  for(let s = 1; s < d.stages.length; s++){
    const prev = {};
    d.stages[s - 1].forEach(x=>{ if(x.slot !== undefined) prev[x.slot] = x; });
    d.stages[s] = d.stages[s].map(x=>{
      const was = prev[x.slot];
      if(!was || was.name === x.name) return x;
      const from = byName[was.name], to = byName[x.name];
      if(!from || !to || progressionOK(from, to)) return x;
      const gk = from.goal || goalForTier(from.tier, from.p);
      const sets = parseInt(String((was.targets || [])[0] || ''), 10) || (from.tier === 1 ? 4 : 3);
      const next = genTargets(sets, gk, _total(), from.p, from.tier, d.dayIdx || 0, s, loadKindOf(from), from.n, _s);
      return Object.assign({}, x, { name:from.n, note:from.note, goal:gk },
        next && next.length ? { targets:next } : {});
    });
  }
  /* Three structural invariants, checked on every finished stage for the same reason the
     progression rule above is: five different code paths can set a slot's movement, and a rule
     enforced inside one of them holds only most of the time.

     A stage that violates one of these is not merely untidy. Two rungs of the same drill ladder
     in one session is the same drill twice, with the harder rung prescribed to someone who has
     not shown they own the easier one. Explosive work behind heavy strength work is a jump
     performed on a fatigued athlete, and rate of force development and landing mechanics both
     fall with fatigue — that is the mechanism behind most plyometric injury. And a movement
     listed twice is a set count nobody intended.

     Held slots and the progression chain's cross-pattern candidates are what let these through:
     a slot that holds is not in the stage's chosen set, and a hinge can legitimately progress to
     a hang power clean, which changes the movement's demand class and so its correct position. */
  for(let s = 0; s < d.stages.length; s++){
    const seenName = new Set(), seenFam = new Set(), kept = [];
    d.stages[s].forEach(x=>{
      const m = byName[x.name];
      const l = m ? ladderOf(m.n) : null;
      if(seenName.has(x.name)) return;                    // the same movement twice
      if(l && seenFam.has(l.fam)) return;                  // a second rung of one ladder
      seenName.add(x.name);
      if(l) seenFam.add(l.fam);
      kept.push(x);
    });
    /* Explosive first, then Olympic, then the rest — each group holding its relative order, and
       a band finisher staying behind whatever it finishes. */
    const demand = x=>{
      if(x.ssAfter) return 3;
      const m = byName[x.name];
      if(!m) return 2;
      return /^plyo/.test(m.p || '') ? 0 : (m.p === 'oly' ? 1 : 2);
    };
    /* Length is checked per stage, not only on the day it was drawn from. A stage regenerates
       its prescriptions, so a later stage can carry more sets than the one before it and run past
       the session ceiling — the trim has to happen where the sets actually are. Ordering first, so
       the trim takes from the accessories rather than the opening lift. */
    d.stages[s] = fitDayToTime(kept
      .map((x, i)=>({ x, i, d:demand(x) }))
      .sort((a, b)=> a.d - b.d || a.i - b.i)
      .map(o=>o.x), peakWeek(s));
  }
  /* Guardrail: no stage may ship empty when the day had movements to begin with. Any transform
     above that returns nothing falls back to the base list rather than handing over a blank day. */
  if(base.length){
    d.stages = d.stages.map(s => (s && s.length) ? s : guardPrimaries(base.map(x=>Object.assign({}, x)), _s));
  }
  d.exercises = d.stages[0];
}
/* Point every day at the stage the shown week belongs to. Assigned by reference, so a swap
   the lifter keeps is written into that stage and survives the next visit. */
export const GOAL_MODELS = {
  hypertrophy: { label:'Muscle size', weeks:[
    {name:'Build-up', rpe:7, reps:'×10–12', note:''},
    {name:'Short rests', rpe:8, reps:'×12', note:''},
    {name:'Heavier', rpe:8, reps:'×8–10', note:''},
    {name:'Easy week', rpe:'RPE 5–6', reps:'×10', note:'stop well short of hard'} ]},
  strength: { label:'Strength', weeks:[
    {name:'Base', rpe:7, reps:'×6', note:''},
    {name:'Heavy', rpe:8, reps:'×4', note:'heavy'},
    {name:'Heaviest', rpe:9, reps:'×3', note:'your hardest sets'},
    {name:'Easy week', rpe:'RPE 5', reps:'×5', note:'light and quick'} ]},
  health: { label:'Health & resilience', weeks:[
    {name:'Foundation', rpe:6, reps:'×10', note:'move slowly and in control'},
    {name:'Stamina', rpe:7, reps:'×12–15', note:''},
    {name:'Slow tempo', rpe:7, reps:'×12', note:'take 3s to lower each rep'},
    {name:'Easy week', rpe:'RPE 5', reps:'×10', note:'easy'} ]},
  power: { label:'Speed & power', weeks:[
    {name:'Base', rpe:7, reps:'×5', note:'controlled'},
    {name:'Heavy', rpe:8, reps:'×3–5', note:'heavy'},
    {name:'Explosive', rpe:7, reps:'×3–5', note:'move as fast as you can'},
    {name:'Easy week', rpe:'RPE 5–6', reps:'×3', note:'fast and fresh, very light'} ]}
};
export const EXP_ADJ = {
  beginner:{ label:'New to this', rpeShift:-1,
    blurb:'Machines and straightforward movements that are easy to learn, at an easier effort. Nothing that takes months of practice to do safely.' },
  intermediate:{ label:'Comfortable in the gym', rpeShift:0,
    blurb:'The usual barbell and dumbbell exercises at a normal training effort.' },
  advanced:{ label:'Experienced', rpeShift:1,
    blurb:'The harder skills too: olympic-style pulls, single-leg work and jumping.' }
};
export const GROUPS = {
  chest:{ label:'Chest', re:/bench|dip|fly|pec|push-up|chest throw|floor press|incline .*press|crossover/i },
  back:{ label:'Back', re:/pull-?up|pulldown|row|straight-arm|pullover|pull-apart|y-t-w|clean/i },
  shoulders:{ label:'Shoulders', re:/shoulder press|overhead press|lateral raise|face pull|rear-delt|reverse pec|push press|external rotation|landmine|z-press/i },
  arms:{ label:'Arms', re:/curl|triceps|pressdown|skull|close-grip/i, not:/leg curl|hamstring curl|ham curl|nordic/i },
  quads:{ label:'Quads', re:/squat|leg press|leg extension|step[- ]?up|lunge|step[- ]?down|sissy|depth drop|box jump/i },
  hamstrings:{ label:'Hamstrings', re:/romanian|leg curl|hamstring|nordic|deadlift|back extension|good morning|slider/i },
  glutes:{ label:'Glutes', re:/hip thrust|glute|kickback|abduction|frog|bulgarian|step[- ]?up|lunge|romanian|swing|cossack/i },
  calves:{ label:'Calves', re:/calf|tibialis|pogo/i },
  core:{ label:'Core', re:/plank|pallof|dead bug|bird dog|carry|leg raise|copenhagen|rollout|woodchop|slam|rotational throw/i }
};
export const groupHit = (g,name) => GROUPS[g].re.test(name) && !(GROUPS[g].not && GROUPS[g].not.test(name));
export const groupsOf = name => Object.keys(GROUPS).filter(g=>groupHit(g,name));
export function nameWords(n){ return String(n).toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean); }
export function sameLift(a,b){
  const A=new Set(nameWords(a)), B=new Set(nameWords(b));
  const small = A.size<=B.size?A:B, big = A.size<=B.size?B:A;
  let hit=0; small.forEach(w=>{ if(big.has(w)) hit++; });
  return small.size>0 && hit===small.size;
}
export const dupOf = (list,name) => list.some(x=>sameLift(x.n||x.name,name));

/* ══════════ MOVEMENT BANK ══════════
   [ name, pattern, groups, tier(1 compound…3 isolation), home-viable, injuries it loads, note ] */
export const BANK = [
['Barbell Bench Press','hpress','chest,arms',1,0,'shoulder','Primary horizontal press — the load ceiling for chest mass'],
['DB Bench Press','hpress','chest,arms',1,0,'shoulder','Freer shoulder path than the bar, deeper stretch'],
['Neutral-Grip DB Floor Press','hpress','chest,arms',2,0,'','Limited range — the shoulder-friendly press'],
['Machine Chest Press','hpress','chest',2,0,'','Stable path, easy to push close to failure'],
['Push-up Variation','hpress','chest,core',2,1,'','Feet on a step or hands on books to keep it hard'],
['Weighted Dip','dip','chest,arms',1,0,'shoulder,elbow','Lower chest and triceps in a deep stretch'],
['Chair or Step Dip','dip','chest,arms',2,1,'shoulder,elbow','Hands on a chair edge, heels on the floor'],
['Incline Barbell Press','ipress','chest,shoulders',1,0,'shoulder','Upper chest under a barbell load'],
['Incline DB Press','ipress','chest,shoulders',1,0,'','Upper-chest bias; the DB path is shoulder-friendly'],
['Low-Incline DB Press','ipress','chest',2,0,'','Between flat and incline — clavicular fibres'],
['Landmine Press','ipress','shoulders,chest',2,0,'','Angled press that most shoulders tolerate'],
['Standing Overhead Press','vpress','shoulders,core',1,0,'shoulder,lowback','Whole-body vertical press'],
['Seated DB Shoulder Press','vpress','shoulders',1,0,'shoulder','Delt hypertrophy with a supported spine'],
['Half-Kneeling DB Press','vpress','shoulders,core',2,0,'shoulder','Vertical press that demands trunk control'],
['Machine Shoulder Press','vpress','shoulders',2,0,'shoulder','Fixed path — safe to take near failure'],
['Z-Press','vpress','shoulders,core',3,0,'shoulder,lowback','Seated on the floor — no leg drive to hide behind'],
['Push Press','vpress','shoulders,core',1,0,'shoulder','Triple extension into a vertical press'],
['Cable Fly','chest_iso','chest',2,0,'shoulder','Loads the chest in the lengthened position'],
['Pec Deck','chest_iso','chest',2,0,'shoulder','Constant tension through the arc'],
['DB Fly','chest_iso','chest',3,0,'shoulder','Stretch-biased chest isolation'],
['Cable Crossover','chest_iso','chest',3,0,'','Upper-chest fibres at peak contraction'],
['Weighted Pull-up','vpull','back,arms',1,0,'elbow','Primary vertical pull — lat width'],
['Lat Pulldown','vpull','back',1,0,'','A scalable vertical pull you can grind'],
['Neutral-Grip Chin-up','vpull','back,arms',2,0,'elbow','Elbow-friendly grip, more biceps'],
['Band Pulldown','vpull','back',2,1,'','Vertical pull without a cable stack'],
['Straight-Arm Pulldown','pullover','back',3,1,'','Isolates the lats through a full arc'],
['DB Pullover','pullover','back,chest',3,0,'shoulder','Lats in a deep overhead stretch'],
['Barbell Row','hpull','back',1,0,'lowback','The heaviest horizontal pull — costs low back'],
['Chest-Supported Row','hpull','back',1,0,'','Mid-back thickness with zero low-back load'],
['Single-Arm DB Row','hpull','back,core',1,0,'','Unilateral lat work plus anti-rotation'],
['Seated Cable Row','hpull','back',2,0,'','Constant tension, easy to control'],
['Inverted Row','hpull','back,core',2,1,'','Bodyweight horizontal pull, scaled by angle'],
['Meadows Row','hpull','back',3,0,'lowback','Landmine row — a strong stretch on the lat'],
['Machine Row','hpull','back',2,0,'','A stable path for high-volume back work'],
['Cable Lateral Raise','delt_side','shoulders',2,0,'','Medial delt under constant tension'],
['DB Lateral Raise','delt_side','shoulders',2,0,'','Shoulder width — high reps, no swinging'],
['Lean-Away Lateral Raise','delt_side','shoulders',3,0,'','Lateral work in the lengthened position'],
['Face Pull','delt_rear','shoulders,back',2,1,'','Rear delt, external rotators, lower traps'],
['Rear-Delt Fly','delt_rear','shoulders',2,0,'','Posterior delt volume'],
['Reverse Pec Deck','delt_rear','shoulders',3,0,'','Rear delt with a fixed, stable path'],
['Band Pull-Apart','delt_rear','shoulders',3,1,'','Scapular health, endless reps'],
['Band External Rotation','cuff','shoulders',3,1,'','Cuff strength through a pain-free arc'],
['Prone Y-T-W','cuff','shoulders',3,1,'','Scapular control and lower traps'],
['Incline DB Curl','bi','arms',2,0,'elbow','Biceps long head in a stretched position'],
['Barbell or EZ Curl','bi','arms',2,0,'elbow','The heaviest biceps loading'],
['Hammer Curl','bi','arms',2,0,'','Brachialis and brachioradialis for thickness'],
['Cable Curl','bi','arms',3,0,'','Constant tension top to bottom'],
['Preacher Curl','bi','arms',3,0,'elbow','No swing — pure short-head work'],
['Reverse Curl','forearm','arms',3,0,'','Forearm extensors and elbow tendon health'],
['Wrist Extensor Eccentrics','forearm','arms',3,1,'','Slow lowers — the standard tendon protocol'],
['Overhead Cable Triceps Ext','tri','arms',2,0,'elbow','Long head trained stretched'],
['Overhead DB Triceps Ext','tri','arms',2,0,'elbow','The same stretch with one dumbbell'],
['Triceps Pressdown','tri','arms',2,0,'elbow','Lateral head; easy to accumulate volume'],
['Skull Crusher','tri','arms',3,0,'elbow','Heavy long-head work — watch the elbows'],
['Close-Grip Bench Press','tri','arms,chest',2,0,'elbow','Compound triceps loading'],
['Band Pressdown','tri','arms',3,1,'','Home triceps volume'],
['Back Squat','squat','quads,glutes',1,0,'lowback,knee','Primary bilateral quad and glute compound'],
['Front Squat','squat','quads,core',1,0,'lowback,knee','More upright — quad-dominant, core-taxing'],
['Hack Squat','squat','quads',1,0,'knee','Quad overload with the spine supported'],
['Safety-Bar Squat','squat','quads,glutes',2,0,'lowback,knee','Kinder to the shoulders than a straight bar'],
['Belt Squat','squat','quads,glutes',2,0,'knee','The squat pattern with no spinal load'],
['Goblet Squat','squat','quads,glutes',2,0,'knee','Upright torso, knee-friendly, teaches depth'],
['Conventional Deadlift','hinge','hamstrings,back',1,0,'lowback,hamstring','A maximal pull through the whole posterior chain'],
['Trap Bar Deadlift','hinge','hamstrings,quads',1,0,'lowback','A spine-friendlier bar path'],
['Romanian Deadlift','hinge','hamstrings,glutes',1,0,'lowback,hamstring','Hamstrings loaded in the stretch'],
['Single-Leg RDL','hinge','hamstrings,glutes,core',2,0,'hamstring','Unilateral hinge with a balance demand'],
['Good Morning','hinge','hamstrings',3,0,'lowback,hamstring','A heavy hip hinge — load it conservatively'],
['45° Back Extension','hinge','hamstrings,glutes',2,0,'','Hip extension in a short, safe range'],
['Kettlebell Swing','hinge','glutes,hamstrings',2,0,'lowback,hamstring','A ballistic hinge — power and conditioning'],
['Bulgarian Split Squat','lunge','quads,glutes',1,1,'knee','Unilateral quad and glute; exposes asymmetry'],
['Walking Lunge','lunge','quads,glutes',2,1,'knee','Long-stride unilateral work'],
['Reverse Lunge','lunge','glutes,quads',2,1,'knee','Less knee shear than lunging forward'],
['DB Step-Up','lunge','glutes,quads',2,0,'knee','Single-leg strength and balance'],
['Split Squat','lunge','quads,glutes',2,1,'knee','Stable unilateral loading, rear foot down'],
['Lateral Step-Down','lunge','quads',3,1,'knee','Eccentric knee control — patellofemoral health'],
['Leg Press','legpress','quads,glutes',2,0,'','High quad volume with the spine supported'],
['Leg Extension','quad_iso','quads',2,0,'knee','Quad isolation to a hard last rep'],
['Spanish Squat','quad_iso','quads',3,1,'','A banded isometric — tendon-friendly'],
['Sissy Squat','quad_iso','quads',3,1,'knee','Rectus femoris under a deep stretch'],
['Wall Sit','quad_iso','quads',3,1,'','Isometric quad work with no joint speed'],
['Lying Leg Curl','ham_iso','hamstrings',2,0,'hamstring','Knee-flexion hamstring work'],
['Seated Leg Curl','ham_iso','hamstrings',2,0,'hamstring','Hamstrings in a lengthened position'],
['Nordic Curl','ham_iso','hamstrings',3,1,'hamstring','Eccentric hamstring strength, no equipment'],
['Slider Leg Curl','ham_iso','hamstrings',3,1,'','Heels on towels or socks on a smooth floor'],
['Slow-Eccentric Leg Curl','ham_iso','hamstrings',3,1,'','Four-second lowering — rebuilds tolerance'],
['Barbell Hip Thrust','glute','glutes',1,0,'','Peak-contraction glute loading'],
['DB Hip Thrust','glute','glutes',2,0,'','The same pattern with a dumbbell'],
['Cable Kickback','glute','glutes',3,0,'','Glute max in isolation'],
['Hip Abduction','glute','glutes',3,0,'','Glute medius — hip stability'],
['Frog Pump','glute','glutes',3,1,'','A high-rep glute finisher'],
['Copenhagen Plank','adductor','core,glutes',3,1,'','Adductor strength — groin-injury prevention'],
['Cossack Squat','adductor','quads,glutes',3,1,'knee','Loaded lateral range through the adductors'],
['Adductor Machine','adductor','glutes',3,0,'','Direct adductor loading'],
['Standing Calf Raise','calf','calves',2,1,'','Gastrocnemius through a full range'],
['Seated Calf Raise','calf','calves',2,0,'','Soleus, with the knee bent'],
['Single-Leg Calf Raise','calf','calves',3,1,'','Unilateral Achilles capacity'],
['Heavy Slow Calf Raise','calf','calves',3,0,'','Heavy slow resistance — the tendon protocol'],
['Tibialis Raise','tib','calves',3,1,'','Shin health and deceleration'],
['Pallof Press','core_anti_rot','core',2,1,'','Anti-rotation — the trunk resists'],
['Cable Woodchop','core_anti_rot','core',3,0,'lowback','Rotational control under load'],
['Bird Dog','core_anti_rot','core',3,1,'','Contralateral stability and coordination'],
['Dead Bug','core_anti_ext','core',2,1,'','Anti-extension with a neutral spine'],
['Plank','core_anti_ext','core',3,1,'','Anti-extension endurance'],
['Ab Wheel Rollout','core_anti_ext','core',3,0,'lowback','Hard anti-extension'],
['Hanging Leg Raise','core_flex','core',2,0,'','Anterior core on a long lever'],
['Side Plank','core_anti_lat','core',3,1,'','Anti-lateral-flexion; glute med and QL'],
['Suitcase Carry','carry','core',2,0,'','Anti-lateral-flexion plus grip'],
['Farmer Carry','carry','core',2,0,'','Trunk stiffness, grip, total-body tension'],
['Trap Bar Jump','plyo_lower','quads,glutes',1,0,'lowback,knee,achilles','A loaded jump — high rate of force development'],
['Broad Jump','plyo_lower','quads,glutes',2,1,'knee,achilles,hamstring','Horizontal power; teaches landing'],
['Box Jump','plyo_lower','quads,glutes',2,1,'knee,achilles','Concentric power with a soft landing'],
['Pogo Hops','plyo_lower','calves',3,1,'achilles,knee','Reactive ankle stiffness — elastic recoil'],
['Depth Drop','plyo_lower','quads',3,1,'knee,achilles','Landing mechanics under gravity'],
['Med-Ball Chest Throw','plyo_upper','chest,shoulders',2,0,'shoulder','Upper-body RFD with no deceleration'],
['Med-Ball Rotational Throw','plyo_upper','core',2,0,'lowback','Rotational power through hips and trunk'],
['Med-Ball Slam','plyo_upper','core',3,0,'lowback','Full-body extension into flexion'],
['Hang Power Clean','oly','back,quads',1,0,'lowback,shoulder','Explosive triple extension under a bar'],
['Band Chest Press','hpress','chest,arms',2,1,'','Anchored band press — tension peaks at lockout'],
['Archer Push-up','hpress','chest,arms',2,1,'','Shifts most of the load onto one arm'],
['Decline Push-up','ipress','chest,shoulders',2,1,'','Feet on a step — biases the upper chest'],
['Band Incline Press','ipress','chest,shoulders',2,1,'','Band anchored low, pressing up and away'],
['Band Fly','chest_iso','chest',3,1,'shoulder','Chest isolation with the band behind you'],
['Pike Push-up','vpress','shoulders,core',2,1,'shoulder','Bodyweight vertical press — hips high'],
['Elevated Pike Push-up','vpress','shoulders',3,1,'shoulder','Feet on a step for a steeper press angle'],
['Band Overhead Press','vpress','shoulders',2,1,'shoulder','Stand on the band and press overhead'],
['Band Row','hpull','back',2,1,'','Anchored band row — squeeze and hold'],
['Single-Arm Band Row','hpull','back,core',2,1,'','Unilateral pull with an anti-rotation demand'],
['Table Row','hpull','back,core',2,1,'','Lie under a sturdy table and row your chest to the edge'],
['Band Lateral Raise','delt_side','shoulders',2,1,'','Stand on the band — tension builds as you raise'],
['Band Rear-Delt Fly','delt_rear','shoulders',2,1,'','Rear delts with the band anchored in front'],
['Band Curl','bi','arms',2,1,'','Stand on the band; slow on the way down'],
['Band Hammer Curl','bi','arms',2,1,'','Neutral grip — brachialis and forearm'],
['Band Overhead Triceps Ext','tri','arms',2,1,'elbow','Band behind you, elbows high and still'],
['Bodyweight Squat','squat','quads,glutes',2,1,'knee','Slow tempo and a pause to make it count'],
['Band Squat','squat','quads,glutes',2,1,'knee','Band over the shoulders, standing on it'],
['Step-Up','lunge','glutes,quads',2,1,'knee','Stairs or a sturdy chair — drive through the top foot'],
['Skater Hop','lunge','glutes,quads',3,1,'knee,achilles','Lateral bound, stick the landing'],
['Band Good Morning','hinge','hamstrings,glutes',2,1,'lowback,hamstring','Band over the shoulders, hips travel back'],
['Band Pull-Through','hinge','glutes,hamstrings',2,1,'','Band between the legs — hinge and snap the hips'],
['Prone Back Extension','hinge','hamstrings,glutes',3,1,'','Face down on the floor, lift the chest and legs'],
['Single-Leg Glute Bridge','glute','glutes',2,1,'','One foot on the floor, hips level throughout'],
['Band Hip Thrust','glute','glutes',2,1,'','Shoulders on a chair, band across the hips'],
['Banded Hip Abduction','glute','glutes',3,1,'','Loop above the knees — glute medius'],
['Stair Calf Raise','calf','calves',2,1,'','Heels off the step for a full stretch'],
['Band Woodchop','core_anti_rot','core',3,1,'','Rotational control against the band'],
['Hollow Hold','core_anti_ext','core',3,1,'','Lower back pressed flat — hold the shape'],
['Reverse Crunch','core_flex','core',3,1,'','Knees to chest, no swinging'],
['Clap Push-up','plyo_upper','chest,shoulders',2,1,'shoulder','Explosive push-up — leave the floor'],
['Band Speed Press','plyo_upper','chest,shoulders',3,1,'','Light band, maximum intent on every rep'],
['Band-Resisted March','carry','core',3,1,'','Band at the waist, march tall and slow'],
/* ── Rehab and mobility library ── */
['1/2 Kneel Hamstring Curl','ham_iso','hamstrings',3,1,'','Half-kneeling heel drag — hamstring control in a stable base',2,'mobkit'],
['1/2 Kneel Windmills','mob_t','core,shoulders',3,1,'','Thoracic rotation with shoulder and hip stability',2,''],
['1/2 Kneeling Lateral Flexion','mob_t','core',3,1,'','QL and lateral trunk chain through side-bend',1,''],
['1/2 Kneeling Open Books','mob_t','core,shoulders',3,1,'','Wall-supported thoracic rotation',1,''],
['1/2 Kneeling Thoracic Rotation','mob_t','core,shoulders',3,1,'','Rotation into the wall with scapular control',1,''],
['3-Way Lunge Sliders','lunge','quads,glutes',2,1,'knee','Multiplanar hip and quad control on a slider',3,'mobkit'],
['3-Way Calf Stretch','mob_ankle','calves',3,1,'','Gastroc, soleus and posterior ankle in three positions',1,''],
['90/90 Hip ER','mob_hip','glutes',3,1,'','Hip external rotation and capsule',1,''],
['90/90 Hip IR to ER','mob_hip','glutes',3,1,'','Windshield-wiper rotation, both directions',2,''],
['90/90 Shin Box','mob_hip','glutes,core',3,1,'','Hip rotation plus a get-up to tall kneeling',2,''],
['Adductor Hip Hinge','adductor','hamstrings,glutes',3,1,'hamstring','Inner-thigh length inside a hinge',2,''],
['Ankle DF Mobilization','mob_ankle','calves',3,0,'','Band glide restoring ankle dorsiflexion',2,'bands'],
['Arch Doming','foot','calves',3,1,'','Short-foot drill for the medial arch',1,''],
['Assisted SL Heel Raise','calf','calves',3,1,'achilles','Single-leg calf raise with hands assisting the way up',1,''],
['Banded Snow Angels','scap','shoulders',3,1,'','Scapular upward rotation under band tension',1,'bands'],
['Banded Wrist Pronation','forearm','arms',3,1,'elbow','Pronation work for the tennis-elbow tendons',1,'bands'],
['Bosu Plank','core_anti_ext','core,shoulders',3,0,'','Anti-extension plank on an unstable surface',2,''],
['Bow and Arrow w/ Serratus Press','scap','shoulders,back',3,1,'','Serratus punch on one side, bowstring pull on the other',2,'bands'],
['Captain Morgan','lunge','quads,glutes',2,1,'knee','Single-leg squat with the opposite knee pressing a wall',2,''],
['Cervical SNAG','neck','core',3,1,'','Self-glide with active cervical rotation',2,''],
['Chaos Bird Dog','core_anti_rot','core',3,1,'','Bird dog with a band adding perturbation',2,'bands'],
['Curtsey Lunge','lunge','glutes,quads',2,1,'knee','Crossing lunge for glute med and frontal-plane control',2,''],
['Dead Bug Isometric','core_anti_ext','core',3,1,'','Held dead-bug position — lumbopelvic control',1,''],
['Dead Hang','vpull','back,arms',3,0,'','Shoulder decompression and grip endurance',1,'pullupbar'],
['Depth Jump','plyo_lower','quads,glutes,calves',1,0,'knee,achilles','Step off, land, rebound immediately — advanced reactive work',3,'bench'],
['Drop Jump','plyo_lower','quads,glutes',2,0,'knee','Absorb the landing quietly in an athletic position',3,'bench'],
['Dynamic Stretching','mob_gen','core',3,1,'','Active range through leg swings, lunges and arm circles',1,''],
['Eccentric Hip Flexion','hipflex','quads',3,1,'','Slow lowering of the raised thigh against resistance',2,'bands'],
['Elbow CARs','mob_gen','arms',3,1,'','Controlled elbow and forearm rotations for joint health',1,''],
['Elevated Pigeon Stretch','mob_hip','glutes',3,0,'','Figure-4 on a bench, hinging forward',1,'bench'],
['ER Walkouts','cuff','shoulders',3,1,'','Hold external rotation while stepping away from the anchor',2,'bands'],
['Front-Foot-Elevated Split Squat','lunge','quads',2,1,'knee','Quad-biased split squat through a deeper knee range',2,''],
['Figure 4 Rotations','mob_hip','glutes,core',3,1,'','Hook-lying figure-4 rotated side to side',1,''],
['Foam Roller Angels','mob_t','shoulders,core',3,1,'','Overhead reach, T and snow angel along a roller',1,'mobkit'],
['Forearm Roller','forearm','arms',3,0,'elbow','Wrist roller up and down under control',1,''],
['Frog Stretch on Sliders','mob_hip','glutes',3,1,'','Knees wide, rocking the hips back on sliders',1,'mobkit'],
['Hamstring Isometric w/ Ball','ham_iso','hamstrings,glutes',3,1,'hamstring','Bridge with the heel digging into a ball',1,''],
['Heel-Elevated Wall Squat','quad_iso','quads',3,1,'knee','Heels raised, held at about sixty degrees',1,''],
['Hip Airplane','hiprot','glutes,core',3,1,'','Single-leg rotational control over the stance hip',3,''],
['Hip CARs','mob_hip','glutes',3,1,'','Full-range hip circles under tension',2,''],
['Jefferson Curl','hinge','hamstrings,back',3,0,'lowback,hamstring','Segmental spinal flexion under light load — progress slowly',3,'dumbbell'],
['KB Deadlift','hinge','hamstrings,glutes,back',1,0,'lowback','Hinge to the bell between the feet, hips drive through',2,'kettlebell'],
['Knee Extension Isometric','quad_iso','quads',3,1,'knee','Held knee extension for the patellar tendon',1,''],
['Lateral Bounding','plyo_lower','quads,glutes',2,0,'knee','Bound side to side, sticking each landing',3,''],
['Lateral Lunge Sliders','adductor','glutes,quads',2,1,'','Slide out into a lateral lunge and pull back',2,'mobkit'],
['Lateral Weight Shift w/ Ball','balance','quads,glutes',3,0,'knee','Frontal-plane loading with a med-ball reach',2,'medball'],
['Lumbar Extension','mob_gen','back',3,1,'','Prone press-ups into lumbar extension',1,''],
['Monster Walk','hipabd','glutes',3,1,'','Banded diagonal steps holding tension and alignment',1,'bands'],
['Open Books','mob_t','core,shoulders',3,1,'','Side-lying rotation, chest opening to the ceiling',1,''],
['Overhead Lat Stretch','mob_gen','back',3,1,'','Hang off an anchor and sink the hips back',1,'bands'],
['Overhead Squat','squat','quads,shoulders,core',1,0,'shoulder,knee','Bar overhead through a full squat — a mobility test as much as a lift',3,'barbell'],
['Overhead Carry','carry','shoulders,core',2,0,'shoulder','Load locked out overhead, braced and tall',2,'dumbbell'],
['PAILs and RAILs','mob_gen','glutes,shoulders',3,1,'','Push into the stretch, then pull deeper into range',3,''],
['Pallof Walkout','core_anti_rot','core',3,1,'','Step away from the anchor while resisting rotation',2,'bands'],
['Plantarflexion Isometric','calf','calves',3,1,'achilles','Held heel raise for Achilles loading',1,''],
['Prone Snow Angels','scap','shoulders,back',3,1,'','Face-down snow angel, thumbs up, arms off the floor',1,''],
['Prone Swimmers','scap','shoulders,back',3,0,'','Retract, hover, then sweep the arms overhead',2,''],
['Pull-Apart with External Rotation','cuff','shoulders,back',3,1,'','Band pulled apart finishing in external rotation',1,'bands'],
['Push-Up with Rotation','hpress','chest,core',2,1,'shoulder,lowback','Push-up rotating into a side plank each rep',2,''],
['Quad Burners','quad_iso','quads',3,1,'knee','Weight fixed on one leg while the other taps front and back',1,''],
['Quadruped Chin Tuck','neck','core',3,1,'','Deep neck flexor endurance against gravity',1,''],
['Rotator Cuff Isometrics','cuff','shoulders',3,1,'','Held presses into a wall or band in each direction',1,''],
['Reverse Nordic Curl','quad_iso','quads',3,1,'knee','Tall kneeling, leaning back with the hips extended',3,''],
['RFE Fire Hydrant','hipabd','glutes',3,0,'','Quadruped hydrant with the rear foot elevated',2,'bench'],
['Scapular CARs','scap','shoulders',3,1,'','Slow scapular circles through the full range',1,''],
['Scapular Clock','scap','shoulders',3,1,'','Protract, then move the hand up, out and down',2,'bands'],
['Seated Hip Flexion','hipflex','quads',3,1,'','Lift the thigh off the chair above ninety degrees',1,''],
['Seated Thoracic Extension','mob_t','back',3,1,'','Extend the upper back over a chair or roller',1,''],
['Servers','scap','shoulders',3,1,'','Rotate out, then press to full extension like carrying a tray',2,'bands'],
['Shoulder ER at Elevation','cuff','shoulders',3,1,'','Elbow to shoulder height holding external rotation',2,'bands'],
['Shoulder IR at Elevation','cuff','shoulders',3,1,'','The internal-rotation mirror, elbow at shoulder height',2,'bands'],
['Thoracic-Bias Shoulder Press','vpress','shoulders,arms',2,0,'','Overhead press cueing thoracic extension, not rib flare',2,'dumbbell'],
['Side-Lying Hip IR','hiprot','glutes',3,1,'','Rotate the top-leg foot into hip internal rotation',1,''],
['Side Plank w/ Clamshell','core_anti_lat','core,glutes',3,1,'','Open the top knee while the hips stay lifted',2,''],
['Side Plank w/ Rotation','core_anti_lat','core',3,1,'','Thread the top arm under, then open to the ceiling',2,''],
['Side Plank w/ Row','core_anti_lat','core,back',3,1,'','Row a band from a side plank without dropping the hips',2,'bands'],
['Banded Side Steps','hipabd','glutes',3,1,'','Lateral walk holding band tension and level hips',1,'bands'],
['Single-Leg Balance w/ Rotation','balance','quads,glutes,core',3,1,'','Balance on one leg and rotate the trunk across the body',2,''],
['Snap Down','plyo_lower','quads,glutes',3,1,'','Snap into an athletic quarter-squat and stick it',2,''],
['Split Squat w/ Heel Raise','lunge','quads,calves',2,1,'knee','Split squat finishing on the front toes',2,''],
['Split Stance D2 Flexion','scap','shoulders,core',3,1,'','Band under the front foot, arm driving a D2 diagonal',2,'bands'],
['Squat Jump','plyo_lower','quads,glutes',2,1,'knee','Countermovement into a maximal jump, land soft',2,''],
['Standing A','scap','shoulders,back',3,1,'','Arms low and back, thumbs out, scapulae squeezed',1,'bands'],
['Standing T','scap','shoulders,back',3,1,'','Arms out to a T, thumbs up, retracting the scapulae',1,'bands'],
['Standing W','scap','shoulders,back',3,1,'','Elbows bent, retracting and externally rotating',1,'bands'],
['Step Overs','mob_hip','glutes,quads',3,1,'','Step up and over an obstacle with control',1,''],
['Straight-Arm Pull-Apart','delt_rear','shoulders,back',3,1,'','Straight arms pulling the band out to a T',1,'bands'],
['Surfer Squat','hiprot','glutes,quads',2,1,'knee','Hold a squat and rotate ninety degrees against a band',3,'bands'],
['Tall Kneeling Hip IR','hiprot','glutes',3,1,'','Rotate one hip inward from tall kneeling',1,''],
['Toe Dissociation','foot','calves',3,1,'','Big toe down, others up — then reverse',1,''],
['Transverse Step Up','lunge','quads,glutes',2,0,'knee','Step up while turning ninety degrees',2,'bench'],
['Tree Matrix','balance','glutes,core',3,1,'','Pendulum reaches on one leg through all three planes',2,''],
['Triple Extension','plyo_lower','glutes,quads,calves',2,1,'','Explosive ankle, knee and hip extension together',2,''],
['Wall Angel','scap','shoulders',3,1,'','Goalpost arms sliding up a wall with the back flat',1,''],
['Wall Slides','scap','shoulders',3,1,'','W to Y up the wall, keeping contact',1,''],
["World's Greatest Stretch",'mob_gen','glutes,core',3,1,'','Deep lunge, elbow to instep, then rotate open',2,''],
['Serratus Push-Up','scap','shoulders,chest',3,1,'','Protract and retract with the elbows locked',1,''],
['Zottman Curl','bi','arms',3,0,'elbow','Curl supinated, lower pronated and slow',2,'dumbbell']
].map(r=>({ n:r[0], p:r[1], g:r[2].split(','), tier:r[3], home:!!r[4], x:r[5]?r[5].split(','):[], note:r[6],
  /* These were stored as skillSet/kitSet while every consumer read m.skill and m.kit, so both
     were permanently undefined: the skill gate that keeps technical lifts away from beginners
     never fired, and the declared-equipment rule fell through to guessing from the name. */
  skill:r[7] || null, kit:r[8] === undefined ? null : (r[8] ? r[8].split(',') : []),
  skillSet:r[7] || null, kitSet:r[8] === undefined ? null : (r[8] ? r[8].split(',') : []) }));
export const MACHINE_ONLY = ["Machine Chest Press","Cable Fly","Pec Deck","Cable Crossover","Lat Pulldown","Seated Cable Row","Machine Row","Cable Lateral Raise","Reverse Pec Deck","Cable Curl","Overhead Cable Triceps Ext","Triceps Pressdown","Machine Shoulder Press","Hack Squat","Belt Squat","Leg Press","Leg Extension","Lying Leg Curl","Seated Leg Curl","Cable Kickback","Hip Abduction","Adductor Machine","Seated Calf Raise","Cable Woodchop"];

/* ══════════ EQUIPMENT ══════════
   What each movement needs, so the program only asks for kit your gym has. */
export const KIT = {
  barbell:{ label:'Barbell & rack', re:/barbell|^back squat|^front squat|safety-bar|trap bar|conventional deadlift|romanian deadlift|good morning|push press|hang power clean|close-grip|skull crusher|^barbell or ez|hip thrust$/i },
  dumbbell:{ label:'Dumbbells', re:/\bdb\b|dumbbell|goblet|farmer carry|suitcase carry|hammer curl|preacher curl|reverse curl|lean-away|rear-delt fly|z-press|wrist extensor|heavy slow calf/i },
  kettlebell:{ label:'Kettlebells', re:/kettlebell/i },
  bench:{ label:'Bench', re:/bench press|incline|decline|chest-supported|preacher|45° back extension|chair or step dip|low-incline/i },
  pullupbar:{ label:'Pull-up bar', re:/pull-?up|chin-up|hanging leg raise/i },
  cable:{ label:'Cables', re:/cable|pulldown|pressdown|kickback|straight-arm/i },
  machines:{ label:'Machines', re:null },
  bands:{ label:'Bands', re:/band|spanish squat|pallof|terminal knee/i },
  medball:{ label:'Med ball', re:/med-ball/i },
  mobkit:{ label:'Roller & sliders', re:/foam roller|slider/i },
  dipbars:{ label:'Dip bars & belt', re:/^weighted dip$/i },
  abwheel:{ label:'Ab wheel', re:/ab wheel/i }
};
export const KIT_KEYS = Object.keys(KIT);
export function kitFor(m){
  const declared = (m.kit || []).filter(Boolean);
  if(declared.length) return [...new Set(declared)];
  const need = [];
  if(MACHINE_ONLY.indexOf(m.n) > -1){
    // a cable station and a selectorised machine are different pieces of kit
    need.push(/cable|pulldown|pressdown|kickback/i.test(m.n) ? 'cable' : 'machines');
    return need;
  }
  KIT_KEYS.forEach(k=>{ const r = KIT[k].re; if(r && r.test(m.n)) need.push(k); });
  // a barbell lift does not also need the dumbbell rack
  if(need.indexOf('barbell') > -1 && need.indexOf('dumbbell') > -1 && /^barbell|^back squat|^front squat|trap bar|conventional/i.test(m.n)){
    need.splice(need.indexOf('dumbbell'), 1);
  }
  return need;
}
/* Movement complexity: 1 guided or simple, 2 standard, 3 technical */
export const byName = {}; BANK.forEach(m=>byName[m.n]=m);
/* Movements whose name does not say what they need — set the kit explicitly so
   the detail sheet never claims a loaded barbell lift is bodyweight. */
export const DAYS = {
  push:{ label:'Push', slots:['hpress','ipress','vpress','dip|chest_iso','delt_side','chest_iso','tri','tri'] },
  pull:{ label:'Pull', slots:['vpull','hpull','hpull','pullover','delt_rear','delt_rear','bi','bi'] },
  legs:{ label:'Legs', slots:['squat','hinge','lunge','legpress|quad_iso','quad_iso','ham_iso','glute','calf'] },
  upper:{ label:'Upper Body', slots:['hpress','vpull','vpress','hpull','delt_side','delt_rear','bi','tri'] },
  lower:{ label:'Lower Body', slots:['squat','hinge','lunge','ham_iso','glute','quad_iso','calf','core_anti_ext'] },
  legs_b:{ label:'Legs B', slots:['hinge','legpress|squat','lunge','ham_iso','glute','adductor','calf','core_anti_rot'] },
  full:{ label:'Full Body', slots:['squat','hpress','hpull','hinge','lunge','vpull','core_anti_rot','calf'] },
  full_b:{ label:'Full Body', slots:['hinge','vpress','hpull','lunge','glute','hpress','core_anti_ext','ham_iso'] },
  full_c:{ label:'Full Body', slots:['squat','vpull','hpress','ham_iso','delt_side','glute','core_anti_rot','tri'] },
  full_d:{ label:'Full Body', slots:['lunge','hpress','hinge','vpull','quad_iso','delt_rear','bi','core_flex'] },
  lower_p:{ label:'Lower (Power)', slots:['plyo_lower','hinge','squat','plyo_lower','lunge','ham_iso','calf','core_flex'] },
  upper_p:{ label:'Upper (Power)', slots:['plyo_upper','vpress','hpress','vpull','plyo_upper','hpull','cuff','carry'] },
  full_p:{ label:'Full Body (Power)', slots:['plyo_lower','oly|hinge','hpress','plyo_upper','vpull','lunge','carry','core_flex'] },
};
/* Every split has to distribute work evenly across the body — upper and lower
   each getting comparable weekly sets. 'upper/lower/push/pull' failed that: push
   and pull are both upper days, so the lower body got a quarter of the volume. */
export const SPLITS = {
  1:['full'], 2:['upper','lower'], 3:['push','pull','legs'],
  4:['push','pull','legs','legs_b'], 5:['push','pull','legs','upper','lower'],
  6:['push','pull','legs','push','pull','legs']
};
export const SPLITS_POWER = {
  1:['full_p'], 2:['lower_p','upper_p'], 3:['lower_p','upper_p','full_p'],
  4:['lower_p','upper_p','lower_p','upper_p'], 5:['lower_p','upper_p','full_p','lower_p','upper_p'],
  6:['lower_p','upper_p','full_p','lower_p','upper_p','full_p']
};
export const SPLITS_HEALTH = {
  1:['full'], 2:['full','full'], 3:['full','full','full'],
  4:['full','upper','lower','full'], 5:['full','upper','lower','full','legs'],
  6:['full','upper','lower','full','upper','lower']
};

export const FULL_ROTATION = ['full','full_b','full_c','full_d'];
export const SPLITS_FULL = (()=>{ const o = {};
  for(let n = 1; n <= 6; n++) o[n] = Array.from({length:n}, (_,i)=>FULL_ROTATION[i % 4]);
  return o; })();
export const SPLITS_UL = { 1:['full'], 2:['upper','lower'], 3:['upper','lower','full_b'],
  4:['upper','lower','upper','lower'], 5:['upper','lower','upper','lower','full_c'], 6:['upper','lower','upper','lower','upper','lower'] };
export function splitStyle(){ return setup.splitStyle || 'auto'; }
export const FOCUS = {
  balanced:{ label:'Balanced', blurb:'Even coverage across every pattern', groups:[], day:null },
  chest:{ label:'Chest', blurb:'A dedicated chest day, extra pressing volume elsewhere', groups:['chest'], day:null },
  back:{ label:'Back', blurb:'A dedicated back day, extra pulling volume elsewhere', groups:['back'], day:null },
  shoulders:{ label:'Shoulders', blurb:'A delt day plus lateral and rear work throughout', groups:['shoulders'], day:null },
  arms:{ label:'Arms', blurb:'A biceps and triceps day on top of the compounds', groups:['arms'], day:null },
  quads:{ label:'Quads', blurb:'A quad-dominant day, more squatting overall', groups:['quads'], day:null },
  glutes:{ label:'Glutes & hamstrings', blurb:'A posterior-chain day, more hinging overall', groups:['glutes','hamstrings'], day:null },
  core:{ label:'Core & trunk', blurb:'A trunk day plus carries and anti-rotation throughout', groups:['core'], day:null },
  upper:{ label:'Upper body', blurb:'The split skews upper — more press and pull days', groups:['chest','back','shoulders','arms'], day:'upper' },
  lower:{ label:'Lower body', blurb:'The split skews lower — more squat and hinge days', groups:['quads','hamstrings','glutes','calves'], day:'lower' }
};

export const INJURIES = {
  lowback:{ label:'Low back', note:'Axially loaded and unsupported-spine lifts are removed; supported alternatives fill their slots.' },
  knee:{ label:'Knee', note:'Deep loaded knee flexion and impact work are removed; isometrics and hip-dominant loading come in.' },
  shoulder:{ label:'Shoulder', note:'Overhead and deep-stretch pressing are removed; floor and landmine pressing plus cuff work come in.' },
  elbow:{ label:'Elbow / forearm', note:'High-tension triceps and loaded gripping are removed; neutral-grip work and tendon eccentrics come in.' },
  hamstring:{ label:'Hamstring', note:'Lengthened-position and explosive hamstring work are removed; slow eccentrics and short-range hip extension come in.' },
  achilles:{ label:'Achilles / calf', note:'Impact and plyometric work are removed; heavy slow calf loading comes in.' },
  ankle:{ label:'Ankle', note:'Deep squatting, lunging and any jumping or impact work are removed; box-height work and controlled tempo fill their slots.' },
  hip:{ label:'Hip', note:'Deep hip flexion, rotation under load and impact work are removed; hip-friendly hinge and glute work come in.' },
  neck:{ label:'Neck', note:'Heavy overhead pressing and loaded carries are removed; supported and landmine pressing come in instead.' },
  wrist:{ label:'Wrist', note:'Barbell pressing, dips and loaded curls are removed; neutral-grip and machine alternatives come in.' },
  foot:{ label:'Foot / plantar', note:'Impact work and heavy calf loading are removed; seated and supported alternatives fill those slots.' }
};
/* The five newer injuries exclude by movement pattern rather than a hand-picked list —
   broader by design, since nothing has been curated per exercise for them yet. */
export function restSecs(goalKey, tier, week){
  /* Rest is a property of the adaptation, not a separate table. Reading it from its own
     table meant a strength-and-size week prescribed 30–60 seconds where the adaptation
     calls for 120–240 — a fourfold understatement, shown on screen mid-set. The tier and
     the short-rest week now scale WITHIN the adaptation's band instead of outside it. */
  const n = weekCount(), w = week || state.week, ph = phaseOf(w, n);
  const a = ADAPT[adaptFor(goalKey, w, n)] || ADAPT.hypertrophy;
  const lo = a.rest[0], top = a.rest[1];
  const t = Math.max(1, Math.min(3, tier || 2));
  let hi = t === 1 ? top : Math.round(lo + (top - lo) * (t === 2 ? 0.6 : 0.3));
  if(ph === 1) hi = Math.round(lo + (hi - lo) * 0.4);     // the short-rest week
  if(ph === 3) hi = Math.round(hi * 0.9);
  /* Snap to clean 30-second steps — the timer and the printed range should be numbers a person
     counts to (30/60/90/120), not a computed 96. This is the single source of truth: the session
     timer, the rest label and the session-length estimate all read from here. */
  const snap = s => Math.max(30, Math.round(s / 30) * 30);
  const rlo = snap(lo), rhi = Math.max(rlo, snap(hi));
  return [rlo, rhi];
}

export function restFor(ex, week, idx){
  const m = byName[ex.name];
  let tier = m ? m.tier : 2;
  // only the first couple of lifts get the long window; later work is accessory work
  const i = idx === undefined ? exIndexOf(ex) : idx;
  if(i >= 2) tier = Math.min(3, tier + 1);
  if(i >= 4) tier = 3;
  return restSecs(ex.goal || primaryGoalOf(), tier, week);
}
export function exIndexOf(ex){
  for(const d of state.plan){
    const i = d.exercises.indexOf(ex);
    if(i > -1) return i;
    const j = d.exercises.findIndex(e=>e.name === ex.name);
    if(j > -1) return j;
  }
  return 0;
}
export function primaryGoalOf(){
  const s = state.setup || {};
  const g = (s.goals && s.goals.length) ? s.goals : [s.goal || 'hypertrophy'];
  return GOAL_ORDER.find(k=>g.indexOf(k) > -1) || g[0];
}
/* Roughly how long a session runs: warm-up + every set and the rest after it. */
export function setSeconds(ex){
  const m = byName[ex.name];
  const tier = m ? m.tier : 2;
  return tier === 1 ? 45 : tier === 2 ? 35 : 30;      // time under the bar, plus getting set up
}
export function dayMinutes(d, week){
  if(!d || !d.exercises) return 0;
  let secs = 0;
  d.exercises.forEach((ex, i)=>{
    const t = String(tgt(ex, week));
    const m = t.match(/^(\d+)/);
    const sets = m ? +m[1] : 3;
    const [lo, hi] = restFor(ex, week, i);
    secs += sets * setSeconds(ex) + (sets - 1) * ((lo + hi) / 2);
  });
  secs += 10 * 60;                                    // the fixed three-part warm-up
  secs += 120;                                        // changing plates, finding a bench
  return Math.round(secs / 60);
}
/* No session should run past its length ceiling, warm-up included. Trim from the
   back — the last exercises are the smallest — then shave a set off the biggest
   remaining block, rather than cutting the main lifts.
   Seventy minutes is the default. A beginner is asked for their ceiling instead: an hour
   is a lot of time to find and a lot of unfamiliar work to hold attention through, so a
   45-minute session is a legitimate answer rather than a compromised one. */
export const SESSION_CAP_BY_EXP   = { beginner:60, intermediate:75, advanced:80 };
export const SESSION_FLOOR_BY_EXP = { beginner:35, intermediate:48, advanced:52 };
/* The real guardrail on session size. Minutes alone let a day balloon — a hard ceiling on how
   many movements it carries keeps it a handful of things done well. Experience buys one more
   slot, not a checklist. */
export const MAX_MOVES_BY_EXP     = { beginner:5, intermediate:6, advanced:7 };
export function maxMoves(){ return MAX_MOVES_BY_EXP[setup.exp] || MAX_MOVES_BY_EXP.intermediate; }
export function sessionCap(){
  if(setup.exp === 'beginner') return +setup.sessionMax || SESSION_CAP_BY_EXP.beginner;
  return SESSION_CAP_BY_EXP[setup.exp] || SESSION_CAP_BY_EXP.intermediate;
}
/* The floor tracks the ceiling so a build can't fill a day up and then trim it straight back. */
export function sessionFloor(){
  if(setup.exp === 'beginner'){ const c = sessionCap(); return Math.max(18, c - 10); }
  return SESSION_FLOOR_BY_EXP[setup.exp] || SESSION_FLOOR_BY_EXP.intermediate;
}
/* A session has a floor as well as a ceiling. Trimming to fit 70 minutes was the only length
   rule, so a day that came out at 35 minutes was left there — and a beginner's lower set counts
   made that the normal outcome. Fill up to 50 minutes first from the muscle groups the day
   already trains, keeping every selection rule intact, then trim if the result overshoots. */
export function fillDayToTime(exercises, week, dayIdx, ctx){
  const _s = pgCtx(ctx);
  const day = { exercises:exercises.slice() };
  if(dayMinutes(day, week) >= sessionFloor()) return day.exercises;
  const have = new Set(day.exercises.map(x=>x.name));
  const patterns = new Set(), regions = new Set();
  day.exercises.forEach(x=>{ const m = byName[x.name]; if(!m) return;
    patterns.add(m.p); (m.g || []).forEach(g=>regions.add(g)); });
  /* An upper/lower day must not import the opposite family. Sharing a region isn't enough: every
     day has a core slot, and core-braced pressing and rowing share it — which is how a shoulder
     press and a barbell row were landing on a lower day. Judge a candidate by its PRIMARY muscle. */
  const UPPER_G = ['chest','back','shoulders','arms'], LOWER_G = ['quads','hamstrings','glutes','calves'];
  const famOf = g => UPPER_G.indexOf(g) > -1 ? 'upper' : LOWER_G.indexOf(g) > -1 ? 'lower' : 'neutral';
  const dayFams = new Set();
  day.exercises.forEach(x=>{ const m = byName[x.name]; if(m) (m.g || []).forEach(g=>dayFams.add(famOf(g))); });
  const dayIsLower = dayFams.has('lower') && !dayFams.has('upper');
  const dayIsUpper = dayFams.has('upper') && !dayFams.has('lower');
  const pool = BANK.filter(x=>
    !have.has(x.n) && !patterns.has(x.p) && !isBandMove(x) && equipPick(x).include &&
    !(x.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1) &&
    (SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(x.skill || 2) - 1] > -50 &&
    (x.g || []).some(g=>regions.has(g)) &&
    !((dayIsLower && famOf((x.g || [])[0]) === 'upper') || (dayIsUpper && famOf((x.g || [])[0]) === 'lower')))
    .sort((a, b)=> (b.tier || 2) - (a.tier || 2));      // accessories first — the compounds are done
  let guard0 = 0;
  while(dayMinutes(day, week) < sessionFloor() && pool.length && guard0++ < 12){
    const m = pool.shift();
    if(have.has(m.n) || patterns.has(m.p)) continue;
    have.add(m.n); patterns.add(m.p);
    const gk = goalForTier(m.tier, m.p);
    const cap = _s.exp === 'beginner' ? 3 : _s.exp === 'advanced' ? 5 : 4;
    day.exercises.push({ name:m.n, note:m.note, goal:gk,
      targets:genTargets(Math.min(cap, 3), gk, weekCount(), m.p, m.tier, dayIdx || 0, 0, loadKindOf(m), m.n, _s) });
  }
  /* Still short because the bank has nothing left for these muscles — add a set to the accessory
     work rather than leaving the session under length. */
  let guard1 = 0;
  while(dayMinutes(day, week) < sessionFloor() && guard1++ < 10){
    const cap = _s.exp === 'beginner' ? 3 : _s.exp === 'advanced' ? 5 : 4;
    const i = day.exercises.findIndex(ex=>{
      const m = byName[ex.name];
      const n = +(String(tgt(ex, week)).match(/^(\d+)/) || [0, 0])[1];
      return m && (m.tier || 2) >= 2 && n < cap && !ex.burnout;
    });
    if(i < 0) break;
    const ex = day.exercises[i];
    ex.targets = ex.targets.map(t=>String(t).replace(/^(\d+)/, (mm, n)=> Math.min(6, +n + 1)));
  }
  return day.exercises;
}
export function fitDayToTime(exercises, week){
  const day = { exercises:exercises.slice() };
  /* Movement-count ceiling first. Drop from the back, but prefer a movement whose primary muscle
     is already covered by another kept movement — so a third quad slot goes before the day's only
     calf or core movement, and group coverage survives the trim. */
  const maxN = maxMoves();
  while(day.exercises.length > maxN){
    let idx = -1;
    for(let i = day.exercises.length - 1; i >= 0; i--){
      const g0 = ((byName[day.exercises[i].name] || {}).g || [])[0];
      if(g0 && day.exercises.some((e, j)=> j !== i && (((byName[e.name] || {}).g || [])[0] === g0))){ idx = i; break; }
    }
    day.exercises.splice(idx > -1 ? idx : day.exercises.length - 1, 1);
  }
  let guard = 0;
  while(dayMinutes(day, week) > sessionCap() && guard++ < 40){
    const minKeep = Math.min(maxN, sessionCap() <= 45 ? 3 : 4);
    if(day.exercises.length > minKeep){ day.exercises.pop(); continue; }
    // out of exercises to drop: take a set off whichever has the most
    let worst = -1, most = 0;
    day.exercises.forEach((ex,i)=>{
      const n = +String(tgt(ex, week)).match(/^(\d+)/)[1];
      if(n > most){ most = n; worst = i; }
    });
    if(worst < 0 || most <= 2) break;
    const ex = day.exercises[worst];
    ex.targets = ex.targets.map(t=>String(t).replace(/^(\d+)/, (m,n)=> Math.max(2, +n - 1)));
  }
  return day.exercises;
}
export const TIER_PREF = { hypertrophy:[1,1,.92], strength:[1,.82,.55], power:[1,.85,.62], health:[.72,1,.95] };
/* Patterns each goal has a particular use for. */
export const GOAL_BIAS = {
  hypertrophy:{ up:['chest_iso','delt_side','delt_rear','bi','tri','quad_iso','ham_iso','glute','calf'], w:.5 },
  strength:{ up:['squat','hinge','hpress','vpress','vpull','hpull'], w:.6 },
  power:{ up:['plyo_lower','plyo_upper','oly','carry'], w:.9 },
  health:{ up:['core_anti_rot','core_anti_ext','core_anti_lat','cuff','carry','tib','adductor','forearm'], w:.6 }
};
export function goalsNow(ctx){
  const _s = pgCtx(ctx);
  const g = (_s.goals && _s.goals.length) ? _s.goals : [_s.goal || 'hypertrophy'];
  return g;
}
export const GOAL_ORDER = ['power','strength','hypertrophy','health'];
export function primaryGoal(ctx){
  const g = goalsNow(ctx);
  return GOAL_ORDER.find(k=>g.indexOf(k) > -1) || g[0];
}
/* Which goal's rep scheme a given exercise should follow.
   Heavier goals take the big lifts, hypertrophy and health take the accessories. */
export function goalForTier(tier, pattern){
  const g = goalsNow();
  const pick = order => order.find(k=>g.indexOf(k) > -1);
  // a movement that exists for one goal is prescribed that goal's way, whatever its tier
  if(pattern){
    const owner = g.find(k=>GOAL_BIAS[k] && GOAL_BIAS[k].up.indexOf(pattern) > -1
      && (k === 'power' || k === 'health'));
    if(owner) return owner;
  }
  if(tier === 1) return pick(['strength','power','hypertrophy','health']) || g[0];
  if(tier === 2) return pick(['hypertrophy','health','power','strength']) || g[0];
  return pick(['hypertrophy','health','strength','power']) || g[0];
}
export function blendedTierPref(){
  const g = goalsNow();
  return [0,1,2].map(i=> g.reduce((a,k)=>a + (TIER_PREF[k]||TIER_PREF.hypertrophy)[i], 0) / g.length);
}
export function rnd(seed){ const x = Math.sin(seed*12.9898)*43758.5453; return x - Math.floor(x); }
export function hasKit(k){ return !!(setup.kit && setup.kit[k]); }
export function equipPick(item){
  /* Only 41 of 248 bank entries declare their equipment, so reading item.kit alone meant the
     other 207 passed the filter unconditionally — a client with no barbell was offered barbell
     movements because the row never said it needed one. kitFor knows both: the declaration where
     there is one, derived from the movement otherwise. */
  const need = kitFor(item);
  return { include: need.every(hasKit), need };
}
export const SKILL_PREF = { beginner:[1.25, .35, -99], intermediate:[.7, 1, .75], advanced:[.25, .9, 1.3] };
export function wantedGroups(){
  /* No focus picker any more, so the only source of emphasis is whatever an older saved setup
     carried. Pinned to balanced on load, so this is effectively the emphasis list alone. */
  const f = FOCUS[setup.focus] || FOCUS.balanced;
  return new Set(f.groups.concat(setup.emphasis || []));
}
/* Resistance bands give ascending, unmeasurable tension: you cannot add 5 lb to a
   band, so the progression this app prescribes — reps descend while load rises — has
   nothing to act on. That is fine for an accessory and wrong for a main lift, so a
   band-only movement is pushed out of the primary slots whenever the kit holds
   something loadable. With bands as the only equipment it can still win. */
export const LOADABLE = ['barbell','dumbbell','kettlebell','cable','machines'];
/* Unloadable: nothing to add weight to. Bands give ascending, unmeasurable tension
   and bodyweight gives a fixed one, so neither can carry a progression that works by
   adding load — the main lift has to be something you can make heavier. Pull-ups and
   dips are deliberately NOT counted here: bodyweight is a real load on those, and they
   take added weight later. */
/* The bank lists kit as alternatives, not requirements — "Band Good Morning" carries
   ["barbell","bands"] — so the kit field alone cannot say what actually supplies the
   resistance. The name does: a movement called "Band …" is driven by band tension
   whatever else is listed beside it. */
export const bandOnly = m => {
  /* Plyometrics are the exception: a jump or a throw is SUPPOSED to be unloaded, and
     it belongs first in a power session. Progression there is height, distance and bar
     speed, not added weight — so never push these out of a primary slot. */
  if(/^plyo/.test(m.p || '')) return false;
  const k = kitFor(m);
  return k.length === 0 || /^band /i.test(m.n) || (k.length === 1 && k[0] === 'bands');
};
export const hasLoadable = () => LOADABLE.some(k=>hasKit(k));
/* Fit to carry a session. Testing for bands alone let bodyweight through — a decline
   push-up declares a bench, so it looked equipped while offering no way to add load.
   A main lift has to be loadable, with two deliberate exceptions: plyometrics, which
   are meant to be unloaded, and pull-ups and dips, where bodyweight IS the load and
   weight can be hung from it later. */
export const primaryOk = m => {
  const p = m.p || '';
  /* Pull-ups and dips are exempt because bodyweight IS the load there and weight can be
     hung from them later. A passive hang or a static hold cannot carry a session. */
  if(/^plyo/.test(p)) return true;
  if((p === 'vpull' || p === 'dip') && !/\b(hang|hold|isometric)\b/i.test(m.n || '')) return true;
  if(/^band/i.test(m.n || '')) return false;
  return kitFor(m).some(k=>LOADABLE.indexOf(k) > -1);
};
/* ── Supersets ───────────────────────────────────────────────────────────────────
   Pairing two movements back to back is a dosage decision, not a convenience. The adaptation
   table settles when it is appropriate: hypertrophy runs 1–3 minutes rest and muscular endurance
   30–90 seconds, so pairing an antagonist in the gap costs nothing — the second muscle works
   while the first recovers, and the session gets shorter without losing a set. Max strength
   (3–5 min) and power (2–5 min) are the opposite case: the long rest IS the prescription, because
   the quality being trained is force and speed, and both fall when the set before was recent.
   Pairing there would quietly convert a strength session into a conditioning one.

   Only ACCESSORIES pair, and only true antagonists — a push against a pull, a knee flexion
   against a knee extension. The lifts that carry the session are never paired: they need the
   full rest and the full attention. */
export const ANTAGONIST = {
  hpress:['hpull'], hpull:['hpress'],
  vpress:['vpull'], vpull:['vpress'],
  bi:['tri'], tri:['bi'],
  quad_iso:['ham_iso'], ham_iso:['quad_iso'],
  chest_iso:['delt_rear'], delt_rear:['chest_iso'],
  core_flex:['core_anti_ext'], core_anti_ext:['core_flex'],
  hipflex:['glute'], glute:['hipflex']
};
export const SUPERSET_GOALS = { hypertrophy:1, endurance:1, hyphigh:1 };
export function pairAntagonists(list){
  const gk = primaryGoal();
  if(!SUPERSET_GOALS[gk] && !SUPERSET_GOALS[adaptFor(gk, state.week || 1, weekCount())]) return list;
  const out = list.slice();
  const paired = new Set();
  for(let i = 0; i < out.length; i++){
    const a = out[i], ma = byName[a.name];
    if(!ma || (ma.tier || 2) < 3 || a.ssAfter || a.burnout || paired.has(a.name)) continue;
    const wants = ANTAGONIST[ma.p];
    if(!wants) continue;
    for(let j = i + 1; j < out.length; j++){
      const b = out[j], mb = byName[b.name];
      if(!mb || (mb.tier || 2) < 3 || b.ssAfter || b.burnout || paired.has(b.name)) continue;
      if(wants.indexOf(mb.p) < 0) continue;
      /* Move the partner directly after its pair and mark it, so the session screen shows them
         together and the rest between them is the pair's, not a full rest. */
      out.splice(j, 1);
      out.splice(i + 1, 0, Object.assign({}, b, { ssAfter:a.name,
        note:'Superset — go straight into this after ' + a.name + ', then rest once before the next round.' }));
      paired.add(a.name); paired.add(b.name);
      break;
    }
  }
  return out;
}
/* ── Drill ladders ───────────────────────────────────────────────────────────────
   Some movements are not alternatives to each other — they are rungs on one ladder. Snap
   Down teaches the landing shape, Depth Drop adds gravity, Drop Jump asks you to absorb it
   quietly, Depth Jump asks you to reverse it instantly. Programming two of them in a session
   is not variety, it is the same drill twice, and it puts the highest-impact rung in front of
   an athlete who has not shown they own the one below it.

   The power-day templates carry two plyometric slots on purpose — two exposures, different
   vectors — so the fix is not fewer slots but one rung per ladder, and the rung has to be
   earned. Rung order is the teaching order, and skill gating already keeps rung 4 away from
   beginners; this keeps it away from a session that also contains rung 2.

   Cross-plane and cross-modal plyos remain free to coexist: a broad jump and a lateral bound
   train different vectors, and a pogo hop trains ankle stiffness rather than a jump at all. */
export const LADDER = {
  'Snap Down':          { fam:'drop',   rung:1 },
  'Depth Drop':         { fam:'drop',   rung:2 },
  'Drop Jump':          { fam:'drop',   rung:3 },
  'Depth Jump':         { fam:'drop',   rung:4 },
  'Triple Extension':   { fam:'vjump',  rung:1 },
  'Squat Jump':         { fam:'vjump',  rung:2 },
  'Box Jump':           { fam:'vjump',  rung:3 },
  'Trap Bar Jump':      { fam:'vjump',  rung:4 },
  'Band Speed Press':   { fam:'ppush',  rung:1 },
  'Clap Push-up':       { fam:'ppush',  rung:2 },
  'Med-Ball Chest Throw':{ fam:'ppush', rung:3 },
  'Med-Ball Rotational Throw':{ fam:'rot', rung:1 },
  'Med-Ball Slam':      { fam:'rot',    rung:2 }
};
export const ladderOf = n => LADDER[n] || null;
/* Which ladders a session already draws from. */
export function ladderFams(names){
  const s = new Set();
  names.forEach(n=>{ const l = ladderOf(n); if(l) s.add(l.fam); });
  return s;
}
export function pickForSlot(slot, seed, taken, used, wanted, primary, ctx){
  const _s = pgCtx(ctx);
  const pats = slot.split('|');
  const pref = blendedTierPref();
  const goals = goalsNow();
  /* The front of a session is where the compound work goes. Scoring alone could not hold that
     line: a beginner's preferences reward simple, easy-to-learn movements so heavily that a
     tier-2 accessory press outscored every real press and opened the day. So when a genuine
     compound IS available for this slot, the slot only considers compounds. */
  const skillOK = m => (SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(m.skill || 2) - 1] > -50;
  /* A rung whose ladder is already represented in this session is not an option. */
  const fams = ladderFams([...taken]);
  const ladderFree = m => { const l = ladderOf(m.n); return !l || !fams.has(l.fam); };
  const usableHere = m =>
    pats.indexOf(m.p) > -1 && !taken.has(m.n) && ladderFree(m) &&
    equipPick(m).include && !m.x.some(k=>_s.injuries.includes(k));
  /* The technical ceiling is a hard line whenever the slot has any option below it. It was only a
     scoring penalty, and a penalty can be outvoted — which is how a beginner was given a
     single-leg RDL with a trap-bar deadlift sitting available on the same pattern. It stays a
     preference only when nothing gentler exists, so a slot is never left empty. */
  const requireSkillFit = BANK.some(m=>usableHere(m) && skillOK(m) && (!primary || !hasLoadable() || primaryOk(m)));
  let requireCompound = false, refuseBand = false;
  if(primary){
    const viable = t => BANK.some(m=>usableHere(m) && skillOK(m) && (!hasLoadable() || primaryOk(m)) && t(m));
    requireCompound = viable(m=>(m.tier || 2) === 1);
    /* No compound survived the filters, but something loadable did — take that over a band. */
    refuseBand = !requireCompound && viable(m=>!isBandMove(m));
  }
  let best = null, bestScore = -99;
  BANK.forEach((m,mi)=>{
    if(pats.indexOf(m.p) < 0) return;
    if(!ladderFree(m)) return;
    if(requireSkillFit && !skillOK(m)) return;
    if(requireCompound && (m.tier || 2) !== 1) return;
    if(refuseBand && isBandMove(m)) return;
    if(taken.has(m.n)) return;
    if(!equipPick(m).include) return;
    if(m.x.some(k=>_s.injuries.includes(k))) return;
    const sk = (SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(m.skill||2)-1];
    if(sk < -50) return;                       // too technical for this experience level
    let s = pref[m.tier-1] + sk * 1.15;
    if(primary && !primaryOk(m) && hasLoadable()) s -= 6;
    else if(bandOnly(m) && hasLoadable()) s -= 1.2;
    if(m.g.some(g=>wanted.has(g))) s += .7;
    goals.forEach(gk=>{ const b = GOAL_BIAS[gk]; if(b && b.up.indexOf(m.p) > -1) s += b.w / goals.length; });
    if(hasKit('machines') && m.eq === 'home') s -= .5;   // a stocked gym should not send you to the floor
    if(used && used.has(m.n)) s -= .85;
    s += rnd(seed + mi*7.3) * .6;
    if(s > bestScore){ bestScore = s; best = m; }
  });
  return best;
}
/* One day's movement list: equipment, injuries, focus and emphasis all applied here */
/* ── Weekly volume governor ──────────────────────────────────────────────────────
   Set counts are chosen one exercise at a time — tier, experience, plus a bonus for a focused
   muscle — and nothing looked at what the WEEK added up to. Every day was built as though it
   were the only day that trained its muscles. On a six-day split that put the chest at 32 hard
   sets a week and the back at 33, and with an arms focus it put the arms at 77: incidental arm
   volume from five pressing and pulling days on top of a dedicated arm day. The focus bonus
   compounded it, applying to every exercise touching the focused muscle on every day.

   Around ten to twenty hard sets per muscle per week is where the useful range sits, and past
   roughly the mid-twenties recovery becomes the limiting factor rather than stimulus — so extra
   sets past that are not extra growth, they are fatigue and injury risk with a training effect
   that is at best flat. Strength and power work legitimately runs leaner, so the ceiling moves
   with the goal.

   Trimming takes from the least compound contributor first: an isolation set is the cheapest
   volume to give up and the compound work is what the session is for. Nothing is trimmed below
   two sets, and a movement is never removed — a smaller prescription is a judgement, an empty
   slot is a hole. */
export const WEEK_CAP = { hypertrophy:22, strhyp:20, strength:18, power:16, health:18, endurance:20 };
export const GROUP_SESSION_CAP = 12;        // hard sets for one muscle in a single session
/* A set's credit to each muscle it trains. Counting a bench press as a full set for the
   triceps overstates arm volume badly, which is how 77 looked survivable. */
export function setCredit(m){
  const g = m && m.g || [];
  if(!g.length) return {};
  const out = {};
  g.forEach((k, i)=>{ out[k] = i === 0 ? 1 : (g.length > 2 ? 0.34 : 0.5); });
  return out;
}
/* A stage is not trained in week one — stage three of an eight-week block is trained in week
   seven, by which point the block's set compensation has added work. Measuring a stage at week
   one therefore measures a prescription nobody ever performs: the length trim and the volume
   ceiling were both computed against the wrong numbers, and stage-three sessions ran to a hundred
   and twenty minutes against a seventy-minute cap while the weekly ceiling was quietly exceeded.
   Everything is judged at the heaviest week the stage actually covers. */
export function stageWeeks(st){
  const L = stageLen(), n = weekCount(), out = [];
  for(let i = 0; i < L; i++){ const w = st * L + 1 + i; if(w <= n) out.push(w); }
  return out.length ? out : [1];
}
export const setsAt = (ex, w) => { const m = String(tgt(ex, w)).match(/^(\d+)×/); return m ? +m[1] : 0; };
export const setsPeak = (ex, st) => Math.max.apply(null, stageWeeks(st).map(w=>setsAt(ex, w)));
export const peakWeek = st => stageWeeks(st)[stageWeeks(st).length - 1];
export const setsIn = ex => { const m = String((ex.targets || [])[0] || '').match(/^(\d+)×/); return m ? +m[1] : 0; };
export function reSets(ex, dayIdx, sets, stageIdx, ctx){
  const _s = pgCtx(ctx);
  const m = byName[ex.name];
  if(!m) return ex;
  const gk = ex.goal || goalForTier(m.tier, m.p);
  const t = genTargets(sets, gk, weekCount(), m.p, m.tier, dayIdx || 0, stageIdx || 0, loadKindOf(m), m.n, _s);
  return (t && t.length) ? Object.assign({}, ex, { targets:t }) : ex;
}
export function governVolume(plan, ctx){
  const _s = pgCtx(ctx);
  const base = WEEK_CAP[primaryGoal()] || 22;
  /* A focused muscle is meant to be over-reached — that is what choosing a focus asks for — so it
     gets a deliberate allowance above the general ceiling rather than being trimmed back to it.
     Bounded, though: past roughly a third above the useful range the extra sets stop being a
     priority and start being unrecoverable, whatever the client asked for. */
  const capFor = () => base;
  const stages = Math.max(1, ...(plan || []).map(d=>(d.stages || []).length));

  for(let st = 0; st < stages; st++){
    /* Two phases, and the split matters for speed as much as for clarity. Deciding the set counts
       is pure arithmetic; writing them means regenerating a movement's prescription for every week
       of the block. Doing both inside one loop called genTargets on every single decrement —
       hundreds of times per stage — and pushed a six-day build past ten seconds. Decide first,
       write once. */
    const items = [];
    (plan || []).forEach(d=>{
      const list = (d.stages && d.stages[st]) || d.exercises || [];
      list.forEach((ex, ix)=>{
        const m = byName[ex.name];
        if(!m) return;
        const s = setsIn(ex);
        /* The base count is what a prescription is generated from; the peak is what the client
           actually performs. Block compensation adds a fixed number of sets on top of the base,
           so the gap between them holds as the base is trimmed — carry it and tally the peak. */
        items.push({ d, list, ix, ex, m, s, want:s, cr:setCredit(m),
          lift:Math.max(0, setsPeak(ex, st) - s),
          floor:clampSets(1, ex.goal || goalForTier(m.tier, m.p)) });
      });
    });

    const tally = ()=>{
      const week = {}, day = new Map();
      items.forEach(o=>{
        let dm = day.get(o.d);
        if(!dm){ dm = {}; day.set(o.d, dm); }
        const eff = o.want + o.lift;
        Object.keys(o.cr).forEach(g=>{
          week[g] = (week[g] || 0) + eff * o.cr[g];
          dm[g] = (dm[g] || 0) + eff * o.cr[g];
        });
      });
      return { week, day };
    };

    // ── phase one: take sets off, cheapest volume first
    for(let pass = 0; pass < 600; pass++){
      const { week, day } = tally();
      let over = Object.keys(week).filter(g=>week[g] > capFor(g))
        .sort((a, b)=>week[b] - week[a])[0] || null;
      let scope = 'week';
      if(!over){
        for(const o of items){
          const dm = day.get(o.d) || {};
          const hit = Object.keys(dm).filter(g=>dm[g] > GROUP_SESSION_CAP)
            .sort((a, b)=>dm[b] - dm[a])[0];
          if(hit){ over = hit; scope = 'day'; break; }
        }
      }
      if(!over) break;
      const inScope = o => o.cr[over] && (scope === 'week' || (day.get(o.d) || {})[over] > GROUP_SESSION_CAP);
      /* Set counts have a floor: genTargets clamps a prescription up to the goal's minimum, so
         asking for two sets of a hypertrophy movement returns three. Trimming below it changes
         nothing at all, which is how this loop once span without moving a number. */
      const pool = items.filter(o=>inScope(o) && o.want > o.floor)
        .sort((a, b)=> ((b.m.tier || 2) - (a.m.tier || 2)) || (b.want - a.want));
      if(!pool.length) break;
      pool[0].want--;
    }
    // write the decisions, one regeneration per changed movement
    items.forEach(o=>{
      if(o.want !== o.s) o.list[o.ix] = reSets(o.ex, o.d.dayIdx, o.want, st, _s);
    });

    // ── phase two: everything is at its floor and a muscle is still over
    for(let pass = 0; pass < 200; pass++){
      const cur = [];
      (plan || []).forEach(d=>{
        const list = (d.stages && d.stages[st]) || d.exercises || [];
        const dm = {};
        list.forEach((ex, ix)=>{
          const m = byName[ex.name];
          if(!m) return;
          const c = setCredit(m), n = setsPeak(ex, st);
          Object.keys(c).forEach(g=>{ dm[g] = (dm[g] || 0) + n * c[g]; });
          cur.push({ d, list, ix, ex, m, cr:c, dm, peak:n });
        });
      });
      const week = {};
      cur.forEach(o=>Object.keys(o.cr).forEach(g=>{ week[g] = (week[g] || 0) + o.peak * o.cr[g]; }));
      const over = Object.keys(week).filter(g=>week[g] > capFor(g))
        .sort((a, b)=>week[b] - week[a])[0];
      if(!over) break;
      /* On a six-day split five chest movements at three sets each is thirty sets a week — no
         arithmetic on set counts reaches the cap, because the excess is in the NUMBER of
         movements. The redundant isolation goes. Only isolation: the compound lifts are what the
         session exists for. A day never falls below five movements, four on a focus day whose job
         is one muscle, and a movement that is the sole trainer of its primary muscle stays. */
      const soleFor = g => cur.filter(o=>(o.m.g || [])[0] === g).length <= 1;
      /* How short a session may get depends on how often you train. A fixed five-movement floor
         was the binding constraint on high-frequency splits: six days of six movements is far more
         weekly volume than a muscle can use, and the governor had to stop cutting exactly where it
         still mattered. Training a muscle three times a week means less each time — that is the
         trade frequency buys, and it only works if the sessions are allowed to be smaller. */
      const minMoves = (_s.liftDays || 3) >= 5 ? 3 : 5;
      const cut = cur.filter(o=>o.cr[over] && (o.m.tier || 2) >= 3 &&
          o.list.length > minMoves && !soleFor((o.m.g || [])[0]))
        .sort((a, b)=> (b.dm[over] - a.dm[over]) || (b.ix - a.ix));
      if(cut.length){ cut[0].list.splice(cut[0].ix, 1); continue; }
      /* No isolation left to give and the muscle is still over. On a five- or six-day week the
         remaining volume is the compound lifts themselves — two leg days of squats, lunges and a
         press is twenty-four direct quad sets before a single isolation movement — so refusing to
         touch compounds meant the ceiling could not be reached at all. A compound may give up one
         set, down to two, which is still a real working prescription and is a better answer than
         a week of unrecoverable volume. The movement is never removed: what the session is for
         stays in it. */
      const shave = cur.filter(o=>o.cr[over] &&
          setsIn(o.ex) > Math.max(2, clampSets(1, o.ex.goal || goalForTier(o.m.tier, o.m.p)) - 1))
        .sort((a, b)=> (b.dm[over] - a.dm[over]) || (setsIn(b.ex) - setsIn(a.ex)));
      if(!shave.length) break;
      const sh = shave[0];
      sh.list[sh.ix] = reSets(sh.ex, sh.d.dayIdx, setsIn(sh.ex) - 1, st, _s);
    }
  }
  fillDeficiencies(plan, _s);
  return plan;
}
export function fillDeficiencies(plan, ctx){
  const _s = pgCtx(ctx);
  if(!plan || plan.length < 3) return plan;
  const MAJOR = ['chest','back','shoulders','arms','quads','hamstrings','glutes'];
  const stages = Math.max(1, ...plan.map(d=>(d.stages || []).length));
  for(let st = 0; st < stages; st++){
    const listOf = d => (d.stages && d.stages[st]) || d.exercises || [];
    MAJOR.forEach(g=>{
      let vol = 0, present = new Set();
      plan.forEach(d=>listOf(d).forEach(ex=>{
        const m = byName[ex.name];
        if(!m) return;
        present.add(ex.name);
        const cr = setCredit(m);
        if(cr[g]) vol += setsPeak(ex, st) * cr[g];
      }));
      if(vol > 0) return;
      /* Something that trains it as its PRIMARY muscle, within kit, injuries and skill. */
      const eligible = allowBand => BANK.filter(m=>(m.g || [])[0] === g && !present.has(m.n) &&
          (allowBand || !isBandMove(m)) &&
          equipPick(m).include && !(m.x || []).some(k=>(_s.injuries || []).indexOf(k) > -1) &&
          (SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(m.skill || 2) - 1] > -50)
        .sort((a, b)=>((a.tier || 2) - (b.tier || 2)) || ((a.skill || 2) - (b.skill || 2)));
      /* Bands are barred from being a staple of the programming, and that bar is right — but it
         was also barring the only arm work available on a minimal kit, leaving the biceps and
         triceps on nothing at all for the block. A band curl as the last accessory of a session
         is exactly the use bands are for. Loadable first, band only if there is no alternative. */
      const cand = eligible(false)[0] || eligible(true)[0];
      if(!cand) return;
      /* Appending to the shortest day and trimming to length was not enough: on a day already at
         the session cap the trim pops the movement straight back off — the same movement it was
         just added to fix — and the muscle stays on nothing. Try each day shortest first and keep
         only a placement the trim actually leaves standing. */
      const order = plan.slice().sort((a, b)=>listOf(a).length - listOf(b).length);
      let placed = false;
      for(const target of order){
        const gk = goalForTier(cand.tier, cand.p);
        const item = { name:cand.n, note:cand.note, goal:gk,
          targets:genTargets(cand.tier === 1 ? 4 : 3, gk, weekCount(), cand.p, cand.tier,
            target.dayIdx || 0, st, loadKindOf(cand), cand.n, _s) };
        const trimmed = fitDayToTime(listOf(target).concat([item]), peakWeek(st));
        if(!trimmed.some(x=>x.name === cand.n)) continue;      // the trim took it back off
        if(target.stages && target.stages[st]) target.stages[st] = trimmed;
        if(st === 0) target.exercises = trimmed;
        placed = true;
        break;
      }
      /* On a strength full-body week every day already sits at the session cap, so no placement
         survives and the muscle stays on nothing at all. Make room: drop the last accessory on the
         shortest day and put the movement in its place. A muscle trained a little is a training
         decision; a muscle trained not at all is a hole in the program. */
      if(!placed){
        const target = order[0];
        const list = listOf(target);
        let victim = -1;
        /* Isolation first, then any lesser accessory. On a strength full-body day every movement
           is a compound, so requiring a tier-three victim found nobody and the muscle kept its
           zero. The opening two lifts are never touched — those are what the session is for. */
        for(let pass2 = 3; pass2 >= 2 && victim < 0; pass2--){
          for(let i = list.length - 1; i >= 2; i--){
            const vm = byName[list[i].name];
            if(vm && (vm.tier || 2) >= pass2 && !list[i].ssAfter){ victim = i; break; }
          }
        }
        if(victim > -1){
          const gk = goalForTier(cand.tier, cand.p);
          const next = list.slice();
          next[victim] = { name:cand.n, note:cand.note, goal:gk,
            targets:genTargets(cand.tier === 1 ? 4 : 3, gk, weekCount(), cand.p, cand.tier,
              target.dayIdx || 0, st, loadKindOf(cand), cand.n, _s) };
          const fitted = fitDayToTime(next, peakWeek(st));
          if(target.stages && target.stages[st]) target.stages[st] = fitted;
          if(st === 0) target.exercises = fitted;
        }
      }
    });
  }
  return plan;
}
export function buildDay(dayKey, dayIndex, used, ctx, seedIn){
  const _s = pgCtx(ctx);
  const tpl = DAYS[dayKey];
  if(!tpl) return [];
  // repeating the same day shape (full body ×4) should reuse the big lifts, not exhaust the bank
  const repeated = dayKey.indexOf('full') === 0;
  const seed = ((seedIn != null ? seedIn : state.seed) || 1) * 31 + dayIndex * 977;
  const wanted = wantedGroups(), taken = new Set(), out = [];
  /* A power day opens with plyometric slots, which are never the day's loadable compounds. The
     compound guard counts the strength slots themselves — keyed to the index, the squat and the
     hinge on a power day fell outside it and an accessory could outscore a real compound. */
  let strengthSeen = 0;
  tpl.slots.forEach((slot, si)=>{
    const isPow = /^plyo/.test(slot) || slot.indexOf('oly') === 0;
    const primary = isPow ? si < 2 : strengthSeen < 2;
    if(!isPow) strengthSeen++;
    const m = pickForSlot(slot, seed + si*131, taken, repeated && si === 0 && dayIndex < 2 ? null : used, wanted, primary, _s);
    if(!m) return;
    taken.add(m.n); if(used) used.add(m.n);
    /* Set counts follow training age. A novice adapts to far less work than a trained lifter and
       recovers from it more slowly, so four or five sets of a bench press is volume they cannot
       use — the NSCA gives an untrained lifter one to three sets per exercise, and only advanced
       lifters the upper end. The focus bonus is capped inside the same ceiling. */
    const cap = _s.exp === 'beginner' ? 3 : _s.exp === 'advanced' ? 5 : 4;
    /* Experience does NOT buy more sets. Raising the advanced base to five pushed weekly volume
       past the recovery ceiling, so the governor trimmed it back — and because it trims the least
       compound work first, what came out was three main lifts at three sets and one at five:
       less work on the main lifts than an intermediate got, arranged incoherently. The ceiling is
       the binding constraint, so experience has to show up somewhere the ceiling does not govern —
       the technical difficulty of the movements, and how close to failure the sets are taken. */
    let sets = Math.min(cap, m.tier === 1 ? (_s.exp === 'beginner' ? 3 : 4) : 3);
    if(m.g.some(g=>wanted.has(g))) sets = Math.min(cap, sets + 1);
    out.push(Object.assign({}, m, {sets}));
  });
  // if injuries or equipment thinned the day, top it back up from the same regions
  if(out.length < Math.min(6, tpl.slots.length)){
    const regions = new Set(); out.forEach(m=>m.g.forEach(g=>regions.add(g)));
    BANK.forEach(m=>{
      if(out.length >= Math.min(6, tpl.slots.length)) return;
      if(taken.has(m.n) || !equipPick(m).include) return;
      if(m.x.some(k=>_s.injuries.includes(k))) return;
      if((SKILL_PREF[_s.exp] || SKILL_PREF.intermediate)[(m.skill||2)-1] < -50) return;
      if(!m.g.some(g=>regions.has(g))) return;
      if(dupOf(out, m.n)) return;
      const l = ladderOf(m.n);
      if(l && ladderFams(out.map(x=>x.n)).has(l.fam)) return;
      if(!primaryOk(m) && hasLoadable() && out.length < 2) return;
      taken.add(m.n); if(used) used.add(m.n);
      out.push(Object.assign({}, m, {sets:3, filled:true}));
    });
  }
  /* Explosive first, then Olympic, then everything else, each group holding its relative
     order. Sorted on the way out so the top-up above cannot land a jump behind a squat. */
  const demand = m => /^plyo/.test(m.p || '') ? 0 : (m.p === 'oly' ? 1 : 2);
  return out.sort((a, b)=> demand(a) - demand(b));
}
/* ── program generation ──
   Explicit context, defaulting to the live setup, matching readiness/scoring/scheduling.
   The mid-function writes to state.seed and state.weeks inside composeProgram are deliberately
   left alone: buildDay, pickForSlot and buildStagesFor read them back, so moving them changes
   which program is produced. ctx: { exp, injuries, kit, emphasis, liftDays, weeks, ... } */
export function pgCtx(c){ return c || setup; }
export function splitFor(nLift){
  const pg = primaryGoal();
  const s = splitStyle();
  const table = s === 'full' ? SPLITS_FULL
    : s === 'ul' ? SPLITS_UL
    : s === 'mixed' ? SPLITS
    : pg === 'power' ? SPLITS_POWER : pg === 'health' ? SPLITS_HEALTH : SPLITS;
  const keys = (table[Math.max(1, Math.min(6, nLift))] || SPLITS[3]).slice();
  /* Focus days are gone. A dedicated day for one muscle caused the two worst faults this engine
     has had: it overwrote whichever day sat in the last slot — deleting the legs day on a
     three-day week, then the pull day once legs were protected — and it drove weekly volume for
     the focused muscle far past anything recoverable, because the incidental work from compound
     pressing and pulling is already substantial before a dedicated day is added on top. A split
     now covers the body evenly and emphasis is carried by load and progression instead. */
  return keys;
}
export function dayNames(keys){
  const count = {};
  return keys.map(k=>{
    const base = DAYS[k].label;
    count[base] = (count[base]||0) + 1;
    return count[base] > 1 ? base+' '+String.fromCharCode(64+count[base]) : base;
  });
}
export function adaptationNotes(ctx){
  const _s = pgCtx(ctx);
  const out = [];
  if(_s.emphasis.length) out.push('Emphasis on '+_s.emphasis.map(g=>GROUPS[g].label.toLowerCase()).join(' and ')+' — an extra set wherever those movements appear.');
  _s.injuries.forEach(k=> out.push(INJURIES[k].label+': '+INJURIES[k].note));
  const off = KIT_KEYS.filter(k=>!_s.kit[k]).map(k=>KIT[k].label.toLowerCase());
  if(off.length) out.push('Built without ' + off.join(', ') + ' — every movement works with the kit you have.');
  if(_s.exp === 'beginner') out.push('Beginner build: guided and simple movements only, the RPE targets sit a step lower, and every session fits inside ' + sessionCap() + ' minutes.');
  if(_s.exp === 'advanced') out.push('Advanced build: technical lifts and plyometrics are favoured where they fit the pattern.');
  return out;
}

/* What a filed-away program is called. Short — the goal it was built around, and how long it
   ran — because this only ever appears as a row in Program history. */
export const SET_RANGE = { strength:[3,6], power:[3,6], hypertrophy:[3,6], health:[2,4] };
/* The repetition-maximum continuum: heavy loads and few reps build strength and
   power, moderate loads and moderate reps build size, light loads and many reps
   build muscular endurance. Every prescription stays inside its goal's band. */
export const REP_RANGE = { strength:[3,6], power:[2,5], hypertrophy:[6,12], health:[10,20] };
/* Small muscles and tendon work tolerate — and want — far more reps than a
   compound lift. Calves, tibialis, adductors, rear delts, forearms and core all
   get their own band rather than being squeezed into the compound range. */
export const HIGH_REP_PATTERNS = {
  calf:[10,20], tib:[15,25], adductor:[10,18], forearm:[10,20],
  /* A lateral raise at thirty reps is not a lateral raise — the shoulder cannot hold a load
     worth lifting for that long, so it becomes a burn set with no mechanical tension. Twenty is
     already the top of what a side or rear delt gets. */
  delt_rear:[10,20], delt_side:[10,20], cuff:[12,20], chest_iso:[10,20],
  core_flex:[10,20], core_anti_ext:[10,20], tri:[8,15], bi:[8,15],
  /* Hip and hamstring isolation carries real load and real eccentric stress. Twenty reps of a
     hip thrust or a hamstring curl is a set nobody finishes with intent, and the pattern also
     holds movements that must never see high reps at all — see HIGH_DEMAND. */
  glute:[8,15], ham_iso:[8,15], quad_iso:[8,15]
};
/* Movements whose demand per rep is high enough that a long set is the wrong prescription
   whatever band the pattern sits in. A Nordic curl is a maximal eccentric; a heavy hip thrust
   is a loaded hip extension; a reverse Nordic loads the knee under a long lever. Sets of these
   end because the tissue is done, not because a rep target was reached — so they are held to a
   short window regardless of pattern, day role or block. */
export const HIGH_DEMAND = {
  'Nordic Curl':[4,8], 'Reverse Nordic Curl':[5,10], 'Glute-Ham Raise':[5,10],
    'Barbell Hip Thrust':[6,12], 'Single-Leg Hip Thrust':[6,12],
  'Copenhagen Plank':[5,10], 'Sliding Leg Curl':[6,12], 'Razor Curl':[5,10],
  'Forearm Roller':[8,12]
};
/* Rep targets land on numbers people actually program: evens, anything ending
   in 5, and the low-rep 3. No 11s, 13s, 17s or 19s. */
export const okReps = n => n === 3 || n % 2 === 0 || n % 5 === 0;
export function evenIn(n, band){
  const lo = Math.max(2, band[0]), hi = Math.max(lo, band[1]);
  const start = Math.max(lo, Math.min(hi, Math.round(n)));
  if(okReps(start)) return start;
  for(let d = 1; d <= hi - lo + 1; d++){       // nearest acceptable rep, rounding up on a tie
    if(start + d <= hi && okReps(start + d)) return start + d;
    if(start - d >= lo && okReps(start - d)) return start - d;
  }
  return start;
}
export function evenReps(text, band){
  const nums = String(text).match(/\d+/g);
  if(!nums) return text;
  const snapped = nums.map(x=>evenIn(+x, band));
  let k = 0;
  let out = String(text).replace(/\d+/g, ()=> snapped[k++]);
  if(snapped.length === 2 && snapped[0] === snapped[1] && /–/.test(out)) out = '×' + snapped[0];
  return out;
}
export function repBandFor(goalKey, pattern, moveName){
  const base = REP_RANGE[goalKey] || REP_RANGE.hypertrophy;
  /* A named high-demand movement overrides everything: its own tolerance is the constraint,
     not the goal's band and not its pattern's. */
  const hd = moveName && HIGH_DEMAND[moveName];
  if(hd) return hd;
  const hi = HIGH_REP_PATTERNS[pattern];
  if(!hi || goalKey === 'strength' || goalKey === 'power') return base;
  return [Math.max(base[0], hi[0]), Math.max(base[1], hi[1])];
}

/* Execution styles, as used in a real program: the same movement gets harder by
   how it is performed, not only by what is on the bar. Assigned by block phase so
   technique work sits where it belongs — accumulation and tissue weeks, not peaks. */
/* Waved loading, as your bank prescribes it: a main lift descends across its
   sets — 8/6/4 — climbing load as the reps drop, rather than repeating one number.
   Applied to compounds on strength-leaning blocks; accessories stay straight. */
export function waveSets(sets, reps, gk, pattern, tier, ctx){
  const _s = pgCtx(ctx);
  if(tier > 1) return null;
  if(gk !== 'strength' && gk !== 'power' && gk !== 'hypertrophy') return null;
  if(HIGH_REP_PATTERNS[pattern]) return null;         // a 20-rep wave is not a wave
  if((_s.exp || 'intermediate') === 'beginner') return null;   // one rep target to learn
  const band = REP_RANGE[gk] || REP_RANGE.hypertrophy;
  const nums = String(reps).match(/\d+/g);
  if(!nums) return null;
  const top = evenIn(Math.min(band[1], +nums[nums.length - 1]), band);
  // The step has to fit the band. A fixed 2 bottoms out and repeats the floor —
  // that is where 6/4/2/2 came from. Derive it from the room actually available.
  const room = top - evenIn(band[0], band);
  if(sets < 2 || room < sets - 1) return null;          // no true descent possible
  const step = Math.max(1, Math.floor(room / (sets - 1)));
  const out = [];
  for(let i = 0; i < sets; i++) out.push(evenIn(Math.max(band[0], top - i * step), band));
  return new Set(out).size === out.length ? out.join('/') : null;
}

export const STYLES = {
  pause:{ label:'1s pause in the stretch', for:/^(hpress|ipress|chest_iso|hpull|vpull|squat|legpress|lunge)$/ },
  quarter:{ label:'1 and ¼ reps', for:/^(lunge|squat|legpress|quad_iso|ham_iso|hpress)$/ },
  half:{ label:'1 and ½ reps', for:/^(lunge|glute|bi|delt_side|hpull)$/ },
  iso:{ label:'hold the last rep 20s', for:/^(quad_iso|ham_iso|adductor|core_anti_ext|cuff|carry)$/ },
  drop:{ label:'drop set on the last one — cut the weight about 25% and keep going', for:/^(delt_side|delt_rear|bi|tri|chest_iso|calf|quad_iso)$/ },
  cluster:{ label:'rest 15s mid-set, then finish', for:/^(vpull|hpull|dip|delt_rear|adductor)$/ },
  velocity:{ label:'fast up, slow down', for:/^(plyo_lower|plyo_upper|oly|squat|hinge)$/ },
  /* A slow eccentric belongs on the big compounds, not only on curls — it was the one
     technique the presses and squats could not take, which left them with a single legal
     cue and nothing to rotate through when the movement itself has to stay. */
  eccentric:{ label:'3s lowering', for:/^(hinge|ham_iso|bi|tri|calf|forearm|glute|hpress|ipress|squat|legpress|lunge|hpull|vpull)$/ },
  toppause:{ label:'1s squeeze at the top', for:/^(glute|delt_side|delt_rear|quad_iso|hpull|core_anti_ext|ipress|vpull)$/ },
  amrap:{ label:'last set to failure', for:/^(dip|vpull|hpress|core_flex)$/ }
};
/* One technique per exercise per block, and only on the weeks that suit it. */
/* Which techniques a trainee has earned. Beginners groove the pattern with tempo
   and pauses only — drop sets, clusters, AMRAP and partial-rep schemes add fatigue
   and technical demand that a novice should not be carrying. */
export const STYLE_LEVEL = {
  pause:'beginner', eccentric:'beginner', toppause:'beginner',
  quarter:'intermediate', half:'intermediate', iso:'intermediate', velocity:'intermediate',
  drop:'advanced', cluster:'advanced', amrap:'advanced'
};
export const LEVEL_RANK = { beginner:0, intermediate:1, advanced:2 };
export function styleAllowed(key, ctx){
  const _s = pgCtx(ctx);
  const need = LEVEL_RANK[STYLE_LEVEL[key] || 'intermediate'];
  const have = LEVEL_RANK[_s.exp || (state.setup && state.setup.exp) || 'intermediate'];
  return have >= need;
}
export function styleFor(pattern, week, tier, off, ctx, totalIn){
  if(!pattern) return '';
  const n = totalIn || weekCount(), ph = phaseOf(week, n);
  if(ph === 3) return '';                             // easy week is plain
  // accumulation weeks take stretch and tempo work; the harder week takes
  // range and density tricks; the heavy week keeps it clean and fast.
  const order = ph === 0 ? ['pause','eccentric','toppause','iso']
    : ph === 1 ? ['quarter','half','drop','cluster','amrap','eccentric']
    : ['velocity','pause','toppause'];
  /* Taking the first match meant a movement that survived every stage also carried the
     identical cue in every stage — eight weeks of the same lift and the same instruction.
     Rotate through everything that fits the pattern instead, so when the movement cannot
     change the execution does. */
  const fits = order.filter(k=>STYLES[k].for.test(pattern) && styleAllowed(k, ctx));
  if(!fits.length) return '';
  const pick = fits[((off || 0) % fits.length + fits.length) % fits.length];
  if(tier === 1 && pick === 'amrap') return '';       // not on a heavy compound
  return STYLES[pick].label;
}
/* Successive blocks follow the preparatory → transition progression: volume comes
   down, intensity goes up. Block 1 accumulates work, block 2 makes it heavier,
   block 3 realises it as strength or power. */
export const BLOCK_PHASE = [
  { key:'base',  label:'base',  repShift:0, setShift:0 },
  { key:'build', label:'build', repShift:-2, setShift:0 },
  { key:'peak',  label:'peak',  repShift:-4, setShift:-1 }
];
/* Which of the three blocks a week belongs to, scaled to the program's real length.
   Counting fixed four-week waves meant only a 12-week program ever reached the peak
   block, so an 8-week program stopped at 'build' and every fix living in 'peak' was
   unreachable. Spanning the length instead gives base → build → peak whatever the
   program is: 8 weeks lands 3/2/1 across the hard weeks, 12 weeks lands 4/4/4. */
export function blockIndex(week, total){
  const n = Math.max(1, total || weekCount());
  return Math.max(0, Math.min(2, Math.floor((week - 1) * 3 / n)));
}
/* Cutting reps without adding sets cuts volume — right for a strength or power peak,
   where the aim is to express strength on fresh tissue, and wrong for size, where
   weekly hard-set volume is the primary driver. Reps descend in every block, so on a
   size goal each later block ADDS a set to hold volume while load rises. This applies
   from 'build' onward, not only at the peak: 'build' carries the same −2 rep cut. */
export const BLOCK_SET_SHIFT = {
  // reps fall 0 / −2 / −4 across the blocks, so the compensation scales with the cut
  hypertrophy:[0, 1, 2],
  health:[0, 0, 0],
  strength:[0, 0, -1],
  power:[0, 0, -1]
};
export function blockPhase(week, goalKey, total, ctx){
  const bi = blockIndex(week, total);
  const bp = BLOCK_PHASE[bi];
  const row = BLOCK_SET_SHIFT[goalKey || primaryGoal(ctx)];
  return row ? Object.assign({}, bp, { setShift:row[bi] }) : bp;
}
/* A small muscle's band can be 15 reps wide. Prescribing the whole span — "×10–25"
   every week for twelve weeks — is not a prescription: the same 10 reps satisfies it
   forever, and nothing progresses. Take a narrow window of the band instead and walk
   it downward block by block, so reps fall as load rises. */
/* A window into the band, positioned by the block AND by the day's role. The role used to be
   computed and then thrown away here: every small-muscle movement got its window from the block
   alone, so a heavy lower-body day and a volume lower-body day printed identical rep targets —
   and since most lower-body accessories are small-muscle patterns, the undulation the split
   promised was invisible on exactly the days it mattered. A heavy day sits at the bottom of the
   band, a volume day at the top. */
export function bandWindow(band, blockIdx, role){
  const lo = band[0], hi = band[1], span = hi - lo;
  const width = Math.max(2, Math.round(span * 0.28));
  /* The role picks the window, the block nudges it. Positioning by block first and then offsetting
     by role meant a moderate day already sat at the top of the band, so the volume offset had
     nowhere to go and the two printed the same numbers — the undulation existed in the RPE and
     nowhere else. Heavy takes the bottom of the band, moderate the middle, volume the top, and
     later blocks pull each of them down as intensity rises. */
  const seat = { heavy:lo, moderate:lo + Math.round((span - width) * 0.5), volume:hi - width };
  let a = seat[role] !== undefined ? seat[role] : lo + Math.round((span - width) * 0.5);
  a -= Math.round(Math.min(2, blockIdx) * span * 0.14);
  a = Math.max(lo, Math.min(hi - width, a));
  return '×' + evenIn(a, band) + '–' + evenIn(a + width, band);
}
/* Shift a rep prescription toward the heavy end of its own band. */
export function shiftReps(reps, by, goalKey, pattern, moveName){
  const band = repBandFor(goalKey, pattern, moveName);
  const nums = String(reps).match(/\d+/g);
  if(!nums || !by) return reps;
  const moved = nums.map(x=>Math.max(band[0], Math.min(band[1], +x + by)));
  let out = String(reps), k = 0;
  out = out.replace(/\d+/g, ()=> moved[k++]);
  return moved.length === 2 && moved[0] === moved[1] ? '×' + moved[0] : out;
}
export function clampSets(n, goalKey){
  const r = SET_RANGE[goalKey] || SET_RANGE.hypertrophy;
  return Math.max(r[0], Math.min(r[1], n || 3));
}
/* Non-linear (daily undulating) periodization. Every session of a week previously got
   the identical prescription, so the only variation in the whole program was the slow
   descent from week to week — linear by definition. Real undulation varies the stimulus
   BETWEEN sessions of the same week: one heavy day, one moderate, one for volume, each
   progressing across weeks. Roles stay pinned to the day so a lifter can track them.
   Accessories are left alone — undulating a lateral raise is noise, not a stimulus. */
export const DUP = [
  { key:'heavy',    repShift:-2, rpe: 1 },
  { key:'moderate', repShift: 0, rpe: 0 },
  { key:'volume',   repShift: 2, rpe:-1 }
];
/* Undulating means the QUALITY a body part is trained for changes, not just that three
   different days exist. Keying the role to the day index alone made Push permanently heavy,
   Pull permanently moderate and Legs permanently volume — three static linear tracks running
   side by side, which is the opposite of what the split was meant to do. The chest never saw
   a volume week and the quads never saw a heavy one.

   Rotating by week as well means every body part cycles through all three qualities. Over a
   three-week turn Push runs heavy → moderate → volume while Pull runs moderate → volume →
   heavy, so each session still has a distinct role within its week and each body part still
   gets the full spread across the block. Deload weeks flatten this out in genTargets. */
export function dupFor(dayIdx, week, total){
  if(dayIdx === null || dayIdx === undefined) return null;
  const w = Math.max(1, week || state.week || 1);
  /* A deload week carries no role: the prescription already flattens on it, so labelling the
     card "heavy day" on the week you are deliberately backing off would contradict the
     numbers printed underneath. */
  if(phaseOf(w, total || weekCount()) === 3) return null;
  /* Step by two, not one. Rotating one role per week moved the offset (+1/0/−1) in exact
     lockstep against the phase ramp that rises a point a week, so the two cancelled and a
     body part sat at the same RPE for the whole block — undulating on paper, flat in the
     numbers. Two is coprime with three, so every body part still meets all three qualities
     and each week still holds three distinct roles, without the offsets lining up. */
  /* The role turns with the STAGE, not the week. A block over four weeks runs each workout twice
     before it shifts — the first exposure is calibration, the second is when the effort lands
     where it was prescribed — and week two is issued as a copy of week one for exactly that
     reason. Rotating the role weekly meant that copy carried week one's role into a week the
     rest of the app believed was a different one: a session prescribed as moderate, labelled
     heavy, with the heavy rep cap never applied. Both weeks of a stage now share a role, so the
     repeat is coherent, and the role still turns every stage so each body part meets all three
     qualities across the block. */
  const L = (total || weekCount()) <= 4 ? 1 : 2;
  const stage = Math.floor((w - 1) / L);
  return DUP[(dayIdx + 2 * stage) % DUP.length];
}
/* ── Movements measured in time, not reps ────────────────────────────────────────
   "11 reps of a dead hang" is not a prescription anyone can follow. A hang, a plank, a carry and
   an isometric are all held, so they are prescribed in seconds — and only they are. Detected by
   name and pattern so it holds across the whole bank rather than a hand-kept list of exceptions. */
export const TIMED_RE = /\b(plank|hold|carry|isometric|wall sit|l-sit|bird dog|dead bug|suitcase|copenhagen|pallof|bracing|breathing)\b/i;
/* "Hang" is the trap: a dead hang is held, a hang power clean is an explosive pull from the hang
   position. Matching the word alone prescribed an Olympic lift as four sets of thirty seconds. */
export const HANG_RE = /\bhang\b/i;
export const NOT_TIMED_RE = /\b(clean|snatch|jerk|pull|row|press|curl|raise|swing|jump|throw|squat|deadlift|lunge|step|thrust|bridge|fly|extension|pushdown|pressdown)\b/i;
export function isTimedMove(m){
  if(!m) return false;
  const n = m.n || '';
  if(NOT_TIMED_RE.test(n)) return false;         // a movement with a rep is never a hold
  if(TIMED_RE.test(n)) return true;
  return HANG_RE.test(n);
}
/* How long a hold should last depends first on WHAT is being held. Every timed movement in the
   bank used to get the same number off the week's adaptation alone, so a dead hang, a farmer
   carry, a wall sit and a bird dog were all prescribed 30 seconds — and on a strength week all
   of them dropped to 20, which is under the useful stimulus for most of them. The movement's
   own pattern sets the base; the week's adaptation scales it. */
export const HOLD_BASE = {
  core_anti_ext:40,        // plank, hollow hold, dead bug — the long-lever anti-extension work
  core_anti_rot:35,        // bird dog, pallof walkout — control, not endurance
  core_anti_lat:35,        // side plank, one side at a time
  carry:40,                // loaded carries are usually run 30–45s a side
  quad_iso:45,             // wall sits are cheap to hold and want real time under tension
  ham_iso:35,
  calf:35,
  vpull:35,                // dead hang — grip gives out first
  adductor:25              // Copenhagen planks are brutal; 25s is already a real set
};
export function holdSecs(goalKey, week, total, pattern){
  const base = HOLD_BASE[pattern] || HOLD_DEFAULT;
  const a = ADAPT[adaptFor(goalKey, week, total)];
  let k = 1;
  if(a === ADAPT.maxstrength || a === ADAPT.power) k = 0.7;      // shorter, usually loaded
  else if(a === ADAPT.strhyp) k = 0.85;
  else if(a === ADAPT.endurance || a === ADAPT.hyphigh) k = 1.4;
  /* A deload that shortens every set except the isometrics is not a deload. */
  if(phaseOf(week, total || weekCount()) === 3) k *= 0.75;
  return Math.max(20, Math.round(base * k / 5) * 5);
}
/* The last word on a rep count. Every shift — block, undulation, small-muscle window — happens
   before this, so snapping here is the only way an awkward number cannot survive. */
export function snapTarget(text, band, timedSecs){
  let s = String(text);
  if(timedSecs){
    /* A held movement takes seconds in place of the rep count, and a rep range collapses to one
       number: there is no such thing as "10–12 seconds" as a target. */
    return s.replace(/×\s*[\d–\/]+/, '×' + timedSecs + 's');
  }
  return s.replace(/×\s*([\d–\/]+)/, (full, nums)=>
    '×' + nums.split(/([–\/])/).map(part=>
      /^\d+$/.test(part) ? evenIn(+part, band) : part).join(''));
}
export function genTargets(sets, goalKey, total, pattern, tierIn, dayIdx, styleOff, loadKind, moveName, ctx){
  const _s = pgCtx(ctx);
  const timedMove = isTimedMove(byName[moveName] || (moveName ? { n:moveName, p:pattern } : null));
  const model = GOAL_MODELS[goalKey || primaryGoal(ctx)];
  const shift = (EXP_ADJ[_s.exp] && EXP_ADJ[_s.exp].rpeShift) || 0;
  const s = clampSets(sets, goalKey || primaryGoal(ctx)), n = total || _s.weeks || 4;
  const out = [];
  const gk = goalKey || primaryGoal(ctx);
  const range = SET_RANGE[gk] || SET_RANGE.hypertrophy;
  for(let i = 1; i <= n; i++){
    const ph = phaseOf(i, n), w = model.weeks[ph], bp = blockPhase(i, gk, n, ctx), bi = blockIndex(i, n);
    const easy = ph === 3;                                 // the block's easy week
    /* The day's role applies to every movement on the day, not only the ones that carry it.
       Restricting it to the main lifts is why a heavy lower-body day and a volume lower-body day
       printed identical rep targets for their accessories — and lower-body accessories are most
       of a lower-body session. A heavy day is heavy from the first movement to the last. */
    const du = (_s.liftDays || 3) > 1 ? dupFor(dayIdx, i, n) : null;
    /* One role per week, read once. The role was being consulted separately for the rep shift, the
       band window, the heavy cap and the printed label, and on one week of the block those reads
       disagreed — a session printed "heavy day" above a fourteen-rep target. Whatever the cause,
       four independent lookups of the same fact is the bug behind it: there is now a single value
       and everything downstream reads that. */
    const duKey = easy ? null : (du && du.key) || null;
    const duShift = easy || !du ? 0 : du.repShift;
    let rpe = w.rpe;
    if(typeof rpe === 'number'){
      const bump = easy ? 0 : bi;
      const dupR = easy || !du ? 0 : du.rpe;
      rpe = 'RPE ' + Math.max(4, Math.min(9, rpe + shift + bump + dupR));
    }
    const band = repBandFor(gk, pattern, moveName);
    let reps = easy ? w.reps : shiftReps(w.reps, bp.repShift + duShift, gk, pattern, moveName);
    // a small muscle works in its own band — as a window moved by the block and the day's role
    if(!easy && band !== (REP_RANGE[gk] || REP_RANGE.hypertrophy)){
      reps = bandWindow(band, bi, duKey);
    }
    /* A heavy day is heavy. Whatever band a movement sits in, a long set cannot be performed at
       the load a heavy day is asking for — so the rep target is capped rather than left to the
       band, which is how an eighteen-to-twenty-four-rep prescription ended up on a day labelled
       heavy. Deloads are exempt: those are meant to be light and long. */
    if(duKey === 'heavy'){
      const HEAVY_MAX = 12;
      reps = String(reps).replace(/\d+/g, x=>Math.min(HEAVY_MAX, +x));
      const nn = String(reps).match(/\d+/g) || [];
      if(nn.length === 2 && nn[0] === nn[1]) reps = '×' + nn[0];
    }
    /* styleFor keeps deriving its phase from weekCount(), not from genTargets' own n. In the
       original the two were allowed to differ — genTargets took its n from the argument or
       setup.weeks, styleFor from weekCount() — and unifying them changes which weeks get a
       style cue. The context is still passed so styleAllowed follows it. */
    const style = easy ? '' : styleFor(pattern, i, tierIn || 1, styleOff, ctx);
    /* Set growth across a block is capped at one. Later blocks were adding two sets to every
       movement, and because a base count already sits at its own floor the volume governor had
       nothing left to trim — the peak was pinned above the weekly ceiling no matter what it did,
       so a six-day week finished its last block at nearly double a recoverable volume. One added
       set is a real progression; the rest of the overload belongs to load and reps, which is where
       this engine already puts it. */
    const grow = Math.min(1, bp.setShift || 0);
    const sets = easy ? Math.max(range[0], s - 1)
      : Math.max(range[0], Math.min(range[1], s + grow));
    const wave = easy ? null : waveSets(sets, reps, gk, pattern, tierIn || 2, ctx);
    const repText = snapTarget(evenReps(wave ? '×' + wave : reps, band), band,
      timedMove ? holdSecs(gk, i, n, pattern) : 0);
    const role = duKey && duKey !== 'moderate' ? ' · ' + duKey + ' day' : '';
    /* Load sits straight after the sets and reps — the prescription is incomplete
       without it, and it is what makes the week's adaptation actionable. */
    const repNums = String(repText).match(/\d+/g);
    const repAvg = repNums ? repNums.reduce((a, x)=>a + +x, 0) / repNums.length : null;
    /* RPE is already on this line and the session screen spells it out in words, so a RIR
       token beside it says the same thing twice. Only a percentage carries information RPE
       does not. */
    const lt = loadKind ? loadText(loadKind, gk, i, n, repAvg, rpe) : '';
    const load = lt && !/RIR$/.test(lt) ? ' · ' + lt : '';
    out.push(sets + repText + load + ' · ' + rpe + role + (style ? ' · ' + style : '') + (w.note ? ' · ' + w.note : ''));
  }
  /* On anything six weeks or longer the first two weeks are the same session twice. The first
     pass is spent finding where the weight sits and learning the movement; only on the second
     does the effort land where it was prescribed. Progressing between them would be
     progressing off a number that was never a real attempt. */
  if(n >= 6 && out.length > 1) out[1] = out[0];
  return out;
}
export function genWeekNames(goalKey, total, ctx){
  const _s = pgCtx(ctx);
  const model = GOAL_MODELS[goalKey || primaryGoal()];
  const n = total || _s.weeks || 4, names = [];
  for(let i = 1; i <= n; i++){
    const w = model.weeks[phaseOf(i, n)];
    const ad = ADAPT[adaptFor(goalKey || primaryGoal(), i, n)];
    const wave = ad ? ' · ' + ad.label : '';
    names.push('Wk ' + i + ' · ' + w.name + wave);
  }
  /* Weeks 1 and 2 carry the same prescription on a six-week-or-longer block, so they carry the
     same name — labelling them differently would imply a change that is not there. */
  if(n >= 6 && names.length > 1) names[1] = 'Wk 2 · ' + names[0].replace(/^Wk 1 · /, '') + ' (repeat)';
  return names;
}
/* ══════════ RUNNING ══════════
   Every session is a list of segments — warm-up, work, recovery, cool-down — each with
   its own distance and pace, so a session reads as instructions rather than a slogan. */
export const RUN_EXP = {
  newrun:{ label:'New to running', blurb:'Run-walk intervals and short easy sessions. Nothing at a hard pace yet.',
    vol:0.6, maxHard:2, walk:true, maxDays:4 },
  some:{ label:'Been running a while', blurb:'Comfortable running twenty to thirty minutes. Adds tempo and controlled intervals.',
    vol:1, maxHard:3, walk:false },
  strong:{ label:'Experienced runner', blurb:'Regular weekly mileage. The full range of threshold and interval work.',
    vol:1.3, maxHard:3, walk:false }
};
export function runExp(){ return RUN_EXP[state.runExp || (state.setup && state.setup.runExp) || 'some'] || RUN_EXP.some; }
/* A session too hard for the level is swapped for the nearest gentler one. */
export const SOFTEN = { speed:'strides', vo2:'tempo', hills:'strides', racepace:'tempo' };
export function levelType(type){
  const lv = runExp();
  let t = type, guard = 0;
  while(RUN_SESSIONS[t] && RUN_SESSIONS[t].hard > lv.maxHard && SOFTEN[t] && guard++ < 4) t = SOFTEN[t];
  return t;
}
export const mi2 = x => Math.round(x * 20) / 20;
export const RUN_SESSIONS = {
  easy:{ label:'Easy', hard:0, legs:1, base:[3, 3.5, 4, 2.5] },
  easy2:{ label:'Easy', hard:0, legs:1, base:[2.5, 3, 3, 2] },
  recovery:{ label:'Recovery', hard:0, legs:0, base:[2, 2.5, 2.5, 2] },
  long:{ label:'Long', hard:1, legs:3, base:[5, 6, 7, 4] },
  strides:{ label:'Strides', hard:0, legs:1, base:[2.5, 3, 3, 2], reps:[6, 6, 8, 4] },
  tempo:{ label:'Tempo', hard:2, legs:2, reps:[1, 1, 2, 1], work:[2.5, 3, 1.75, 1.75], rest:'3 min jog' },
  racepace:{ label:'Race pace', hard:2, legs:2, reps:[3, 4, 2, 2], work:[1, 1, 2, 1], rest:'2 min jog' },
  hills:{ label:'Hills', hard:2, legs:3, reps:[8, 10, 8, 6], secs:[45, 45, 90, 30], rest:'jog down' },
  vo2:{ label:'VO2 max', hard:3, legs:3, reps:[5, 4, 5, 3], metres:[800, 1000, 1000, 800], rest:'jog for as long as the rep took (1:1)' },
  speed:{ label:'Speed', hard:3, legs:3, reps:[8, 6, 10, 6], metres:[200, 400, 400, 200], rest:'full recovery — about 5× the rep' }
};
/* Build the segment list for one session. */
export function runSegments(type, ph, wave, goalKey){
  const s = RUN_SESSIONS[type], lv = runExp();
  const g = RUN_GOALS[goalKey || state.runGoal || 'maintain'];
  const grow = 1 + 0.1 * Math.max(0, wave - 1);
  const scale = lv.vol * (ph === 3 ? 1 : grow);
  const segs = [];

  if(type === 'easy' || type === 'easy2' || type === 'recovery' || type === 'long'){
    let d = (type === 'long' && g && g.longMi) ? g.longMi[ph] : s.base[ph];
    d = mi2(d * scale);
    if(lv.walk && type !== 'recovery'){
      const blocks = Math.max(3, Math.round(d * 2));
      segs.push({ kind:'work', mi:d, type:type === 'long' ? 'long' : 'easy',
        label:'Run-walk', note: blocks + ' × (4 min running / 1 min walking)' });
    } else {
      segs.push({ kind:'work', mi:d, type, label: type === 'recovery' ? 'Recovery run' : type === 'long' ? 'Long run' : 'Easy run',
        note: type === 'recovery' ? 'very easy — flush the legs' : 'conversational' });
    }
    return segs;
  }

  if(type === 'strides'){
    segs.push({ kind:'work', mi:mi2(s.base[ph] * scale), type:'easy', label:'Easy run', note:'conversational' });
    segs.push({ kind:'work', reps:s.reps[ph], secs:20, type:'strides', label:'Strides',
      note:'near top speed, relaxed', rest:'walk back' });
    return segs;
  }

  // quality sessions get a real warm-up and cool-down
  const warm = type === 'tempo' ? 0.75 : 1;
  segs.push({ kind:'warm', mi:mi2(warm * (lv.vol < 1 ? 0.8 : 1)), type:'easy', label:'Warm-up', note:'conversational' });

  if(s.work){
    let reps = s.reps[ph], work = s.work[ph];
    if(lv.vol < 1){ work = mi2(Math.max(0.5, work * 0.7)); reps = Math.max(2, reps - 1); }
    else if(lv.vol > 1.2) reps = reps + (ph === 3 ? 0 : 1);
    segs.push({ kind:'work', reps, mi:work, type, label: type === 'racepace' ? 'At goal race pace' : 'Tempo', rest:s.rest });
  } else if(s.metres){
    let reps = s.reps[ph];
    if(lv.vol > 1.2) reps += (ph === 3 ? 0 : 2);
    segs.push({ kind:'work', reps, metres:s.metres[ph], type, label: type === 'vo2' ? 'Hard repeats' : 'Fast repeats', rest:s.rest });
  } else if(s.secs){
    let reps = s.reps[ph];
    if(lv.vol > 1.2) reps += (ph === 3 ? 0 : 2);
    segs.push({ kind:'work', reps, secs:s.secs[ph], type, label:'Uphill repeats', note:'hard up', rest:s.rest });
  }

  segs.push({ kind:'cool', mi:mi2(0.5 * (lv.vol < 1 ? 0.8 : 1)), type:'recovery', label:'Cool-down', note:'very easy' });
  return segs;
}
/* Distance and time a segment list adds up to. */
export function segMiles(seg){
  if(seg.mi && seg.reps) return seg.mi * seg.reps;
  if(seg.mi) return seg.mi;
  if(seg.metres) return (seg.metres * (seg.reps || 1)) / 1609;
  if(seg.secs && seg.reps) return (seg.secs * seg.reps / 60) / 8;   // rough: hard running, ~8 min/mi
  return 0;
}
export function totalMiles(segs){ return mi2(segs.reduce((n,s)=> n + segMiles(s), 0)); }
export function segPace(seg, goalKey){ return paceFor(seg.type, goalKey); }
export function segLine(seg, goalKey){
  const bits = [];
  if(seg.reps && seg.mi) bits.push(seg.reps + ' × ' + seg.mi + ' mi');
  else if(seg.reps && seg.metres) bits.push(seg.reps + ' × ' + seg.metres + 'm');
  else if(seg.reps && seg.secs) bits.push(seg.reps + ' × ' + seg.secs + 's');
  else if(seg.mi) bits.push(seg.mi + ' mi');
  if(seg.label === 'Run-walk' && seg.note) bits.push(seg.note);   // the instruction is the point
  const p = segPace(seg, goalKey);
  if(p) bits.push(p);
  else bits.push(seg.note || EFFORT_WORD[seg.type] || 'by effort');
  if(seg.rest) bits.push(seg.rest + ' between');
  return bits.join(' · ');
}
export const RUN_GOALS = {
  none:{ label:'Not running', blurb:'Lifting only', mix:[] },
  maintain:{ label:'Stay aerobically fit', blurb:'Keeps your engine without denting your lifting',
    mix:['easy','long','recovery','strides','easy2','tempo'] },
  speed:{ label:'Get faster', blurb:'Short, sharp intervals and strides',
    mix:['speed','easy','strides','recovery','tempo','easy2'] },
  vo2:{ label:'Build VO2 max', blurb:'Hard, repeatable repeats of three to five minutes',
    mix:['vo2','easy','tempo','recovery','easy2','strides'] },
  endurance:{ label:'Build distance', blurb:'A progressive long run on an easy base',
    mix:['long','easy','easy2','recovery','tempo','strides'] },
  race5k:{ label:'Race a 5K', blurb:'VO2 repeats plus goal-pace work',
    mix:['vo2','easy','racepace','recovery','easy2','long'], longMi:[4, 4.5, 5, 3] },
  race10k:{ label:'Race a 10K', blurb:'Tempo and threshold work',
    mix:['tempo','easy','vo2','recovery','long','easy2'], longMi:[5, 6, 7, 4] },
  racehalf:{ label:'Race a half marathon', blurb:'Long runs and sustained tempo',
    mix:['long','easy','tempo','recovery','racepace','easy2'], longMi:[7, 8, 10, 5.5] },
  racemarathon:{ label:'Race a marathon', blurb:'Volume first — everything else easy',
    mix:['long','easy','easy2','recovery','racepace','tempo'], longMi:[10, 12, 14, 7] },
  hills:{ label:'Build hill strength', blurb:'Uphill repeats — running\'s heavy set',
    mix:['hills','easy','strides','recovery','long','easy2'] }
};
/* Training paces derived from your current easy pace, in seconds per mile. */
export const PACE_OFFSET = { recovery:50, easy:0, easy2:10, long:15, strides:null, tempo:-65, speed:-135, vo2:-110, racepace:0, hills:null };
export const RACE_OFFSET = { race5k:-110, race10k:-90, racehalf:-55, racemarathon:-35 };
export const EFFORT_WORD = { recovery:'very easy', easy:'conversational', easy2:'conversational', long:'easy',
  tempo:'comfortably hard', racepace:'goal race effort', vo2:'hard but repeatable', speed:'fast, near flat out',
  strides:'near top speed', hills:'hard up, jog down' };
export function fmtSec(s){ return Math.floor(s/60) + ':' + String(Math.round(s%60)).padStart(2,'0'); }
export function paceFor(type, goalKey){
  const base = state.runPace || 0;
  if(!base) return null;
  let off = PACE_OFFSET[type];
  if(type === 'racepace') off = RACE_OFFSET[goalKey || state.runGoal] || -60;
  if(off === null || off === undefined) return null;
  const t = base + off, band = /easy|long|recovery/.test(type) ? 20 : 8;
  return fmtSec(t - band) + '–' + fmtSec(t + band) + '/mi';
}
export function runSession(type, week, goalKey){
  const t = levelType(type);
  const s = RUN_SESSIONS[t];
  const n = weekCount(), ph = phaseOf(week, n), wave = waveOf(week);
  const segs = runSegments(t, ph, wave, goalKey);
  const total = totalMiles(segs);
  const work = segs.find(x=>x.kind === 'work') || segs[0];

  // the one-line version used in lists
  const short = segs.length === 1
    ? segLine(segs[0], goalKey)
    : total + ' mi total · ' + segs.filter(x=>x.kind === 'work').map(x=>{
        if(x.reps && x.mi) return (x.reps > 1 ? x.reps + '×' + x.mi + ' mi ' : x.mi + ' mi continuous ') + (x.label || '').toLowerCase();
        if(x.reps && x.metres) return x.reps + '×' + x.metres + 'm';
        if(x.reps && x.secs) return x.reps + '×' + x.secs + 's';
        return x.mi + ' mi ' + (x.note || '');
      }).join(' + ');

  const pace = paceFor(work.type, goalKey);
  const est = state.runPace ? Math.round(segs.reduce((n2,x)=>{
    const off = PACE_OFFSET[x.type];
    const per = state.runPace + (off === null || off === undefined ? -60 : off);
    return n2 + segMiles(x) * per;
  }, 0) / 60) : null;

  return { type:t, label:s.label, hard:s.hard, legs:s.legs, segments:segs, miles:total,
    detail:short, pace, est,
    effort: pace ? null : (EFFORT_WORD[work.type] || null) };
}
/* ── pace, learned from what you actually run ── */
export const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
export function dowOf(iso){ return (new Date(iso + 'T12:00:00').getDay() + 6) % 7; }
/* ── scheduling ──
   Explicit context, defaulting to the live globals exactly as readiness and scoring do.
   ctx: { startDate, trainDows, liftDays, sched, plan, sessions, today } */
export function schCtx(c){
  return c || { startDate:setup.startDate, trainDows:setup.trainDows, liftDays:setup.liftDays,
                sched:state.sched, plan:state.plan, sessions:state.sessions, today:todayISO() };
}
export function startDow(ctx){ const c = schCtx(ctx); return dowOf(c.startDate || c.today || todayISO()); }
export function defaultDows(n){ return (LIFT_DOWS[Math.max(1, Math.min(6, n))] || []).slice(); }
export function trainDows(ctx){
  const c = schCtx(ctx);
  const d = (c.trainDows || []).filter(x=>x >= 0 && x < 7);
  return d.length === c.liftDays ? d.slice().sort((a,b)=>a-b) : defaultDows(c.liftDays);
}
/* Which days a toggle would leave you training, and why it might refuse. Pure, so the rule
   ("at least one, at most six") can be tested without a screen. */
export function nextTrainDows(cur, d){
  const days = (cur || []).slice();
  const i = days.indexOf(d);
  if(i > -1){
    if(days.length <= 1) return { days, refused:'You need at least one training day' };
    days.splice(i, 1);
  } else {
    if(days.length >= 6) return { days, refused:'Six training days is the most Trainlog will write' };
    days.push(d);
  }
  return { days: days.sort((a,b)=>a-b), refused:null };
}
export const LIFT_DOWS = { 1:[2], 2:[0,3], 3:[0,2,4], 4:[0,1,3,4], 5:[0,1,2,4,5], 6:[0,1,2,3,4,5] };
export const isLowerDay = name => /leg|lower|glute|quad|posterior/i.test(name || '');

/* Place runs around the lifting week: hard runs away from leg days, recovery runs after them. */
export function buildSchedule(liftNames, nRun, goalKey, startDow, chosenDows){
  const nLift = Math.max(0, Math.min(6, liftNames.length));
  const custom = chosenDows && chosenDows.length === nLift;
  const liftDows = custom ? chosenDows.slice().sort((a,b)=>a-b) : (LIFT_DOWS[nLift] || []).slice();
  const lifts = {};
  liftDows.forEach((d,i)=> lifts[d] = { name: liftNames[i], lower: isLowerDay(liftNames[i]) });
  const goal = RUN_GOALS[goalKey] || RUN_GOALS.maintain;
  const types = goal.mix.slice(0, Math.max(0, Math.min(6, nRun)));
  const runs = {};
  types.forEach(type=>{
    const s = RUN_SESSIONS[type];
    let best = -1, bestScore = -1e9;
    for(let d=0; d<7; d++){
      if(runs[d] !== undefined) continue;
      const here = lifts[d], next = lifts[(d+1)%7], prev = lifts[(d+6)%7];
      let sc = 0;
      if(here){
        // doubling up: fine when the run is easy or the lift is upper-body
        if(s.hard >= 2 && here.lower) sc -= 60;
        else if(s.hard >= 2) sc += 6;              // hard run on an upper day — least interference
        if(s.hard === 0 && here.lower) sc += 8;     // easy/recovery flushes the legs after squatting
        if(type === 'long') sc -= 25;
        sc -= 4;
      } else {
        sc += 14;                                   // a clear day is the best home for any run
        if(type === 'long') sc += 10;
      }
      if(next && next.lower && s.legs >= 2) sc -= 30;   // don't arrive at leg day flat
      if(prev && prev.lower && s.legs >= 3) sc -= 14;
      const rNext = runs[(d+1)%7], rPrev = runs[(d+6)%7];
      if(s.hard >= 1 && rNext !== undefined && RUN_SESSIONS[rNext].hard >= 1) sc -= 22;
      if(s.hard >= 1 && rPrev !== undefined && RUN_SESSIONS[rPrev].hard >= 1) sc -= 22;
      if(type === 'long' && d >= 5) sc += 16;           // long run at the weekend
      if(s.hard === 0 && prev && prev.lower) sc += 6;
      sc += (7 - Math.abs(3 - d)) * 0.15;               // spread across the week
      if(sc > bestScore){ bestScore = sc; best = d; }
    }
    if(best >= 0) runs[best] = type;
  });
  const off = custom ? 0 : ((startDow || 0) % 7 + 7) % 7;
  if(off){                                     // rotate the week so day one lands where you want it
    const rl = {}, rr = {}, rd = [];
    liftDows.forEach(d=> rd.push((d + off) % 7));
    Object.keys(lifts).forEach(d=> rl[(+d + off) % 7] = lifts[d]);
    Object.keys(runs).forEach(d=> rr[(+d + off) % 7] = runs[d]);
    return { liftDows:rd, lifts:rl, runs:rr, goal:goalKey, nLift, startDow:off };
  }
  return { liftDows, lifts, runs, goal:goalKey, nLift, startDow:0, custom:!!custom };
}
export function schedNow(ctx){
  const c = schCtx(ctx);
  if(c.sched && c.sched.liftDows) return c.sched;
  return buildSchedule((c.plan || []).map(d=>d.name), 0, 'none');
}
export function weekRows(week, ctx){
  const s = schedNow(ctx);
  return DOW.map((label,d)=>({ i:d,
    d, label,
    lift: s.lifts[d] ? s.lifts[d].name : null,
    run: s.runs[d] !== undefined ? runSession(s.runs[d], week) : null
  }));
}
export function scheduleNote(ctx){
  const s = schedNow(ctx);
  if(!s.runs || !Object.keys(s.runs).length) return '';
  const clashes = Object.keys(s.runs).filter(d=>s.lifts[d]);
  const hardOnUpper = clashes.filter(d=> RUN_SESSIONS[s.runs[d]].hard >= 2).length;
  const flush = clashes.filter(d=> RUN_SESSIONS[s.runs[d]].hard === 0 && s.lifts[d].lower).length;
  const parts = ['Hard running is kept off leg days and off the day before one'];
  if(hardOnUpper) parts.push(hardOnUpper === 1 ? 'the quality session shares an upper-body day, where it interferes least' : 'quality sessions share upper-body days, where they interfere least');
  if(flush) parts.push('an easy run follows lower-body lifting to flush the legs');
  return parts.join('; ') + '.';
}
export function composeProgram(seed, ctx){
  const _s = pgCtx(ctx);
  const _prevSeed = _composeSeed;
  _composeSeed = seed;
  try{
  const weeksRaw = _s.weeks || 4;
  const weeksStaged = Math.max(4, Math.min(12, weeksRaw));
  const keys = splitFor(_s.liftDays), names = dayNames(keys), used = new Set();
  const newPlan = keys.map((k,di)=>({
    id: Date.now()+di, name: names[di],
    exercises: guardPrimaries(fitDayToTime(fillDayToTime(buildDay(k, di, used, _s, seed).map(m=>({ name:m.n, targets:genTargets(m.sets, goalForTier(m.tier, m.p), null, m.p, m.tier, di, 0, loadKindOf(m), m.n, _s), note:m.note, goal:goalForTier(m.tier, m.p) })), 1, di, _s), 1), _s)
  }));
  const adaptations = { focus:_s.focus, emphasis:_s.emphasis.slice(), injuries:_s.injuries.slice(),
    equip:_s.equip, notes:adaptationNotes(_s) };
  /* from here the block length is the NEW one — the same boundary the old state.weeks write drew */
  const _prevWeeks = _composeWeeks;
  _composeWeeks = weeksRaw;
  try{
    newPlan.forEach((d, di)=>{ d.dayIdx = di; buildStagesFor(d, (seed || 1) * 31 + di * 977, _s, weeksStaged); });
    governVolume(newPlan, _s);
  } finally { _composeWeeks = _prevWeeks; }
  newPlan.forEach(d=>{ if(d.stages && d.stages.length) d.exercises = d.stages[0]; });
  const runVisible = _s.runGoal !== 'none' && _s.runDays > 0;
  return {
    seed, plan:newPlan, dayId:newPlan[0].id, adaptations,
    setup: JSON.parse(JSON.stringify(_s)),
    weeks: weeksRaw,
    weekNames: genWeekNames(primaryGoal(_s), weeksRaw, _s),
    runVisible, runGoal:_s.runGoal, runPace:_s.runPace || 0, runExp:_s.runExp || 'some',
    sched: buildSchedule(names, runVisible ? _s.runDays : 0, _s.runGoal,
      startDow({ startDate:_s.startDate, today:todayISO() }),
      trainDows({ trainDows:_s.trainDows, liftDays:_s.liftDays })),
    week: 1,
    startDate: _s.startDate || todayISO()
  };
  } finally { _composeSeed = _prevSeed; }
}
/* The shell owns writing a composed program into the app's state. */
export const XP = { session:100, pr:75, week:250, run:60, block:1000, streakStep:50, streakCap:250 };
/* Each medal carries its own metal. A Bronze card that glows violet is a card that could be
   any rank; the colour is the rank, so the screen changes as you earn it. */
export const MEDALS = [
  /* Mixed for a white page. Silver and platinum as literal metals vanish on white,
     so each is the deepest value that still reads as its own metal. */
  { n:'Bronze',   lvl:1,  gate:null, col:'#a4652b' },
  { n:'Silver',   lvl:5,  gate:null, col:'#6d7f8c' },
  { n:'Gold',     lvl:10, gate:null, col:'#a8801c' },
  { n:'Platinum', lvl:16, gate:1,    col:'#2f7d76' },
  { n:'Diamond',  lvl:24, gate:2,    col:'#1b7fb8' }
];
export const STANDARDS = {
  m:{ 'Back Squat':[1.25,1.75], 'Front Squat':[1.0,1.4], 'Barbell Bench Press':[1.0,1.5],
      'Conventional Deadlift':[1.5,2.0], 'Trap Bar Deadlift':[1.5,2.0], 'Romanian Deadlift':[1.25,1.75],
      'Standing Overhead Press':[0.6,0.85], 'Push Press':[0.75,1.0], 'Hang Power Clean':[0.8,1.1] },
  f:{ 'Back Squat':[0.9,1.3], 'Front Squat':[0.7,1.0], 'Barbell Bench Press':[0.6,0.9],
      'Conventional Deadlift':[1.1,1.5], 'Trap Bar Deadlift':[1.1,1.5], 'Romanian Deadlift':[0.9,1.3],
      'Standing Overhead Press':[0.4,0.6], 'Push Press':[0.5,0.7], 'Hang Power Clean':[0.55,0.8] }
};
export const lvlCost = n => 500 + 250 * (n - 1);
export function levelFor(xp){
  let lvl = 1, spent = 0;
  /* A non-finite score would make this climb forever. Levels are bounded anyway. */
  if(!isFinite(xp) || xp < 0) xp = 0;
  while(spent + lvlCost(lvl) <= xp && lvl < 500){ spent += lvlCost(lvl); lvl++; }
  return { lvl, into:xp - spent, need:lvlCost(lvl) };
}
/* toISOString() throws on an unparseable date and this runs inside scoreState, which powers
   both the Rank tab and every session finish. */
export function mondayKey(iso){
  const d = new Date(iso + 'T12:00:00');
  if(isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localISO(d);
}
/* ── scoring / history ──
   Same arrangement as readiness: an explicit context, defaulting to the live globals so every
   existing call site behaves exactly as before. ctx: { sessions, runs, archive, plan, sex, bw,
   liftDays, today } */
export function scCtx(c){
  return c || { sessions:state.sessions, runs:state.runs, archive:state.archive, plan:state.plan,
                sex:state.sex, bw:state.bw, liftDays:setup.liftDays, today:todayISO() };
}
export function allHistory(ctx){
  const c = scCtx(ctx);
  const arch = c.archive || [];
  return {
    sessions: arch.reduce((a, x)=>a.concat(x.sessions || []), []).concat(c.sessions)
      .filter(s=>s && s.completed !== false).slice().sort((a, b)=>a.date < b.date ? -1 : 1),
    runs: arch.reduce((a, x)=>a.concat(x.runs || []), []).concat(c.runs),
    /* A filed-away program counts as FINISHED only if it was trained to its last week. Counting
       every archive entry meant abandoning a build and starting another awarded the thousand-point
       "programs finished" credit and its badge — so the fastest way to rank up was to keep
       rebuilding and never train, which is the opposite of what the award is for. A program the
       lifter walked away from is history, not an achievement. */
    blocks: arch.filter(x=>{
      const need = Math.max(1, x.weeks || 4);
      const done = (x.sessions || []).filter(s=>s && s.completed !== false);
      if(!done.length) return false;
      const reached = done.reduce((mx, s)=>Math.max(mx, +s.week || 0), 0);
      /* The final week has to have been trained, not merely reached — a program abandoned on the
         first day of its last week is not a program completed. */
      return reached >= need && done.some(s=>(+s.week || 0) >= need);
    }).length
  };
}
/* The gate reads every session ever logged, not just the current program — archiving a block
   must never erase the evidence for a rank already earned. */
export function bestOfAll(exName, ctx){
  return allHistory(ctx).sessions.reduce((best, s)=>{
    const e = (s.entries || {})[exName];
    if(!e || !e.length) return best;
    const t = topSet(e);
    return Math.max(best, e1rm(t.w, t.r));
  }, 0);
}
export function gateLifts(ctx){
  const c = scCtx(ctx);
  const tbl = STANDARDS[c.sex === 'f' ? 'f' : 'm'];
  const names = [...new Set((c.plan || []).map(d=>d.exercises[0] && d.exercises[0].name).filter(Boolean))];
  return names.filter(n=>tbl[n]).map(n=>({ name:n, std:tbl[n] }));
}
export function gateCheck(ctx){
  const c = scCtx(ctx);
  const lifts = gateLifts(c), bw = +c.bw || 0;
  if(!bw) return { known:false, why:'bw', lifts, tier:0 };
  if(!lifts.length) return { known:false, why:'lifts', lifts, tier:0 };
  const rows = lifts.map(l=>{
    const best = maxOf(l.name), mult = bw ? best / bw : 0;
    return { name:l.name, best, mult, std:l.std,
      tier: mult >= l.std[1] ? 2 : mult >= l.std[0] ? 1 : 0 };
  });
  const missing = rows.filter(r=>!r.best);
  if(missing.length) return { known:false, why:'untested', lifts, rows, tier:0, missing };
  return { known:true, lifts, rows, tier:Math.min.apply(null, rows.map(r=>r.tier)) };
}
export function scoreState(ctx){
  const c = scCtx(ctx);
  const H = allHistory(c);
  const best = {}, first = {}, moves = new Set();
  let prs = 0, sets = 0, reps = 0, volume = 0, bigSession = 0, prBest = 0, prSessions = 0;
  H.sessions.forEach(s=>{
    let sVol = 0, sPr = 0;
    Object.keys(s.entries || {}).forEach(k=>{
      const e = s.entries[k]; if(!e || !e.length) return;
      moves.add(k);
      e.forEach(x=>{ sets++; reps += (+x.r || 0); sVol += (+x.w || 0) * (+x.r || 0); });
      const t = topSet(e), v = e1rm(t.w, t.r);
      if(best[k] === undefined){ best[k] = v; first[k] = v; return; }
      if(v > best[k]){ best[k] = v; prs++; sPr++; }
    });
    volume += sVol;
    if(sVol > bigSession) bigSession = sVol;
    if(sPr > prBest) prBest = sPr;
    if(sPr) prSessions++;
  });
  const doubled = Object.keys(best).filter(k=>first[k] && best[k] >= first[k] * 2).length;
  const perWeek = {};
  H.sessions.forEach(s=>{ const k = mondayKey(s.date); if(k) perWeek[k] = (perWeek[k] || 0) + 1; });
  const target = Math.max(1, c.liftDays || 3);
  const weekKeys = Object.keys(perWeek).sort();
  const fullWeeks = weekKeys.filter(k=>perWeek[k] >= target).length;
  let streak = 0;
  if(weekKeys.length){
    const step = k => { const d = new Date(k + 'T12:00:00'); d.setDate(d.getDate() - 7); return localISO(d); };
    const thisWk = mondayKey(todayISO());
    let cur = perWeek[thisWk] ? thisWk : step(thisWk);
    while(perWeek[cur]){ streak++; cur = step(cur); }
  }
  const miles = H.runs.reduce((a, r)=>a + (+r.miles || 0), 0);
  const maxRun = H.runs.reduce((a, r)=>Math.max(a, +r.miles || 0), 0);
  const bestPace = H.runs.reduce((a, r)=>{ const p = pace ? pace(+r.miles || 0, +r.minutes || 0) : 0;
    return p && (!a || p < a) ? p : a; }, 0);
  const runsByDate = H.runs.slice().sort((a, b)=>a.date < b.date ? -1 : 1);
  const seed = runsByDate.slice(0, 3);
  const seedPaces = seed.map(r=>pace ? pace(+r.miles || 0, +r.minutes || 0) : 0).filter(p=>p > 0);
  const basePace = seedPaces.length ? seedPaces.reduce((a, p)=>a + p, 0) / seedPaces.length : 0;
  const baseLong = seed.reduce((a, r)=>Math.max(a, +r.miles || 0), 0);
  const hasBase = seedPaces.length >= 3;
  const paceGain = hasBase && bestPace ? Math.max(0, (basePace - bestPace) / basePace * 100) : 0;
  const longMult = hasBase && baseLong ? maxRun / baseLong : 0;
  const dates = [...new Set(H.sessions.map(s=>s.date))].sort();
  const dows = new Set(H.sessions.map(s=>new Date(s.date + 'T12:00:00').getDay()));
  const months = {}; H.sessions.forEach(s=>{ const k = s.date.slice(0, 7); months[k] = (months[k] || 0) + 1; });
  const monthBest = Object.keys(months).reduce((a, k)=>Math.max(a, months[k]), 0);
  let dayStreak = 0, runLen = 0, comeback = 0;
  dates.forEach((d, i)=>{
    if(i){
      const gap = Math.round((new Date(d) - new Date(dates[i - 1])) / 864e5);
      if(gap === 1) runLen++; else { runLen = 1; if(gap >= 14) comeback = 1; }
    } else runLen = 1;
    if(runLen > dayStreak) dayStreak = runLen;
  });
  const streakXp = Math.min(XP.streakCap, Math.max(0, streak - 1) * XP.streakStep);
  const xp = H.sessions.length * XP.session + prs * XP.pr + fullWeeks * XP.week
    + H.runs.length * XP.run + H.blocks * XP.block + streakXp;
  const L = levelFor(xp);
  const gate = gateCheck(c);
  let rankIdx = 0;
  MEDALS.forEach((r, i)=>{
    if(L.lvl < r.lvl) return;
    if(r.gate && !(gate.known && gate.tier >= r.gate)) return;
    rankIdx = i;
  });
  const stats = { sessions:H.sessions.length, prs, fullWeeks, runs:H.runs.length, miles, streak,
    blocks:H.blocks, volume, bigSession, sets, reps, moves:moves.size, prBest, prSessions, doubled,
    maxRun, bestPace, monthBest, dayStreak, comeback, dows:dows.size,
    basePace, baseLong, hasBase, paceGain, longMult,
    weeksLogged:weekKeys.length };
  return { xp, lvl:L.lvl, into:L.into, need:L.need, rank:MEDALS[rankIdx], rankIdx,
    next:MEDALS[rankIdx + 1] || null, gate, stats, badges:badgeList(stats) };
}
export function badgeList(s){
  /* d = rough weeks of steady training to reach it — the sort key inside a category */
  const B = (id,cat,label,desc,have,need,d)=>({ id, cat, label, desc, have, need, rank:d, earned:have >= need });
  const R = (id,cat,label,desc,count,d)=>({ id, cat, label, desc, have:count, need:1, count,
    rank:d, repeat:true, earned:count > 0 });
  return [
    R('w1','Consistency','Full week','Every week you train every day the program asked for', s.fullWeeks, 1),
    B('s1','Consistency','First one down','Complete a session', s.sessions, 1, 0.3),
    B('d3','Consistency','Three straight','Train 3 calendar days in a row', s.dayStreak, 3, 1.5),
    B('s10','Consistency','Ten deep','10 sessions', s.sessions, 10, 3),
    B('k4','Consistency','Month unbroken','4 weeks in a row', s.streak, 4, 4),
    B('w4','Consistency','Four full','4 complete weeks', s.fullWeeks, 4, 4.5),
    B('m12','Consistency','Busy month','12 sessions in one calendar month', s.monthBest, 12, 5),
    B('d5','Consistency','Five straight','Train 5 calendar days in a row', s.dayStreak, 5, 6),
    B('back','Consistency','Back at it','Return after two weeks or more away', s.comeback, 1, 7),
    B('s25','Consistency','Regular','25 sessions', s.sessions, 25, 8),
    B('dow7','Consistency','Every day of the week','Train on all seven weekdays at least once', s.dows, 7, 9),
    B('m20','Consistency','Relentless','20 sessions in one calendar month', s.monthBest, 20, 10),
    B('k12','Consistency','Quarter unbroken','12 weeks in a row', s.streak, 12, 12),
    B('w12','Consistency','Twelve full','12 complete weeks', s.fullWeeks, 12, 13),
    B('s50','Consistency','Half a hundred','50 sessions', s.sessions, 50, 17),
    B('k26','Consistency','Half a year','26 weeks in a row', s.streak, 26, 26),
    B('w26','Consistency','Six months clean','26 complete weeks', s.fullWeeks, 26, 28),
    B('s100','Consistency','Century','100 sessions', s.sessions, 100, 33),
    B('k52','Consistency','A full year','52 weeks in a row', s.streak, 52, 52),
    B('wl52','Consistency','A year on the log','Sessions in 52 different weeks', s.weeksLogged, 52, 55),
    B('s250','Consistency','Two-fifty','250 sessions', s.sessions, 250, 83),

    R('p1','Strength','New best','Every time you beat a lift you had logged before', s.prs, 1),
    R('pb','Strength','Session best','Every session that sets a new personal record', s.prSessions, 1.5),
    B('pd','Strength','Triple threat','Three personal records in one session', s.prBest, 3, 2),
    B('p10','Strength','Climbing','10 personal records', s.prs, 10, 5),
    B('pd5','Strength','Everything moved','Five personal records in one session', s.prBest, 5, 8),
    B('p25','Strength','Stronger','25 personal records', s.prs, 25, 12),
    B('x2','Strength','Doubled','Take a lift to twice what you first logged', s.doubled, 1, 20),
    B('p50','Strength','Fifty bests','50 personal records', s.prs, 50, 25),
    B('x2b','Strength','Doubled three','Do it on three different lifts', s.doubled, 3, 40),
    B('p100','Strength','A hundred bests','100 personal records', s.prs, 100, 50),

    B('big','Volume','Big day','20,000 lb in a single session', Math.floor(s.bigSession), 20000, 2),
    B('v100','Volume','Hundred thousand','100,000 lb lifted all told', Math.floor(s.volume), 100000, 4),
    B('mv25','Volume','Broad base','25 different movements performed', s.moves, 25, 5),
    B('big40','Volume','Huge day','40,000 lb in a single session', Math.floor(s.bigSession), 40000, 10),
    B('set500','Volume','Five hundred sets','500 working sets logged', s.sets, 500, 12),
    B('rep10k','Volume','Ten thousand reps','10,000 reps logged', s.reps, 10000, 14),
    B('v500','Volume','Half a million','500,000 lb lifted', Math.floor(s.volume), 500000, 17),
    B('mv50','Volume','Well travelled','50 different movements performed', s.moves, 50, 20),
    B('v1m','Volume','Million pound club','1,000,000 lb lifted', Math.floor(s.volume), 1000000, 33),
    B('set2500','Volume','Twenty-five hundred','2,500 working sets logged', s.sets, 2500, 60),
    B('v5m','Volume','Five million','5,000,000 lb lifted', Math.floor(s.volume), 5000000, 166),

    B('r1','Running','Out the door','Log a run', s.runs, 1, 0.3),
    B('rl15','Running','Half again','Run 1.5× your longest early run', Math.round(s.longMult * 100), 150, 6),
    B('rp5','Running','Three per cent quicker','Beat your starting pace by 3%', Math.floor(s.paceGain), 3, 4),
    B('r25','Running','Twenty-five runs','25 runs logged', s.runs, 25, 8),
    B('rm100','Running','Hundred miles','100 miles run', Math.floor(s.miles), 100, 10),
    B('rp10','Running','Ten per cent quicker','Beat your starting pace by 10%', Math.floor(s.paceGain), 10, 16),
    B('rl2','Running','Twice as far','Run 2× your longest early run', Math.round(s.longMult * 100), 200, 18),
    B('rhalf','Running','Half marathon','A single run of 13.1 miles', s.maxRun >= 13.1 ? 1 : 0, 1, 22),
    B('r100','Running','A hundred runs','100 runs logged', s.runs, 100, 33),
    B('rp18','Running','A different runner','Beat your starting pace by 18%', Math.floor(s.paceGain), 18, 34),
    B('rl3','Running','Three times out','Run 3× your longest early run', Math.round(s.longMult * 100), 300, 40),
    B('rm500','Running','Five hundred miles','500 miles run', Math.floor(s.miles), 500, 50),
    B('rfull','Running','Marathon','A single run of 26.2 miles', s.maxRun >= 26.2 ? 1 : 0, 1, 60),

    R('b1','Milestones','Block done','Every program you carry through to the end', s.blocks, 4),
    B('b3','Milestones','Three blocks','Finish three programs', s.blocks, 3, 12),
    B('b6','Milestones','Six blocks','Finish six programs', s.blocks, 6, 24)
  ];
}
/* The moment after a session. */
export function daysSince(iso){
  if(!iso) return 1e6;
  const d = new Date(iso + 'T12:00:00');
  if(isNaN(d.getTime())) return 1e6;
  return Math.round((new Date(todayISO() + 'T12:00:00') - d) / 864e5);
}
/* Every logged appearance of a movement, newest first. */
export function recentOf(exName, days){
  const out = [];
  try{
    allHistory().sessions.forEach(s=>{
      const e = (s.entries || {})[exName];
      if(!e || !e.length) return;
      if(daysSince(s.date) > days) return;
      out.push({ date:s.date, sets:e });
    });
  }catch(e){}
  return out.sort((a, b)=>a.date < b.date ? 1 : -1);
}
/* ── Progressive overload, applied rather than suggested ────────────────────────
   The prescription is a percentage, so the weight climbs whenever the estimated max climbs —
   but a max only moves when a set beats every set before it, and that is not how most weeks
   go. Between those jumps the load would sit still, which is not overload.

   So the percentage resolves against a TRAINING max: the best estimated max on record plus a
   small increment earned by recent performance. Everything about it is derived from the log,
   so there is nothing to accept, nothing to enter, and nothing to keep in step.

   The rate is the part that matters for tissue. Connective tissue remodels more slowly than
   muscle produces force, so the ceiling is deliberately low — a few per cent per fortnight,
   never compounding beyond it — and a session that misses its reps removes the increment
   immediately rather than waiting to be told. */
export function progressRate(exName, target){
  /* Nothing progresses out of the opening fortnight of a longer block: those two weeks are the
     same session twice by design, and the first pass is a rehearsal rather than a real attempt.
     Adding load off it would be adding load off a number nobody actually tested. */
  const n = weekCount();
  if(n >= 6 && (state.week || 1) <= 2) return 0;
  const hist = recentOf(exName, 21);
  /* A beginner's estimated max climbs mostly because the movement is being learned, not because
     tissue has adapted — early sets are conservative and technique improves fast, so the number
     runs ahead of the tendon. The RATE is the same for everyone; a beginner simply has to show
     it one more time before it counts. */
  const need = setup.exp === 'beginner' ? 3 : 2;
  if(hist.length < need) return 0;
  const met = s => {
    const work = s.sets.filter(x=>!x.warm);
    return work.length > 0 && work.every(x=>(+x.r || 0) >= target);
  };
  /* The most recent session is the veto: miss the reps and the increment is gone. */
  if(!met(hist[0])) return 0;
  let streak = 0;
  for(const s of hist){ if(!met(s)) break; streak++; }
  if(streak < need) return 0;
  /* One rate for everybody. Overload is a principle, not a setting: a beginner and an advanced
     lifter both add load when their sets say they are ready, and the rate a tendon tolerates
     does not change with training age. What experience changes is which movements are
     programmed and how they are loaded — the complexity of the pattern, the equipment, the
     progression the movement itself sits on — and that is decided before this point. */
  return Math.min(0.045, (streak - (need - 1)) * 0.02);
}
/* The number every percentage is taken from.

   Overload only applies where load can actually be added. A band gives ascending, unmeasurable
   tension and a bodyweight movement gives what the lifter weighs, so on both there is nothing
   for a percentage to act on and nothing to progress — those movements advance by how they are
   performed and by moving to a harder variation, which the stage rotation handles. Progressing
   a number that does not govern the set would be fiction. */
export function trainingMax(exName, ex){
  const m = byName[exName];
  if(m && loadKindOf(m) !== 'pct') return maxOf(exName);   // nothing to overload
  if(ex && ex.burnout) return maxOf(exName);
  const base = maxOf(exName);
  if(!base) return 0;
  const target = ex ? targetReps(ex) : 8;
  return Math.round(base * (1 + progressRate(exName, target)));
}

/* ══════════ SESSION ══════════ */
export function weekStats(week){
  const rows = weekRows(week);
  let planned = 0, done = 0;
  rows.forEach(r=>{ if(r.lift){ planned++; if(r.doneLift) done++; } });
  return { planned, done };
}
export function consistency(ctx){
  const c = scCtx(ctx);
  const lift = {}, run = {};
  (c.sessions || []).forEach(s=>{ if(s.completed !== false) lift[s.date] = true; });
  (c.runs || []).forEach(r=>{ run[r.date] = true; });
  return { lift, run };
}
/* ── Quality colour ───────────────────────────────────────────────────────────
   One accent for the whole app meant colour carried no information: a deload and a
   max-strength week looked identical. The adaptation table is the product's spine, so
   each quality gets a colour and the page takes it — warm for heavy and maximal, cool
   for light and enduring. Now the palette tells you what the week is asking of you
   before you have read a word of it. */
export function waveReps(ex, week){
  const m = String(rawTarget(ex, week)).match(/×((?:\d+\/)+\d+)/);
  return m ? m[1].split('/').map(Number) : null;
}
export function targetReps(ex){
  const wv = waveReps(ex);
  if(wv) return wv[0];
  const nums = String(repHint(rawTarget(ex))).match(/\d+/g);
  if(!nums) return 10;
  /* The top of the range, not its midpoint. A range of 8–12 seeded at 10 gives a lifter who can
     do 12 no reason to, and the midpoint of an odd span produced the odd numbers that made the
     targets look arbitrary. Prescribing the ceiling means reducing is a decision the lifter makes
     from a stated target, which they can judge, rather than guessing upward from a soft one. */
  return nums.length > 1 ? Math.max(+nums[0], +nums[1]) : +nums[0];
}
export function suggestDayId(ctx){
  const c = schCtx(ctx);
  const plan = c.plan || [], sessions = c.sessions || [];
  if(!plan.length) return null;
  const last = sessions[sessions.length - 1];
  if(!last) return plan[0].id;
  const i = plan.findIndex(d=>d.id === last.dayId);
  return (plan[(i + 1) % plan.length] || plan[0]).id;
}

/* File the current program away whole — plan, sessions, runs and the setup that produced
   it — so nothing logged against it is ever lost when a new one is built. */
export const READINESS_Q = [
  { k:'sleep',  label:'Sleep',    lo:'Broken',    hi:'Full & deep' },
  { k:'sore',   label:'Soreness', lo:'Very sore', hi:'Fresh' },
  { k:'energy', label:'Energy',   lo:'Flat',      hi:'Springy' },
  { k:'stress', label:'Stress',   lo:'Wired',     hi:'Calm' }
];

/* ── symptom regions, each mapped to the muscle groups that load it, so a flag can
   name the exact movements in today's session that stress it ── */
export const SYMPTOM_REGIONS = {
  knee:     { label:'Knee',           groups:['quads','hamstrings','calves'] },
  lowback:  { label:'Low back',       groups:['hamstrings','back','core'] },
  shoulder: { label:'Shoulder',       groups:['chest','shoulders','arms'] },
  hip:      { label:'Hip / groin',    groups:['glutes','hamstrings','quads'] },
  ankle:    { label:'Ankle / foot',   groups:['calves','quads'] },
  elbow:    { label:'Elbow / wrist',  groups:['arms','back','chest'] },
  neck:     { label:'Neck',           groups:['shoulders','back'] },
  other:    { label:'Somewhere else', groups:[] }
};
export const LOWER_SYMPTOM_REGIONS = ['knee','hip','ankle','lowback'];
export const SYMPTOM_WINDOW = 10;        // days a symptom stays "active" without a fresh entry

export function rdCtx(c){
  return c || { readiness:state.readiness, symptoms:state.symptoms, plan:state.plan,
                dayId:ui.dayId, autoreg:state.autoreg, today:todayISO() };
}

export function todayReadiness(ctx){ const c = rdCtx(ctx); const t = c.today || todayISO();
  return (c.readiness || []).slice().reverse().find(r=>r.date === t) || null; }
export function readinessScore(r){
  if(!r) return null;
  const v = READINESS_Q.map(q=>+r[q.k] || 0).filter(x=>x > 0);
  if(!v.length) return null;
  const avg = v.reduce((a,b)=>a+b,0) / v.length;   // 1..5
  return Math.round(((avg - 1) / 4) * 100 / 5) * 5; // 0..100, snapped to 5
}
export function readinessBand(score){
  if(score === null) return { key:'none', label:'Not checked', col:'var(--color-neutral-500)' };
  if(score >= 80) return { key:'green',  label:'Primed',    col:'#1e8a5f' };
  if(score >= 60) return { key:'steady', label:'Steady',    col:'#a8801c' };
  if(score >= 40) return { key:'amber',  label:'Guarded',   col:'#c2621c' };
  return             { key:'red',    label:'Depleted',  col:'#c2185b' };
}

/* ── active symptoms: latest entry per region inside the window, severity ≥ 1 ── */
export function activeSymptoms(ctx){
  const c = rdCtx(ctx);
  const cut = new Date((c.today || todayISO()) + 'T12:00:00'); cut.setDate(cut.getDate() - SYMPTOM_WINDOW);
  const seen = {};
  (c.symptoms || []).slice().sort((a,b)=> a.date < b.date ? 1 : -1).forEach(s=>{
    if(seen[s.region]) return;
    if(new Date(s.date + 'T12:00:00') < cut) return;
    if((+s.sev || 0) < 1) return;
    seen[s.region] = s;
  });
  return Object.values(seen);
}
export function sevBand(sev){
  if(sev >= 7) return { key:'high', label:'high', col:'#c2185b' };
  if(sev >= 4) return { key:'mod',  label:'moderate', col:'#c2621c' };
  return           { key:'mild', label:'mild', col:'#a8801c' };
}

/* ── today's day + whether it loads the lower limb, and the fatigue-cluster test ── */
export function todaysDay(ctx){
  const c = rdCtx(ctx);
  return ((c.plan || []).find(d=>d.id === c.dayId)) || (c.plan && c.plan[0]) || null; }
export function dayGroups(d){
  const set = new Set();
  ((d && d.exercises) || []).forEach(ex=> (groupsOf(ex.name) || []).forEach(g=>set.add(g)));
  return set;
}
export function dayLoadsLower(d){
  const g = dayGroups(d);
  return ['quads','hamstrings','glutes','calves'].some(x=>g.has(x));
}
export function inLowerCluster(ctx){ const c = rdCtx(ctx); const dw = dowOf(c.today || todayISO()); return dw === 2 || dw === 3 || dw === 4; } // Tue–Thu

/* ── the one call that turns readiness + symptoms + the calendar into an instruction ── */
export function autoReg(ctx){
  const c = rdCtx(ctx);
  const d = todaysDay(c);
  if(!d) return null;
  const score = readinessScore(todayReadiness(c));
  const band  = readinessBand(score);
  const active = activeSymptoms(c);

  // movements in today's session that a currently-active symptom implicates
  const dg = dayGroups(d);
  const flags = [];
  active.forEach(s=>{
    if((+s.sev || 0) < 4) return;                         // mild aches don't drive the session
    const reg = SYMPTOM_REGIONS[s.region]; if(!reg) return;
    const hits = ((d.exercises) || []).map(e=>e.name)
      .filter(n=> (groupsOf(n) || []).some(g=> reg.groups.indexOf(g) > -1));
    if(hits.length || reg.groups.length === 0) flags.push({ region:s.region, label:reg.label, sev:+s.sev, moves:hits });
  });

  // level 0 clear · 1 trim · 2 pull back · 3 technique/flush day
  let level = 0;
  if(band.key === 'amber') level = 1;
  if(band.key === 'red')   level = 2;
  flags.forEach(f=>{ if(f.sev >= 4) level = Math.max(level, 1); if(f.sev >= 7) level = Math.max(level, 2); });

  // the Tue–Thu lower-limb window escalates a sub-par read rather than creating one
  const cluster = inLowerCluster(c) && dayLoadsLower(d) &&
    (level >= 1 || active.some(s=> LOWER_SYMPTOM_REGIONS.indexOf(s.region) > -1 && (+s.sev||0) >= 3));
  if(cluster && level >= 1) level = Math.min(3, level + 1);

  const HEAD = [
    score !== null && score >= 85 ? 'Cleared — room to push the top set' : 'Cleared to train as written',
    'Trim the edges today',
    'Pull the load back',
    'Make it a technique day'
  ];
  const BODY = [
    score !== null && score >= 85
      ? 'Everything reads green. If a top set feels genuinely easy you\u2019ve earned a little more — otherwise run it as prescribed.'
      : 'Nothing flagged. Run the session as written and let RPE do its job.',
    'Drop the last working set on your heaviest movements and hold the top set about a point below your usual RPE. Same movements, a little less cost.',
    'Cut the back-off sets, cap everything around RPE 6\u20137 and leave 3\u20134 reps in the tank. You\u2019re banking recovery, not chasing a number.',
    'Light and submaximal only — pain-free range, crisp technique, no grinding. A flush session keeps the habit without adding fatigue you can\u2019t pay back.'
  ];
  return { level, score, band, flags, cluster,
    head:HEAD[level], body:BODY[level],
    showEmpty: score === null && !flags.length };
}

/* ══════════ TODAY CARD ══════════ */
export function autoRegPlan(ctx){
  const c = rdCtx(ctx);
  const ar = autoReg(c); if(!ar || ar.level < 1) return null;
  const d = todaysDay(c); if(!d) return null;
  const names = (d.exercises || []).map(e=>e.name);
  const flagged = new Set();
  ar.flags.forEach(f=> (f.moves || []).forEach(n=>flagged.add(n)));
  /* level 1 touches the primaries and anything a symptom flags; 2 and 3 pull the whole session
     back, since a depleted or high-symptom day is not one to spend on accessories either. */
  const moves = ar.level === 1
    ? [...new Set([...names.slice(0, 2), ...flagged])]
    : names.slice();
  const rpeCap = ar.level >= 3 ? 6 : ar.level === 2 ? 7 : null;
  return { level:ar.level, moves, setDrop:1, rpeCap };
}
export function autoRegActive(ctx){
  const c = rdCtx(ctx);
  const o = c.autoreg;
  return (o && o.date === (c.today || todayISO()) && o.dayId === c.dayId) ? o : null;
}
export function autoRegDelta(ex){
  const o = autoRegActive(); if(!o) return 0;
  const nm = (ex && ex.name) || '';
  return (o.moves || []).indexOf(nm) > -1 ? -(o.setDrop || 0) : 0;
}
