/**
 * Chain-of-custody metadata for validator outputs.
 *
 * Ground truth source is kilo serve SSE (`GET /event`) replayed via
 * `client.session.messages()` and/or `client.event.subscribe()`.
 */

export type ValidationTrustLevel = "verified" | "projected" | "untrusted";

/**
 * Required provenance envelope for every kilo-verified validator result.
 */
export interface ValidationChainOfCustody {
  /** Session being validated (result subject). */
  sessionId: string;
  /** Source session ID used to derive evidence (usually same as sessionId). */
  sourceSessionId: string;
  /** Number of source messages replayed from kilo event history. */
  messageCount: number;
  /** Explicit derivation trace from source log to validation verdict. */
  derivationPath: string;
  /** Trust classification for this validation result. */
  trustLevel: ValidationTrustLevel;
}

/**
 * Standardized output shape expected from kilo-verified-validator.ts.
 */
export interface KiloVerifiedValidationResult extends ValidationChainOfCustody {
  status: "pass" | "fail";
  cardId: string;
  missing: Array<{ punchType: string; punchKeyPattern: string; description?: string }>;
  violations: Array<{ punchType: string; punchKeyPattern: string; count: number; description?: string }>;
}
