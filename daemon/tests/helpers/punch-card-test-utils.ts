import type { Mock } from "vitest";

import { PunchCardValidator } from "../../src/governor/punch-card-validator.js";
import { SubtaskVerifier } from "../../src/governor/subtask-verifier.js";

/** Default Dolt config used across all punch card tests. */
export const DEFAULT_DOLT_CONFIG = {
  host: "127.0.0.1",
  port: 3307,
  database: "plant",
} as const;

/** Set up mysql2 mock connection behavior in beforeEach. */
export function setupMysqlMocks(
  executeMock: Mock,
  endMock: Mock,
  createConnectionMock: Mock,
): void {
  endMock.mockResolvedValue(undefined);
  createConnectionMock.mockResolvedValue({
    execute: executeMock,
    end: endMock,
  });
}

/** Factory: create a punch card requirement row. */
export function makeRequirement(
  overrides: {
    punch_type?: string;
    punch_key_pattern?: string;
    required?: number;
    forbidden?: number;
    description?: string;
  } = {},
) {
  return {
    punch_type: "tool_call",
    punch_key_pattern: "read_file%",
    required: 1,
    forbidden: 0,
    ...overrides,
  };
}

/** Factory: wrap a count value in the mysql2 result format. */
export function makeCountResult(count: number) {
  return [[{ count }]];
}

/** Factory: wrap child IDs in the mysql2 result format. */
export function makeChildIds(...ids: string[]) {
  return [ids.map((id) => ({ child_id: id }))];
}

/** Create and connect a PunchCardValidator with default config. */
export async function createConnectedValidator(
  config = DEFAULT_DOLT_CONFIG,
): Promise<PunchCardValidator> {
  const validator = new PunchCardValidator(config);
  await validator.connect();
  return validator;
}

/** Create and connect a SubtaskVerifier with default config. */
export async function createConnectedVerifier(
  config = DEFAULT_DOLT_CONFIG,
): Promise<SubtaskVerifier> {
  const verifier = new SubtaskVerifier(new PunchCardValidator(config));
  await verifier.connect();
  return verifier;
}
