/** Readiness scoring, symptom tracking and session autoregulation.
 *  Re-exported from the shared engine so the declarations keep their original
 *  order. Import this module for readiness alone. */
export { bindHost } from './engine.js';
export {
  GROUPS,
  LOWER_SYMPTOM_REGIONS,
  READINESS_Q,
  SYMPTOM_REGIONS,
  activeSymptoms,
  autoReg,
  autoRegActive,
  autoRegDelta,
  autoRegPlan,
  dayGroups,
  dayLoadsLower,
  dowOf,
  groupHit,
  groupsOf,
  inLowerCluster,
  localISO,
  rdCtx,
  readinessBand,
  readinessScore,
  sevBand,
  todayISO,
  todayReadiness,
  todaysDay
} from './engine.js';
