import type { KiloVerifiedValidationResult } from "../../src/governor/validation-types.js";

const DEFAULT_DERIVATION_PATH =
  "kilo-sse:/event -> session.messages -> classifyEvent(message.part.updated) -> punch-card-evaluation";

export function makeValidatorResult(
  overrides: Partial<KiloVerifiedValidationResult> = {},
): KiloVerifiedValidationResult {
  return {
    status: "pass",
    cardId: "card-1",
    missing: [],
    violations: [],
    sessionId: "session-1",
    sourceSessionId: "session-1",
    messageCount: 0,
    derivationPath: DEFAULT_DERIVATION_PATH,
    trustLevel: "verified",
    ...overrides,
  };
}
