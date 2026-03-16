/**
 * Shared test helpers for factory-dispatch and molecule-dispatch tests.
 *
 * Eliminates duplication of mock setup, stack lifecycle, and stdout capture
 * patterns across factory-dispatch.test.ts and molecule-dispatch-e2e.test.ts.
 */

import { vi } from "vitest";
import type { Mock } from "vitest";
import {
  type FactoryDispatchConfig,
  type MoleculeDispatchResult,
  defaultConfig,
  ExitCode,
} from "../../src/infra/factory-dispatch.js";
import * as pm2Client from "../../src/infra/pm2-client.js";
import { createServer, type Server } from "node:net";

type FetchInput = string | URL | Request;

// ── Config helpers ───────────────────────────────────────────────────────

export function makeTestConfig(
  overrides: Partial<FactoryDispatchConfig> = {},
): FactoryDispatchConfig {
  return {
    ...defaultConfig(),
    quiet: true,
    pollInterval: 0.01, // fast polling for tests
    maxWait: 1,
    idleConfirm: 1,
    ...overrides,
  };
}

export function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Stack lifecycle ──────────────────────────────────────────────────────

export interface TestStack {
  doltPort: number;
  temporalPort: number;
  pm2Spy: ReturnType<typeof vi.spyOn>;
  mockFetch: Mock<(input: FetchInput, init?: RequestInit) => Promise<Response>>;
  cleanup(): Promise<void>;
}

export async function startHealthyStack(): Promise<TestStack> {
  const doltServer = createServer();
  const temporalServer = createServer();
  await new Promise<void>((resolve) => doltServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => temporalServer.listen(0, "127.0.0.1", resolve));

  const doltAddr = doltServer.address();
  const temporalAddr = temporalServer.address();
  const doltPort = typeof doltAddr === "object" && doltAddr ? doltAddr.port : 0;
  const temporalPort = typeof temporalAddr === "object" && temporalAddr ? temporalAddr.port : 0;

  const pm2Spy = vi
    .spyOn(pm2Client, "withPm2Connection")
    .mockImplementation(async () => true as never);
  const mockFetch = vi.fn(async () => mockFetchResponse([]));

  return {
    doltPort,
    temporalPort,
    pm2Spy,
    mockFetch,
    async cleanup() {
      pm2Spy.mockRestore();
      await new Promise<void>((resolve) => doltServer.close(() => resolve()));
      await new Promise<void>((resolve) => temporalServer.close(() => resolve()));
    },
  };
}

// ── BD pipeline mock builders ────────────────────────────────────────────

export interface BdPipelineMockOptions {
  protoId?: string;
  moleculeId?: string;
  steps: Array<{
    id: string;
    title: string;
    description: string;
    labels: string[];
    bead_id?: string;
  }>;
}

/**
 * Creates a mock for the 4-phase BD pipeline: cook → cook --persist → pour → show.
 * Returns a vi.fn() pre-configured with the correct sequence of resolved values.
 */
export function mockBdPipeline(opts: BdPipelineMockOptions): Mock {
  const protoId = opts.protoId ?? "proto-test";
  const moleculeId = opts.moleculeId ?? "mol-test";
  return vi
    .fn()
    .mockResolvedValueOnce({ id: protoId })
    .mockResolvedValueOnce({ id: protoId })
    .mockResolvedValueOnce({ molecule_id: moleculeId })
    .mockResolvedValueOnce({ steps: opts.steps });
}

/**
 * Creates a runSingleDispatchFn mock that returns SUCCESS for each call.
 * Optionally accepts per-call overrides.
 */
export function mockSuccessfulDispatches(
  count: number,
  sessionPrefix = "sess-test",
): Mock {
  const fn = vi.fn();
  for (let i = 0; i < count; i++) {
    fn.mockResolvedValueOnce({
      code: ExitCode.SUCCESS,
      session_id: `${sessionPrefix}-${i + 1}`,
      result: `Step ${i + 1} completed`,
      elapsed_seconds: (i + 1) * 5,
    });
  }
  return fn;
}

// ── Stdout capture ───────────────────────────────────────────────────────

export interface StdoutCapture {
  chunks: string[];
  spy: ReturnType<typeof vi.spyOn>;
  /** Parse captured stdout as JSON (for MoleculeDispatchResult). */
  json<T = MoleculeDispatchResult>(): T;
}

export function captureStdout(): StdoutCapture {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
  return {
    chunks,
    spy,
    json<T = MoleculeDispatchResult>(): T {
      return JSON.parse(chunks.join("")) as T;
    },
  };
}

// ── Molecule test config shorthand ───────────────────────────────────────

export function moleculeTestConfig(
  stack: TestStack,
  overrides: Partial<FactoryDispatchConfig> = {},
): FactoryDispatchConfig {
  return makeTestConfig({
    formula: "test-formula",
    promptArg: "",
    jsonOutput: true,
    doltPort: stack.doltPort,
    temporalPort: stack.temporalPort,
    ...overrides,
  });
}
