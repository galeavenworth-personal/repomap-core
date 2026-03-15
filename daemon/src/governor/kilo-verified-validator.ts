import mysql, { type Connection } from "mysql2/promise";

import { classifyEvent } from "../classifier/index.js";
import { asRecord, asStringOrNull } from "../infra/record-utils.js";
import type { DoltConfig } from "../writer/index.js";
import type { PunchCardRequirement } from "./types.js";
import type { KiloVerifiedValidationResult } from "./validation-types.js";

interface RequirementRow {
  punch_type: string;
  punch_key_pattern: string;
  required: number | boolean;
  forbidden: number | boolean;
  enforced: number | boolean;
  description?: string | null;
}

interface KiloMessageClient {
  session: {
    messages(args: { path: { id: string } }): Promise<{ data?: unknown[]; error?: unknown }>;
  };
}

interface ValidateFromKiloLogOptions {
  enforcedOnly?: boolean;
  sourceSessionId?: string;
}

interface DerivedPunch {
  punchType: string;
  punchKey: string;
}

function extractBashCommand(part: Record<string, unknown>): string | null {
  // Real-time SSE event shape: part.input.command
  const input = part.input;
  if (typeof input === "string") {
    return input;
  }
  const inputRecord = asRecord(input);
  const directCommand = asStringOrNull(inputRecord.command) ?? asStringOrNull(inputRecord.cmd);
  if (directCommand) {
    return directCommand;
  }

  // session.messages replay shape: part.state.input.command
  const state = asRecord(part.state);
  const stateInput = asRecord(state.input);
  return asStringOrNull(stateInput.command) ?? asStringOrNull(stateInput.cmd);
}

function classifyGateFromCommand(command: string, status: string): DerivedPunch | null {
  const normalized = command.trim();
  if (!normalized) {
    return null;
  }

  const gateMatchers: Array<{ regex: RegExp; key: string }> = [
    { regex: /(^|\s)ruff\s+format(\s|$)|(^|\s)ruff\s+.*--check(\s|$)/, key: "ruff-format" },
    { regex: /(^|\s)ruff\s+check(\s|$)/, key: "ruff-check" },
    { regex: /(^|\s)mypy(\s|$)/, key: "mypy" },
    { regex: /(^|\s)pytest(\s|$)/, key: "pytest" },
  ];

  for (const matcher of gateMatchers) {
    if (!matcher.regex.test(normalized)) {
      continue;
    }
    return {
      punchType: status === "error" ? "gate_fail" : "gate_pass",
      punchKey: matcher.key,
    };
  }

  return null;
}

function toBool(value: number | boolean): boolean {
  return value === true || value === 1;
}

function escapeRegex(value: string): string {
  return value.replaceAll(new RegExp(String.raw`[.*+?^\${}()|[\]\\]`, "g"), String.raw`\$&`);
}

function sqlLikeToRegex(pattern: string): RegExp {
  const escaped = escapeRegex(pattern)
    .replaceAll("%", ".*")
    .replaceAll("_", ".");
  return new RegExp(`^${escaped}$`);
}

function punchTypeAliases(punchType: string): string[] {
  const aliases = [punchType];
  if (punchType === "mcp_call") aliases.push("3");
  if (punchType === "gate_pass") aliases.push("4");
  if (punchType === "child_spawn") aliases.push("6");
  if (punchType === "child_complete") aliases.push("7");
  if (punchType === "step_complete") aliases.push("9");
  return aliases;
}

function matchesRequirement(punch: DerivedPunch, req: PunchCardRequirement): boolean {
  if (!punchTypeAliases(punch.punchType).includes(req.punchType)) {
    return false;
  }
  return sqlLikeToRegex(req.punchKeyPattern).test(punch.punchKey);
}

async function fetchCardRequirements(
  connection: Connection,
  cardId: string,
  options?: { enforcedOnly?: boolean },
): Promise<PunchCardRequirement[]> {
  const enforcedClause = options?.enforcedOnly ? " AND enforced = TRUE" : "";
  const [rowsUnknown] = await connection.execute(
    `SELECT
       punch_type,
       punch_key_pattern,
       required,
       forbidden,
       enforced,
       description
     FROM punch_cards
     WHERE card_id = ?${enforcedClause}`,
    [cardId],
  );

  const rows = rowsUnknown as RequirementRow[];
  return rows.map((row) => ({
    punchType: row.punch_type,
    punchKeyPattern: row.punch_key_pattern,
    required: toBool(row.required),
    forbidden: toBool(row.forbidden),
    enforced: toBool(row.enforced),
    description: row.description ?? undefined,
  }));
}

function derivePartPunches(
  sessionId: string,
  part: Record<string, unknown>,
): DerivedPunch[] {
  const partPunches: DerivedPunch[] = [];

  const punch = classifyEvent({
    type: "message.part.updated",
    properties: {
      part: {
        ...part,
        sessionID: sessionId,
      },
    },
  });

  if (punch) {
    partPunches.push({ punchType: punch.punchType, punchKey: punch.punchKey });

    const toolName = typeof part.tool === "string" ? part.tool : "";
    if (punch.punchType === "mcp_call" && toolName.startsWith("context7_")) {
      const suffix = toolName.slice("context7_".length);
      partPunches.push({
        punchType: "mcp_call",
        punchKey: `context7:${suffix}`,
      });
    }

    if (punch.punchType === "child_spawn") {
      const state = asRecord(part.state);
      const status = asStringOrNull(state.status);
      partPunches.push({
        punchType: "child_complete",
        punchKey: status === "error" ? "child_error" : "child_return",
      });
    }
  }

  if (typeof part.tool === "string" && part.tool.toLowerCase() === "bash") {
    const state = asRecord(part.state);
    const status = asStringOrNull(state.status);
    const command = extractBashCommand(part);
    if (command && (status === "completed" || status === "error")) {
      const gatePunch = classifyGateFromCommand(command, status);
      if (gatePunch) {
        partPunches.push(gatePunch);
      }
    }
  }

  return partPunches;
}

function hasSessionCompletionEvidence(messages: unknown[]): boolean {
  return messages.some((msgUnknown) => {
    const msg = asRecord(msgUnknown);
    const rawParts = msg.parts;
    const msgParts = Array.isArray(rawParts) ? rawParts : [];
    return msgParts.some((p) => {
      const pr = asRecord(p);
      return pr.type === "step-finish";
    });
  });
}

function derivePunches(sessionId: string, messages: unknown[]): DerivedPunch[] {
  const punches: DerivedPunch[] = [];

  for (const messageUnknown of messages) {
    const message = asRecord(messageUnknown);
    const rawParts = message.parts;
    const parts = Array.isArray(rawParts) ? rawParts : [];

    for (const partUnknown of parts) {
      const part = asRecord(partUnknown);
      punches.push(...derivePartPunches(sessionId, part));
    }
  }

  if (hasSessionCompletionEvidence(messages)) {
    punches.push({
      punchType: "step_complete",
      punchKey: "task_exit",
    });
  }

  return punches;
}

interface RequirementEvaluation {
  missing: KiloVerifiedValidationResult["missing"];
  violations: KiloVerifiedValidationResult["violations"];
}

function evaluateRequirements(
  requirements: PunchCardRequirement[],
  punches: DerivedPunch[],
): RequirementEvaluation {
  const missing: KiloVerifiedValidationResult["missing"] = [];
  const violations: KiloVerifiedValidationResult["violations"] = [];

  for (const requirement of requirements) {
    if (!requirement.required && !requirement.forbidden) {
      continue;
    }

    const count = punches.filter((punch) => matchesRequirement(punch, requirement)).length;

    if (requirement.forbidden) {
      if (count > 0) {
        violations.push({
          punchType: requirement.punchType,
          punchKeyPattern: requirement.punchKeyPattern,
          count,
          description: requirement.description,
        });
      }
      continue;
    }

    if (requirement.required && count <= 0) {
      missing.push({
        punchType: requirement.punchType,
        punchKeyPattern: requirement.punchKeyPattern,
        description: requirement.description,
      });
    }
  }

  return { missing, violations };
}

export async function validateFromKiloLog(
  sessionId: string,
  kiloClient: KiloMessageClient,
  doltConfig: DoltConfig,
  cardId: string,
  options?: ValidateFromKiloLogOptions,
): Promise<KiloVerifiedValidationResult> {
  const { data: messages, error } = await kiloClient.session.messages({
    path: { id: sessionId },
  });

  if (error) {
    throw new Error(`kilo session.messages failed for '${sessionId}'`);
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  const punches = derivePunches(sessionId, safeMessages);

  const connection = await mysql.createConnection({
    host: doltConfig.host,
    port: doltConfig.port,
    database: doltConfig.database,
    user: doltConfig.user ?? "root",
    password: doltConfig.password,
  });

  try {
    const requirements = await fetchCardRequirements(connection, cardId, options);
    if (requirements.length === 0) {
      throw new Error(`no requirements found for card '${cardId}'`);
    }

    const { missing, violations } = evaluateRequirements(requirements, punches);

    return {
      status: missing.length === 0 && violations.length === 0 ? "pass" : "fail",
      cardId,
      missing,
      violations,
      sessionId,
      sourceSessionId: options?.sourceSessionId ?? sessionId,
      messageCount: safeMessages.length,
      derivationPath:
        "kilo-sse:/event -> session.messages -> classifyEvent(message.part.updated) -> punch-card-evaluation",
      trustLevel: "verified",
    };
  } finally {
    await connection.end().catch(() => {});
  }
}
