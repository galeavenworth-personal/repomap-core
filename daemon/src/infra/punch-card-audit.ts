import { timestamp } from "./utils.js";
import { createOpencodeClient } from "@opencode-ai/sdk/client";

import { validateFromKiloLog } from "../governor/kilo-verified-validator.js";
import type { FactoryDispatchConfig, Logger } from "./factory-dispatch.js";

/** Post-session audit result. */
export interface AuditResult {
  cardId: string;
  status: "pass" | "fail";
  missing: string[];
  violations: string[];
}

export async function runPostSessionAudit(
  sessionId: string,
  cardId: string,
  config: FactoryDispatchConfig,
  log: Logger,
): Promise<AuditResult | null> {
  const kiloClient = createOpencodeClient({
    baseUrl: `http://${config.host}:${config.port}`,
  });

  try {
    const result = await validateFromKiloLog(
      sessionId,
      kiloClient,
      {
        host: config.host === "127.0.0.1" ? config.host : "127.0.0.1",
        port: config.doltPort,
        database: process.env.DOLT_DATABASE || "factory",
        user: "root",
      },
      cardId,
      {
        sourceSessionId: sessionId,
      },
    );
    const audit: AuditResult = {
      cardId,
      status: result.status,
      missing: result.missing.map((m) => `${m.punchType}:${m.punchKeyPattern}`),
      violations: result.violations.map((v) => `${v.punchType}:${v.punchKeyPattern} (${v.count}x)`),
    };

    if (result.status === "pass") {
      log(`${timestamp()} ✅ AUDIT PASS: card=${cardId} session=${sessionId}`);
    } else {
      log(`${timestamp()} ❌ AUDIT FAIL: card=${cardId} session=${sessionId}`);
      if (audit.missing.length > 0) {
        log(`${timestamp()}   Missing: ${audit.missing.join(", ")}`);
      }
      if (audit.violations.length > 0) {
        log(`${timestamp()}   Violations: ${audit.violations.join(", ")}`);
      }
    }

    return audit;
  } catch (e) {
    log(`${timestamp()} Warning: post-session audit failed: ${(e as Error).message}`);
    return null;
  }
}
