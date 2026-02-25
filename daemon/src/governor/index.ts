/**
 * Governor — Session loop detection, kill switch, diagnosis, and fitter dispatch.
 *
 * The governor is the enforcement mechanism that detects runaway sessions
 * and dispatches line fitters to recover. It operates on the punch card
 * stream produced by the daemon's classify → write pipeline.
 *
 * Architecture:
 *   Punch Stream → LoopDetector → SessionKiller → DiagnosisEngine → FitterDispatch
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
} from "./types.js";
