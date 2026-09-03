/**
 * Trainlog — decision core
 * ---------------------------------------------------------------------------
 * The part of the app that decides what to prescribe. Extracted verbatim from
 * index.html and rewritten to take explicit arguments instead of reading global
 * state, so it can be imported by any front end without dragging the DOM in.
 *
 * This file is the reason the app is worth porting rather than rebuilding. Every
 * function here encodes an NSCA/CSCS loading decision or one of eight audited bug
 * fixes. The arithmetic has been verified identical to the shipping app.
 *
 * DO NOT "improve", refactor or regenerate anything in this file. Progression
 * bugs are silent: a wrong constant does not throw, it prescribes a weight the
 * lifter has not earned and you find out weeks later. Call it, wrap it, type it —
 * do not rewrite it. Tests live in trainlog-core.test.js.
 *
 * @license Same terms as the parent project.
 */

/* ── loading parameters ───────────────────────────────────────────────────────
   %1RM bands, rep ranges, set ranges and rest windows per training adaptation.
   These track the NSCA resistance-training goal table, with hypertrophy rest
   widened to 1–3 min in line with current literature rather than the older
   30–90 s figure. */
export const ADAPT = {
  maxstrength: { label:'max strength',       pct:[85,100], reps:[1,5],   sets:[3,6], rest:[180,300] },
  strhyp:      { label:'strength + size',    pct:[75,85],  reps:[5,8],   sets:[3,5], rest:[120,240] },
  hypertrophy: { label:'hypertrophy',        pct:[65,80],  reps:[8,15],  sets:[3,5], rest:[60,180] },
  hyphigh:     { label:'hypertrophy, light', pct:[50,65],  reps:[15,30], sets:[2,4], rest:[60,120] },
  endurance:   { label:'muscular endurance', pct:[40,60],  reps:[15,30], sets:[2,4], rest:[30,90] },
  power:       { label:'power',              pct:[30,70],  reps:[1,5],   sets:[3,6], rest:[120,300] }
};

/* Three steps per goal, walked across the block — a gradual build toward the
   quality the goal is after rather than a different emphasis every week. */
export const GOAL_RAMP = {
  hypertrophy: ['hypertrophy','hypertrophy','strhyp'],
  strength:    ['strhyp','maxstrength','maxstrength'],
  power:       ['strhyp','power','power'],
  health:      ['endurance','hyphigh','hypertrophy']
};

/* Hold duration starts from what is being held. Every timed movement used to get
   the same number off the week's adaptation alone, so a dead hang, a farmer carry
   and a bird dog were all prescribed 30 s. */
export const HOLD_BASE = {
  core_anti_ext:40, core_anti_rot:35, core_anti_lat:35,
  carry:40, quad_iso:45, ham_iso:35, calf:35, vpull:35, adductor:25
};
export const HOLD_DEFAULT = 35;

export const EFFORT_ORDER = ['easy','solid','hard','grind'];

/* ── estimation ───────────────────────────────────────────────────────────── */

/** Epley, held to the ten reps it is valid over. Past that it diverges hard, and
 *  because the estimate is a MAXIMUM across all history one 25-rep burnout set
 *  would otherwise lift the estimated max ~45% and drag every prescribed
 *  percentage up with it. A true single returns itself. */
export const E1RM_MAX_REPS = 10;
export function e1rm(w, r){
  if(!(r > 0)) return w;
  const n = Math.min(r, E1RM_MAX_REPS);
  return n <= 1 ? Math.round(w) : Math.round(w * (1 + n / 30));
}

/** Inverse Epley: the %1RM at which a rep count is maximal. */
export const pctForReps = r => 3000 / (30 + Math.max(1, r));

/* ── periodization ────────────────────────────────────────────────────────── */

/** 0-2 = loading weeks of the wave, 3 = deload.
 *  Two rules used to fire independently — every fourth week deloads AND the final
 *  week always deloads — so a 5- or 9-week block ended with two deloads back to
 *  back and a 6-week block put one lone loading week between two. The scheduled
 *  deload gives way when the forced final one is already within reach. */
export function phaseOf(week, total){
  const n = Math.max(1, total || 4);
  if(week >= n) return 3;
  const ph = (week - 1) % 4;
  if(ph === 3 && (n - week) < 3) return 2;
  return ph;
}

/** Which third of the block a week falls in. */
export function blockIndex(week, total){
  const n = Math.max(1, total || 4);
  return Math.max(0, Math.min(2, Math.floor((week - 1) * 3 / n)));
}

/** The adaptation a given week trains, for a given goal. */
export function adaptFor(goalKey, week, total){
  return (GOAL_RAMP[goalKey] || GOAL_RAMP.hypertrophy)[blockIndex(week, total)];
}

/** Working %1RM. The load comes OUT of the rep prescription rather than being
 *  chosen beside it, so the two can never contradict. Epley's inverse gives the
 *  load at which the rep count is maximal — reps in reserve zero — so the load is
 *  taken from the reps the set WOULD run to failure: prescribed reps plus RIR. */
export function loadPct(goalKey, week, total, reps, rpe){
  const a = ADAPT[adaptFor(goalKey, week, total)];
  if(!a) return null;
  const n = total || 4, ph = phaseOf(week, n);
  const hi = Math.min(a.pct[1], 95);              // never a true 1RM for a multi-rep set
  const rir = Math.max(0, Math.min(6, 10 - (+String(rpe || '').replace(/\D+/g, '').slice(-1) || 8)));
  const eff = Math.max(1, (reps || a.reps[0]) + rir);
  if(a === ADAPT.power){
    const lo = a.pct[0], span = (a.pct[1] - lo) * 0.55;
    const t = ph === 3 ? 0 : Math.min(1, blockIndex(week, n) / 2);
    return Math.round((lo + span * t) / 2.5) * 2.5;
  }
  const pct = pctForReps(eff);
  if(ph === 3) return Math.round(Math.max(35, Math.min(hi, pct * 0.85)) / 2.5) * 2.5;
  return Math.round(Math.max(a.pct[0] - 7.5, Math.min(hi, pct)) / 2.5) * 2.5;
}

/** Seconds for a timed hold. The movement's pattern sets the base, the week's
 *  adaptation scales it, and a deload shortens it — holds used to ignore deloads
 *  entirely, which made the deload incomplete. */
export function holdSecs(goalKey, week, total, pattern){
  const base = HOLD_BASE[pattern] || HOLD_DEFAULT;
  const a = ADAPT[adaptFor(goalKey, week, total)];
  let k = 1;
  if(a === ADAPT.maxstrength || a === ADAPT.power) k = 0.7;
  else if(a === ADAPT.strhyp) k = 0.85;
  else if(a === ADAPT.endurance || a === ADAPT.hyphigh) k = 1.4;
  if(phaseOf(week, total) === 3) k *= 0.75;
  return Math.max(20, Math.round(base * k / 5) * 5);
}

/* ── the ratchet ──────────────────────────────────────────────────────────────
   Everything below decides the next working weight or rep target from what was
   actually logged. It is the audited core; see the eight fixes noted inline. */

/** Consecutive clean sessions required before the load moves. */
export const earnedThreshold = exp => (exp === 'beginner' ? 1 : 2);

/** How big a step this movement takes, scaled by size: floored around 2.5% and
 *  ceilinged around 10%, so it stays proportional from a 315 lb squat to a 15 lb
 *  lateral raise. */
export function loadStep(w, isLower){
  let inc = isLower ? 10 : 5;
  inc = Math.max(inc, Math.round(w * 0.025 / 2.5) * 2.5);
  inc = Math.min(inc, Math.max(2.5, Math.round(w * 0.10 / 2.5) * 2.5));
  return Math.max(2.5, Math.round(inc / 2.5) * 2.5);
}

/** The weekly speed limit: no more than ~10% over the recent best, so a
 *  mis-logged rep cannot spike the load. Rounding that ceiling to the nearest
 *  plate used to put it BELOW the current weight under 12.5 lb, so light work
 *  held forever however well it went — the ceiling is floored at one honest
 *  increment above current. */
export function speedCap(recentWeights, target, floor){
  const recent = (recentWeights || []).filter(x => x > 0);
  if(!recent.length) return target;
  let ceiling = Math.round(Math.max.apply(null, recent) * 1.10 / 2.5) * 2.5;
  if(floor != null) ceiling = Math.max(ceiling, floor);
  return Math.min(target, ceiling);
}

/**
 * Judge one logged session of a movement.
 *
 * @param {{sets:{w:number,r:number,warm?:boolean}[], effort?:string, targetReps:number, autoreg?:number}} s
 * @returns {{w:number,r:number,targetR:number,hit:boolean,eff:string,assumed:boolean,dosed:boolean}}
 */
export function judgeSession(s){
  const work = (s.sets || []).filter(x => !x.warm);
  const top = work.reduce((a, b) => (b.w > a.w || (b.w === a.w && b.r > a.r)) ? b : a, work[0] || { w:0, r:0 });
  const tR = s.targetReps || top.r;
  const hit = top.r >= tR && work.every(x => x.r >= Math.max(1, tR - 1));
  /* How hard it felt is the brake on the whole ratchet, and the tap that records
     it is optional — so what silence means decides how the app behaves for most
     people. Reading silence as "solid" made every session the lifter merely
     finished an earned one: an unbounded linear progression wearing an
     autoregulation costume. Silence is read from the reps instead, which are
     objective. Beating the top of the range by two is real evidence of reps in
     reserve; merely finishing is provisional. */
  const tapped = s.effort || null;
  const eff = tapped || (!hit ? 'grind' : (top.r >= tR + 2 ? 'easy' : 'solid'));
  return { w:+top.w || 0, r:+top.r || 0, targetR:tR, hit, eff,
           assumed: !tapped, dosed: !!s.autoreg };
}

/**
 * THE RATCHET — what weight to put on the bar next, and why.
 *
 * @param {ReturnType<typeof judgeSession>[]} history  newest first, across ALL
 *        blocks (archived included — dropping the archive threw away earned
 *        weight every time a program was rebuilt).
 * @param {{exp?:string, isLower?:boolean}} [opts]
 * @returns {{w:number, action:'progress'|'hold'|'deload', why:string}|null}
 */
export function decideLoad(history, opts){
  const o = opts || {};
  /* A day the readiness check deliberately lightened is not evidence about the
     weight: clearing it earns nothing and must not become the base the next
     session is figured from. A dosed day they still ground through stays. */
  const h = (history || []).filter(x => !(x.dosed && x.hit));
  if(!h.length || !h[0].w) return null;                 // first exposure
  const last = h[0], w = last.w, step = loadStep(w, !!o.isLower);
  const up = () => Math.max(w, speedCap(h.slice(0, 3).map(x => x.w), w + step, w + 2.5));

  if(last.eff === 'grind' || !last.hit){
    const prevBack = h[1] && (h[1].eff === 'grind' || !h[1].hit);
    if(prevBack){
      const dl = Math.max(2.5, Math.round(w * 0.90 / 2.5) * 2.5);
      return { w:dl, action:'deload', why:'Two hard sessions in a row, so this eases back about 10%. Rebuild from here — the dip is short.' };
    }
    return { w:w, action:'hold', why:'You came up short last time, so this holds the weight. Own these reps before it moves.' };
  }
  if(last.eff === 'easy'){
    const nw = up();
    return nw > w
      ? { w:nw, action:'progress', why:'You hit every rep with room to spare, so it goes up ' + (nw - w) + ' lb. Earned, not scheduled.' }
      : { w:w, action:'hold', why:'You had room, but this is as fast as it should climb this week. It moves next time.' };
  }
  if(last.eff === 'hard'){
    return { w:w, action:'hold', why:'You hit your reps, but it was a real fight — so bank this weight once more before adding.' };
  }
  /* Consecutive earned sessions AT THIS WEIGHT. The streak used to run straight
     through a weight change, so the threshold only ever bit once in a lift's
     life and an intermediate then progressed every session, exactly like a
     beginner, while the screen said "one more clean session at this weight".
     A streak resting on assumed efforts asks for one extra clean session. */
  let earns = 0, assumed = false;
  for(const x of h){
    if(x.w !== w) break;
    if(x.hit && (x.eff === 'solid' || x.eff === 'easy')){ earns++; if(x.assumed) assumed = true; }
    else break;
  }
  const bar = earnedThreshold(o.exp) + (assumed ? 1 : 0);
  if(earns >= bar){
    const nw = up();
    return nw > w
      ? { w:nw, action:'progress', why:'Clean reps ' + earns + ' session' + (earns === 1 ? '' : 's') + ' running at ' + w + ' lb — it goes up ' + (nw - w) + ' lb.' }
      : { w:w, action:'hold', why:'Earned, but this is as fast as it should climb this week. It moves next time.' };
  }
  const need = bar - earns;
  return { w:w, action:'hold',
    why:'Solid work. ' + need + ' more clean session' + (need === 1 ? '' : 's') + ' at ' + w + ' lb and it goes up.' +
      (assumed ? ' Tap how a set felt and it can move sooner — an untapped session counts, just more cautiously.' : '') };
}

/**
 * Bodyweight and holds progress by reps or seconds, not load — but not as an
 * open-ended climb. Reps rise to the top of the goal's range, then complexity
 * takes over and the movement itself levels up. Two sessions short of target
 * steps back down: a loaded lift gets a 10% deload there and bodyweight used to
 * get nothing, held at a target it could not reach with no reason shown.
 *
 * @param {ReturnType<typeof judgeSession>[]} history newest first
 * @param {{baseReps:number, ceiling:number, nextRung?:string|null, prevRung?:string|null, exp?:string}} opts
 * @returns {{r:number, action:'progress'|'hold'|'levelup'|'regress', next?:string, why:string}|null}
 */
export function decideReps(history, opts){
  const h = history || [], o = opts || {};
  if(!h.length) return null;
  const last = h[0];
  const ceiling = o.ceiling || 15;
  const cur = Math.min(ceiling, Math.max(last.r || 0, o.baseReps || 0));

  if(last.eff === 'grind' || !last.hit){
    const backTo = (h[1] && (h[1].eff === 'grind' || !h[1].hit)) ? (o.prevRung || null) : null;
    if(backTo) return { r:cur, action:'regress', next:backTo,
      why:'Two sessions short of the target now. There is no weight to strip off a bodyweight movement, so the honest step is back to ' + backTo + ' — own the reps there and climb again.' };
    return { r:cur, action:'hold',
      why:'You came up short of ' + (last.targetR || cur) + ', so the target holds here until the reps come clean. Quality first, then the count.' };
  }
  let earns = 0;
  for(const x of h){ if(x.hit && x.eff !== 'hard' && x.eff !== 'grind') earns++; else break; }
  const earned = last.eff === 'easy' || earns >= earnedThreshold(o.exp);
  const atTop = Math.max(last.r || 0, o.baseReps || 0) >= ceiling;
  if(earned && atTop){
    if(o.nextRung) return { r:ceiling, action:'levelup', next:o.nextRung,
      why:'You own ' + ceiling + ' clean reps here — the top of the range. Time to level the movement up to ' + o.nextRung + ', where you rebuild from the bottom and start overloading again.' };
    return { r:ceiling, action:'hold',
      why:'You’ve maxed the reps and there’s no harder version in your kit to step up to — hold here and keep every rep clean.' };
  }
  if(earned) return { r:Math.min(ceiling, cur + 1), action:'progress',
    why:'You cleared these, so add a rep. Reps climb to ' + ceiling + ', then the movement itself levels up — that’s how bodyweight work keeps overloading.' };
  return { r:cur, action:'hold', why:'Solid — a clean session or two more and the reps step up.' };
}
