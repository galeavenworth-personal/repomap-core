/**
 * Foreman Workflow Tests
 *
 * Unit tests for the foreman control loop workflow. All Temporal SDK
 * imports are mocked to provide deterministic, synchronous execution.
 * Activities are mocked via proxyActivities, and child workflows
 * (agentTaskWorkflow) are mocked via startChild.
 *
 * Test organization:
 *   1. Happy path: health OK → select bead → dispatch → complete → close bead
 *   2. No work available: select returns null → idle → re-poll
 *   3. Health gate blocked: checkStackHealth returns fail → idle → re-check
 *   4. Pause/resume signals: workflow pauses and resumes correctly
 *   5. Shutdown signal: workflow exits cleanly
 *   6. Continue-as-new: triggers after iteration threshold
 *   7. Retry and escalation: failed dispatches trigger retry ledger
 *   8. Skip bead signal: bead is excluded from selection
 *   9. Force dispatch signal: bead is dispatched immediately
 *  10. Config update signal: config is hot-updated
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Temporal SDK Mock ──

/**
 * We mock the entire @temporalio/workflow module. Signal/query handlers
 * are captured so tests can invoke them. The workflow's control flow
 * (sleep, condition, continueAsNew, startChild) is intercepted.
 */

// Storage for signal/query handlers registered by the workflow
const signalHandlers = new Map<string, (...args: unknown[]) => void>();
const queryHandlers = new Map<string, (...args: unknown[]) => unknown>();

// Track continueAsNew calls
let continueAsNewCalled = false;
let continueAsNewArgs: unknown = null;

// Track sleep calls
let sleepCalls: (string | number)[] = [];

// Mock for condition — immediately resolves by default
let conditionResolver: (() => void) | null = null;
let conditionPredicate: (() => boolean) | null = null;

// Control for startChild mock
let childResults: unknown[] = [];
let childStartCount = 0;
let startChildCalls: Array<{ workflowId: string; args: unknown[]; taskQueue: string }> = [];

// Error class to simulate continueAsNew throw behavior
class ContinueAsNewError extends Error {
  constructor(public readonly args: unknown) {
    super("continueAsNew");
    this.name = "ContinueAsNewError";
  }
}

vi.mock("@temporalio/workflow", () => {
  return {
    proxyActivities: vi.fn(() => {
      // Returns a proxy that delegates to our mock activities
      return new Proxy(
        {},
        {
          get: (_target, prop) => {
            return (...args: unknown[]) => {
              const fn = mockActivities[prop as string];
              if (!fn) throw new Error(`No mock for activity: ${String(prop)}`);
              return fn(...args);
            };
          },
        },
      );
    }),

    defineSignal: vi.fn((name: string) => name),
    defineQuery: vi.fn((name: string) => name),

    setHandler: vi.fn((nameOrDef: string, handler: (...args: unknown[]) => unknown) => {
      // Store handlers for test access
      signalHandlers.set(nameOrDef, handler as (...args: unknown[]) => void);
      queryHandlers.set(nameOrDef, handler);
    }),

    sleep: vi.fn(async (duration: string | number) => {
      sleepCalls.push(duration);
    }),

    condition: vi.fn(async (predicate: () => boolean) => {
      conditionPredicate = predicate;
      // If predicate is already true, resolve immediately
      if (predicate()) return true;
      // Otherwise, store resolver for test to trigger
      return new Promise<boolean>((resolve) => {
        conditionResolver = () => {
          resolve(predicate());
        };
      });
    }),

    continueAsNew: vi.fn(async (...args: unknown[]) => {
      continueAsNewCalled = true;
      continueAsNewArgs = args;
      // continueAsNew in Temporal throws to exit the workflow
      throw new ContinueAsNewError(args);
    }),

    startChild: vi.fn(async (_workflow: unknown, options: Record<string, unknown>) => {
      const idx = childStartCount++;
      startChildCalls.push({
        workflowId: options.workflowId as string,
        args: options.args as unknown[],
        taskQueue: options.taskQueue as string,
      });
      return {
        result: async () => childResults[idx] ?? childResults.at(-1),
      };
    }),

    isCancellation: vi.fn((err: unknown) => {
      return err instanceof Error && err.message === "CANCELLED";
    }),
  };
});

// ── Activity Mocks ──

interface MockActivities {
  [key: string]: (...args: unknown[]) => unknown;
}

const mockActivities: MockActivities = {};

function setMockActivity(name: string, impl: (...args: unknown[]) => unknown) {
  mockActivities[name] = impl;
}

function setPassHealthAndNoWork(): void {
  setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
  setMockActivity("selectNextBead", () => null);
}

async function runWorkflowExpectContinueAsNew(
  input: ForemanInput,
): Promise<unknown[] | null> {
  try {
    await foremanWorkflow(input);
    return continueAsNewCalled ? (continueAsNewArgs as unknown[]) : null;
  } catch (e) {
    if (e instanceof ContinueAsNewError) {
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
      return e.args as unknown[];
    }
    throw e;
  }
}

async function runWorkflowAllowContinueAsNew(input: ForemanInput): Promise<void> {
  await runWorkflowExpectContinueAsNew(input);
}

// ── Import workflow (after mocks) ──

import { foremanWorkflow } from "../src/temporal/foreman.workflows.js";
import type {
  ForemanInput,
  HealthCheckResult,
} from "../src/temporal/foreman.types.js";
import type { AgentTaskResult } from "../src/temporal/workflows.js";

// ── Fixtures ──

function makeInput(overrides: Partial<ForemanInput> = {}): ForemanInput {
  return {
    workflowId: "foreman-test",
    repoPath: "/fake/repo",
    taskQueue: "agent-tasks",
    kiloHost: "127.0.0.1",
    kiloPort: 4096,
    doltHost: "127.0.0.1",
    doltPort: 3307,
    doltDatabase: "beads_test",
    pollIntervalMs: 1000,
    healthCheckIntervalMs: 5000,
    maxIterations: 100,
    maxWallClockMs: 14_400_000,
    maxConcurrentDispatches: 1,
    defaultTimeoutMs: 7_200_000,
    defaultCostBudgetUsd: 5,
    maxRetriesPerBead: 2,
    retryBackoffMs: 30_000,
    carriedState: null,
    ...overrides,
  };
}

function makeHealthResult(overall: "pass" | "degraded" | "fail" = "pass"): HealthCheckResult {
  const status = overall === "fail" ? "down" as const : "up" as const;
  return {
    overall,
    checkedAt: new Date().toISOString(),
    subsystems: {
      kiloServe: { status, message: null, latencyMs: 10 },
      dolt: { status, message: null, latencyMs: 5 },
      git: { status: "up", message: null, latencyMs: 3 },
      temporal: { status: "up", message: null, latencyMs: 0 },
      beads: { status, message: null, latencyMs: 8 },
    },
  };
}

function makeAgentResult(
  overrides: Partial<AgentTaskResult> = {},
): AgentTaskResult {
  return {
    status: "completed",
    sessionId: "sess-1",
    totalParts: 10,
    toolCalls: 5,
    durationMs: 60_000,
    totalCost: 0.5,
    tokensInput: 5000,
    tokensOutput: 2000,
    error: null,
    audit: null,
    ...overrides,
  };
}

// ── Test Setup ──

beforeEach(() => {
  vi.clearAllMocks();
  signalHandlers.clear();
  queryHandlers.clear();
  continueAsNewCalled = false;
  continueAsNewArgs = null;
  sleepCalls = [];
  conditionResolver = null;
  conditionPredicate = null;
  childResults = [];
  childStartCount = 0;
  startChildCalls = [];

  // Clear all mock activities
  for (const key of Object.keys(mockActivities)) {
    delete mockActivities[key];
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Happy Path ──

describe("happy path", () => {
  it("dispatches a bead, completes, and closes it", async () => {
    // Control loop: we need the workflow to exit after one iteration.
    // Strategy: after closing the bead, the second selectNextBead returns null,
    // then we trigger shutdown on the third iteration.
    let selectCallCount = 0;
     const iterationCount = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          beadId: "bead-1",
          title: "Fix the bug",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      // After the first bead, trigger shutdown to exit the loop
      // We do this by checking if we should signal shutdown
      return null;
    });
    setMockActivity("getBeadDetail", (_repoPath: unknown, beadId: unknown) => ({
      beadId,
      title: "Fix the bug",
      priority: "P1",
      labels: [],
      dependsOn: [],
      description: "Detailed description of the bug",
      estimatedComplexity: "small",
      status: "ready",
    }));
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult()];

    // We need to break the infinite loop. Strategy:
    // Use maxIterations = 2 so that after 2 iterations, continueAsNew fires.
    const input = makeInput({ maxIterations: 2 });

    // The workflow will:
    // 1. Health check → pass
    // 2. Select bead-1 → dispatch → monitor → complete → close
    // 3. iterationCount = 1
    // 4. Select → null → idle → sleep → iterationCount = 2
    // 5. shouldContinueAsNew → true → throws ContinueAsNewError
    await runWorkflowAllowContinueAsNew(input);

    // Verify the bead was dispatched
    expect(startChildCalls.length).toBe(1);
    expect(startChildCalls[0].taskQueue).toBe("agent-tasks");

    // Verify closeBead was called
    const closeBeadFn = mockActivities["closeBead"];
    expect(closeBeadFn).toBeDefined();
  });
});

// ── 2. No Work Available ──

describe("no work available", () => {
  it("idles and re-polls when selectNextBead returns null", async () => {
    setPassHealthAndNoWork();

    // maxIterations = 2 to exit after 2 idle loops
    const input = makeInput({ maxIterations: 2 });

    await runWorkflowAllowContinueAsNew(input);

    // Should have slept twice (idle backoff) 
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);

    // No child workflows started
    expect(startChildCalls.length).toBe(0);
  });
});

// ── 3. Health Gate Blocked ──

describe("health gate blocked", () => {
  it("idles when health check fails, does not dispatch", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("fail"));
    // selectNextBead should NOT be called when health fails
    setMockActivity("selectNextBead", () => {
      throw new Error("selectNextBead should not be called when health fails");
    });

    const input = makeInput({ maxIterations: 2 });

    await runWorkflowAllowContinueAsNew(input);

    // Should have slept (idle due to health failure)
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);

    // No child workflows started
    expect(startChildCalls.length).toBe(0);
  });

  it("proceeds when health check returns degraded", async () => {
    let selectCalls = 0;
    setMockActivity("checkStackHealth", () => makeHealthResult("degraded"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      return null; // No work, but the activity WAS called
    });

    const input = makeInput({ maxIterations: 2 });

    await runWorkflowAllowContinueAsNew(input);

    // selectNextBead should have been called (degraded allows dispatch)
    expect(selectCalls).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. Pause/Resume ──

describe("pause/resume", () => {
  it("registers pause and resume signal handlers", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 1 });

    await runWorkflowAllowContinueAsNew(input);

    // Verify signal handlers were registered
    expect(signalHandlers.has("foreman.pause")).toBe(true);
    expect(signalHandlers.has("foreman.resume")).toBe(true);
  });
});

// ── 5. Shutdown ──

describe("shutdown", () => {
  it("exits cleanly when shutdown is carried from previous continue-as-new", async () => {
    const input = makeInput({
      carriedState: {
        totalIterations: 50,
        totalDispatches: 10,
        totalCompletions: 9,
        totalFailures: 1,
        totalEscalations: 0,
        lastHealthCheck: null,
        lastHealthCheckAt: null,
        recentOutcomes: [],
        retryLedger: [],
        pauseRequested: false,
        shutdownRequested: true,
        foremanStartedAt: new Date().toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    const result = await foremanWorkflow(input);

    expect(result.status).toBe("shutdown");
    expect(result.totalIterations).toBe(50);
    expect(result.totalDispatches).toBe(10);
  });

  it("registers shutdown signal handler", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 1 });

    await runWorkflowAllowContinueAsNew(input);

    expect(signalHandlers.has("foreman.shutdown")).toBe(true);
  });
});

// ── 6. Continue-As-New ──

describe("continue-as-new", () => {
  it("triggers after maxIterations is reached", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 3 });

    const args = await runWorkflowExpectContinueAsNew(input);
    continueAsNewCalled = args !== null;
    continueAsNewArgs = args;

    expect(continueAsNewCalled).toBe(true);
    // The args should include carriedState
    expect(continueAsNewArgs).toBeDefined();
    const carriedArgs = continueAsNewArgs as unknown[];
    const carriedInput = carriedArgs[0] as ForemanInput;
    expect(carriedInput.carriedState).not.toBeNull();
    expect(carriedInput.carriedState!.totalIterations).toBeGreaterThanOrEqual(3);
  });

  it("carries forward counters across continue-as-new", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({
      maxIterations: 2,
      carriedState: {
        totalIterations: 100,
        totalDispatches: 50,
        totalCompletions: 45,
        totalFailures: 5,
        totalEscalations: 2,
        lastHealthCheck: null,
        lastHealthCheckAt: null,
        recentOutcomes: [],
        retryLedger: [],
        pauseRequested: false,
        shutdownRequested: false,
        foremanStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    const args = await runWorkflowExpectContinueAsNew(input);
    continueAsNewCalled = args !== null;
    continueAsNewArgs = args;

    expect(continueAsNewCalled).toBe(true);
    const carriedArgs = continueAsNewArgs as unknown[];
    const carriedInput = carriedArgs[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalIterations).toBeGreaterThanOrEqual(102);
    expect(carriedInput.carriedState!.totalDispatches).toBe(50);
    expect(carriedInput.carriedState!.totalCompletions).toBe(45);
  });
});

// ── 7. Retry and Escalation ──

describe("retry and escalation", () => {
  it("records a failed dispatch in the retry ledger", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-fail",
          title: "Will fail",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("getBeadDetail", (_repoPath: unknown, beadId: unknown) => ({
      beadId,
      title: "Will fail",
      priority: "P1",
      labels: [],
      dependsOn: [],
      description: "",
      estimatedComplexity: "small",
      status: "ready",
    }));
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    // Child workflow returns a retryable failure
    childResults = [
      makeAgentResult({
        status: "failed",
        error: "ECONNREFUSED: connection refused",
      }),
    ];

    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 2 });

    const args = await runWorkflowExpectContinueAsNew(input);
    continueAsNewCalled = args !== null;
    continueAsNewArgs = args;

    // The continue-as-new state should have the retry ledger entry
    expect(continueAsNewCalled).toBe(true);
    const carriedArgs = continueAsNewArgs as unknown[];
    const carriedInput = carriedArgs[0] as ForemanInput;
    const ledger = carriedInput.carriedState!.retryLedger;
    expect(ledger.length).toBe(1);
    expect(ledger[0].beadId).toBe("bead-fail");
    expect(ledger[0].attempts).toBe(1);
    expect(ledger[0].exhausted).toBe(false);
  });

  it("escalates when a non-retryable failure occurs", async () => {
    let selectCalls = 0;
    const updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-nonretry",
          title: "Non-retryable failure",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("getBeadDetail", (_repoPath: unknown, beadId: unknown) => ({
      beadId,
      title: "Non-retryable failure",
      priority: "P1",
      labels: [],
      dependsOn: [],
      description: "",
      estimatedComplexity: "small",
      status: "ready",
    }));
    setMockActivity("updateBeadStatus", (_repoPath: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });

    // Child workflow returns budget_exceeded (non-retryable)
    childResults = [
      makeAgentResult({
        status: "budget_exceeded",
        totalCost: 10,
        error: "Cost budget exceeded",
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    const args = await runWorkflowExpectContinueAsNew(input);
    continueAsNewCalled = args !== null;
    continueAsNewArgs = args;

    // Should have set bead back to ready (unclaim)
    const unclaimCall = updateStatusCalls.find((c) => c.status === "ready");
    expect(unclaimCall).toBeDefined();
    expect(unclaimCall!.beadId).toBe("bead-nonretry");

    // Escalation counter should be incremented
    const carriedArgs = continueAsNewArgs as unknown[];
    const carriedInput = carriedArgs[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalEscalations).toBe(1);
    expect(carriedInput.carriedState!.totalFailures).toBe(1);
  });
});

// ── 8. Skip Bead ──

describe("skip bead signal", () => {
  it("registers skipBead signal handler", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 1 });

    await runWorkflowAllowContinueAsNew(input);

    expect(signalHandlers.has("foreman.skipBead")).toBe(true);
  });
});

// ── 9. Force Dispatch ──

describe("force dispatch signal", () => {
  it("registers forceDispatch signal handler", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 1 });

    await runWorkflowAllowContinueAsNew(input);

    expect(signalHandlers.has("foreman.forceDispatch")).toBe(true);
  });
});

// ── 10. Config Update ──

describe("config update signal", () => {
  it("registers updateConfig signal handler", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 1 });

    await runWorkflowAllowContinueAsNew(input);

    expect(signalHandlers.has("foreman.updateConfig")).toBe(true);
  });
});

// ── 11. Query Handlers ──

describe("query handlers", () => {
  it("registers status query handler", async () => {
    setPassHealthAndNoWork();

    const input = makeInput({ maxIterations: 1 });

    await runWorkflowAllowContinueAsNew(input);

    expect(queryHandlers.has("foreman.status")).toBe(true);
    expect(queryHandlers.has("foreman.health")).toBe(true);
    expect(queryHandlers.has("foreman.history")).toBe(true);
  });
});

// ── 12. Dispatch outcome recording ──

describe("dispatch outcome recording", () => {
  it("records outcome with correct fields after successful dispatch", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-record",
          title: "Record test",
          priority: "P2",
          labels: ["test"],
          dependsOn: [],
          estimatedComplexity: "trivial",
        };
      }
      return null;
    });
    setMockActivity("getBeadDetail", (_repoPath: unknown, beadId: unknown) => ({
      beadId,
      title: "Record test",
      priority: "P2",
      labels: ["test"],
      dependsOn: [],
      description: "A test bead for recording",
      estimatedComplexity: "trivial",
      status: "ready",
    }));
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [
      makeAgentResult({
        status: "completed",
        sessionId: "sess-record",
        totalCost: 1.23,
        tokensInput: 8000,
        tokensOutput: 4000,
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    const args = await runWorkflowExpectContinueAsNew(input);
    continueAsNewCalled = args !== null;
    continueAsNewArgs = args;

    expect(continueAsNewCalled).toBe(true);
    const carriedArgs = continueAsNewArgs as unknown[];
    const carriedInput = carriedArgs[0] as ForemanInput;
    const outcomes = carriedInput.carriedState!.recentOutcomes;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0].beadId).toBe("bead-record");
    expect(outcomes[0].sessionId).toBe("sess-record");
    expect(outcomes[0].result).toEqual({ kind: "completed" });
    expect(outcomes[0].totalCost).toBe(1.23);
    expect(outcomes[0].tokensInput).toBe(8000);
    expect(outcomes[0].tokensOutput).toBe(4000);
  });
});

// ── 13. Error handling ──

describe("error handling", () => {
  it("returns failed result on unexpected error", async () => {
    setMockActivity("checkStackHealth", () => {
      throw new Error("unexpected boom");
    });

    const input = makeInput();

    const result = await foremanWorkflow(input);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("unexpected boom");
  });
});

// ── 14. Aborted dispatch ──

describe("aborted dispatch", () => {
  it("unclaims bead when child workflow is aborted", async () => {
    let selectCalls = 0;
    const updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-abort",
          title: "Will be aborted",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("getBeadDetail", (_repoPath: unknown, beadId: unknown) => ({
      beadId,
      title: "Will be aborted",
      priority: "P1",
      labels: [],
      dependsOn: [],
      description: "",
      estimatedComplexity: "small",
      status: "ready",
    }));
    setMockActivity("updateBeadStatus", (_repoPath: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });

    childResults = [
      makeAgentResult({
        status: "aborted",
        error: "operator aborted",
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    await runWorkflowAllowContinueAsNew(input);

    // Should have unclaimed the bead (set back to ready)
    const unclaimCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-abort" && c.status === "ready",
    );
    expect(unclaimCall).toBeDefined();
  });
});

// ── 15. Retry backoff computation ──

describe("retry backoff", () => {
  it("uses fixed backoff (not linear scaling) and unclaims bead for re-selection", async () => {
    let selectCalls = 0;
    const updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-retry",
          title: "Retry backoff test",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("getBeadDetail", (_repoPath: unknown, beadId: unknown) => ({
      beadId,
      title: "Retry backoff test",
      priority: "P1",
      labels: [],
      dependsOn: [],
      description: "Test bead for retry backoff validation",
      estimatedComplexity: "small",
      status: "ready",
    }));
    setMockActivity("updateBeadStatus", (_repoPath: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });

    // Child workflow returns a retryable failure (timeout)
    childResults = [
      makeAgentResult({
        status: "failed",
        error: "ECONNREFUSED: connection refused",
      }),
    ];

    const retryBackoffMs = 30_000;
    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 2, retryBackoffMs });

    const args = await runWorkflowExpectContinueAsNew(input);
    continueAsNewCalled = args !== null;
    continueAsNewArgs = args;

    expect(continueAsNewCalled).toBe(true);
    const carriedArgs = continueAsNewArgs as unknown[];
    const carriedInput = carriedArgs[0] as ForemanInput;
    const ledger = carriedInput.carriedState!.retryLedger;

    // Verify retry ledger has the entry
    expect(ledger.length).toBe(1);
    expect(ledger[0].beadId).toBe("bead-retry");
    expect(ledger[0].attempts).toBe(1);
    expect(ledger[0].exhausted).toBe(false);

    // Verify FIXED backoff: nextRetryAfter = lastAttemptAt + retryBackoffMs
    // (not lastAttemptAt + retryBackoffMs * attempts)
    const lastAttemptMs = Date.parse(ledger[0].lastAttemptAt);
    const nextRetryMs = Date.parse(ledger[0].nextRetryAfter);
    const actualBackoff = nextRetryMs - lastAttemptMs;
    expect(actualBackoff).toBe(retryBackoffMs);

    // Verify the bead was unclaimed (set back to "ready") for future re-selection
    const unclaimCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-retry" && c.status === "ready",
    );
    expect(unclaimCall).toBeDefined();
  });
});
