/**
 * Governor — Session loop detection, kill switch, diagnosis, fitter dispatch,
 * and cost budget enforcement.
 *
 * The governor is the enforcement mechanism that detects runaway sessions
 * and dispatches line fitters to recover. It operates on the punch card
 * stream produced by the daemon's classify → write pipeline.
 *
 * Architecture:
 *   Punch Stream → LoopDetector → SessionKiller → DiagnosisEngine → FitterDispatch
 *   Dolt Punches → CostBudgetMonitor → GovernorIntervention → SessionKiller
 */

export { LoopDetector, type LoopDetectorOptions } from "./loop-detector.js";
export {
  killSession,
  getSessionMetrics,
  type SessionKillerConfig,
  type SessionKillerDeps,
} from "./session-killer.js";
export {
  diagnoseSession,
  type DiagnosisConfig,
} from "./diagnosis-engine.js";
export {
  FitterDispatch,
  DEFAULT_FITTER_CONFIG,
  type FitterDispatchConfig,
  type FitterDispatchDeps,
  type SessionDispatcher,
  type SessionRequest,
  type SessionResponse,
} from "./fitter-dispatch.js";
export {
  BaseDoltClient,
  toNumber,
  parseEnvFloat,
  parseEnvInt,
  type MysqlNumeric,
  type CostAggRow,
  type ChildRow,
} from "./dolt-utils.js";
export {
  CostBudgetMonitor,
  loadCostBudgetConfig,
  DEFAULT_COST_BUDGET_CONFIG,
  type CostBudgetConfig,
  type SessionCostSnapshot,
  type TreeCostSnapshot,
  type CostBudgetCheckResult,
  type CostBreach,
  type GovernorIntervention,
  type BudgetStatus,
} from "./cost-budget-monitor.js";
export {
  SessionAudit,
  loadAuditConfig,
  DEFAULT_AUDIT_CONFIG,
} from "./session-audit.js";
export {
  type LoopClassification,
  type LoopDetection,
  type SessionMetrics,
  type GovernorThresholds,
  DEFAULT_THRESHOLDS,
  type KillConfirmation,
  type DiagnosisCategory,
  type DiagnosisReport,
  type ToolPattern,
  type FitterDispatchInput,
  type FitterResult,
  type PunchCardRequirement,
  type AuditSeverity,
  type AuditAnomalyType,
  type AuditFinding,
  type SessionAuditConfig,
  type SessionAuditReport,
} from "./types.js";
export {
  type ValidationTrustLevel,
  type ValidationChainOfCustody,
  type KiloVerifiedValidationResult,
} from "./validation-types.js";
