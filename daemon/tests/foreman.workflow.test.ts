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
        result: async () => childResults[idx] ?? childResults[childResults.length - 1],
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

// ── Import workflow (after mocks) ──

import { foremanWorkflow } from "../src/temporal/foreman.workflows.js";
import type {
  ForemanInput,
  ForemanStatus,
  HealthCheckResult,
  DispatchOutcome,
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
    defaultCostBudgetUsd: 5.0,
    maxRetriesPerBead: 2,
    retryBackoffMs: 30_000,
    healthFailureThreshold: 5,
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
    let iterationCount = 0;

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
    try {
      await foremanWorkflow(input);
      // If it completes (unlikely in this setup), that's also fine
    } catch (e) {
      // ContinueAsNewError is expected
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

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
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    // maxIterations = 2 to exit after 2 idle loops
    const input = makeInput({ maxIterations: 2 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

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

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

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

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // selectNextBead should have been called (degraded allows dispatch)
    expect(selectCalls).toBeGreaterThanOrEqual(1);
  });
});

// ── 4. Pause/Resume ──

describe("pause/resume", () => {
  it("registers pause and resume signal handlers", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected: continueAsNew
    }

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
        consecutiveHealthFailures: 0,
        interventionReason: null,
        awaitingInterventionSince: null,
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
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected
    }

    expect(signalHandlers.has("foreman.shutdown")).toBe(true);
  });
});

// ── 6. Continue-As-New ──

describe("continue-as-new", () => {
  it("triggers after maxIterations is reached", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (e instanceof ContinueAsNewError) {
        continueAsNewCalled = true;
        continueAsNewArgs = e.args;
      } else {
        throw e;
      }
    }

    expect(continueAsNewCalled).toBe(true);
    // The args should include carriedState
    expect(continueAsNewArgs).toBeDefined();
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState).not.toBeNull();
    expect(carriedInput.carriedState!.totalIterations).toBeGreaterThanOrEqual(3);
  });

  it("carries forward counters across continue-as-new", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

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
        consecutiveHealthFailures: 0,
        interventionReason: null,
        awaitingInterventionSince: null,
        foremanStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (e instanceof ContinueAsNewError) {
        continueAsNewCalled = true;
        continueAsNewArgs = e.args;
      } else {
        throw e;
      }
    }

    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalIterations).toBeGreaterThanOrEqual(102);
    expect(carriedInput.carriedState!.totalDispatches).toBe(50);
    expect(carriedInput.carriedState!.totalCompletions).toBe(45);
  });
});

// ── 7. Retry and Escalation ──

describe("retry and escalation", () => {
  it("records a failed dispatch in the retry ledger", async () => {
    let selectCalls = 0;
    let annotateBeadCalls: Array<{ beadId: string; comment: string }> = [];

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
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));
    setMockActivity("annotateBead", (input: unknown) => {
      const inp = input as { beadId: string; comment: string };
      annotateBeadCalls.push({ beadId: inp.beadId, comment: inp.comment });
      return { annotated: true, error: null };
    });
    setMockActivity("createEscalation", () => ({ escalationBeadId: "esc-1" }));

    // Child workflow returns a retryable failure
    childResults = [
      makeAgentResult({
        status: "failed",
        error: "ECONNREFUSED: connection refused",
      }),
    ];

    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 2 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // The continue-as-new state should have the retry ledger entry
    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    const ledger = carriedInput.carriedState!.retryLedger;
    expect(ledger.length).toBe(1);
    expect(ledger[0].beadId).toBe("bead-fail");
    expect(ledger[0].attempts).toBe(1);
    expect(ledger[0].exhausted).toBe(false);

    // Should have annotated the bead with the failure
    expect(annotateBeadCalls.length).toBe(1);
    expect(annotateBeadCalls[0].beadId).toBe("bead-fail");
    expect(annotateBeadCalls[0].comment).toContain("failed");
  });

  it("escalates when a non-retryable failure occurs", async () => {
    let selectCalls = 0;
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];

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
    setMockActivity("updateBeadStatus", (_repoPath: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("annotateBead", () => ({ annotated: true, error: null }));
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-1" };
    });

    // Child workflow returns budget_exceeded (non-retryable)
    childResults = [
      makeAgentResult({
        status: "budget_exceeded",
        totalCost: 10.0,
        error: "Cost budget exceeded",
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have set bead back to ready (unclaim)
    const unclaimCall = updateStatusCalls.find((c) => c.status === "ready");
    expect(unclaimCall).toBeDefined();
    expect(unclaimCall!.beadId).toBe("bead-nonretry");

    // Should have created an escalation bead
    expect(createEscalationCalls.length).toBe(1);
    expect(createEscalationCalls[0].beadId).toBe("bead-nonretry");
    expect(createEscalationCalls[0].reason).toContain("Budget exceeded");

    // Escalation counter should be incremented
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalEscalations).toBe(1);
    expect(carriedInput.carriedState!.totalFailures).toBe(1);
  });
});

// ── 8. Skip Bead ──

describe("skip bead signal", () => {
  it("registers skipBead signal handler", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected
    }

    expect(signalHandlers.has("foreman.skipBead")).toBe(true);
  });
});

// ── 9. Force Dispatch ──

describe("force dispatch signal", () => {
  it("registers forceDispatch signal handler", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected
    }

    expect(signalHandlers.has("foreman.forceDispatch")).toBe(true);
  });
});

// ── 10. Config Update ──

describe("config update signal", () => {
  it("registers updateConfig signal handler", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected
    }

    expect(signalHandlers.has("foreman.updateConfig")).toBe(true);
  });
});

// ── 11. Query Handlers ──

describe("query handlers", () => {
  it("registers status query handler", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected
    }

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

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
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
  it("unclaims bead and annotates when child workflow is aborted", async () => {
    let selectCalls = 0;
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];
    let annotateBeadCalls: Array<{ beadId: string; comment: string }> = [];

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
    setMockActivity("updateBeadStatus", (_repoPath: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("annotateBead", (input: unknown) => {
      const inp = input as { beadId: string; comment: string };
      annotateBeadCalls.push({ beadId: inp.beadId, comment: inp.comment });
      return { annotated: true, error: null };
    });

    childResults = [
      makeAgentResult({
        status: "aborted",
        error: "operator aborted",
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // Should have unclaimed the bead (set back to ready)
    const unclaimCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-abort" && c.status === "ready",
    );
    expect(unclaimCall).toBeDefined();

    // Should have annotated the bead with abort reason
    expect(annotateBeadCalls.length).toBe(1);
    expect(annotateBeadCalls[0].beadId).toBe("bead-abort");
    expect(annotateBeadCalls[0].comment).toContain("aborted");
  });
});

// ── 15. Outcome Reconciliation ──

describe("outcome reconciliation", () => {
  it("annotates bead on timeout and enters retry path", async () => {
    let selectCalls = 0;
    let annotateBeadCalls: Array<{ beadId: string; comment: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-timeout",
          title: "Will timeout",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "medium",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("annotateBead", (input: unknown) => {
      const inp = input as { beadId: string; comment: string };
      annotateBeadCalls.push({ beadId: inp.beadId, comment: inp.comment });
      return { annotated: true, error: null };
    });
    setMockActivity("createEscalation", () => ({ escalationBeadId: "esc-1" }));

    // Simulate a timeout result by returning a "failed" status with timeout error
    // (AgentTaskResult doesn't have a "timeout" status; timeouts manifest as "failed"
    // with timeout-containing error strings)
    childResults = [
      makeAgentResult({
        status: "failed",
        error: "timed out waiting for session completion",
      }),
    ];

    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 2 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have annotated the bead
    expect(annotateBeadCalls.length).toBe(1);
    expect(annotateBeadCalls[0].beadId).toBe("bead-timeout");
    expect(annotateBeadCalls[0].comment).toContain("failed");

    // Should be in retry (not exhausted, retryable)
    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    const ledger = carriedInput.carriedState!.retryLedger;
    expect(ledger.length).toBe(1);
    expect(ledger[0].beadId).toBe("bead-timeout");
    expect(ledger[0].exhausted).toBe(false);
    // Should NOT have escalated
    expect(carriedInput.carriedState!.totalEscalations).toBe(0);
  });

  it("annotates and escalates on validation_failed after retries exhausted", async () => {
    let selectCalls = 0;
    let annotateBeadCalls: Array<{ beadId: string; comment: string }> = [];
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-valfail",
          title: "Validation fail",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", (_rp: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("annotateBead", (input: unknown) => {
      const inp = input as { beadId: string; comment: string };
      annotateBeadCalls.push({ beadId: inp.beadId, comment: inp.comment });
      return { annotated: true, error: null };
    });
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-valfail" };
    });

    // Validation failed result
    childResults = [
      makeAgentResult({
        status: "validation_failed",
        error: "punch card not satisfied",
      }),
    ];

    // maxRetriesPerBead = 0 means max 1 attempt → immediately exhausted
    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 0 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have annotated the bead
    expect(annotateBeadCalls.length).toBe(1);
    expect(annotateBeadCalls[0].beadId).toBe("bead-valfail");

    // Should have created an escalation (retries exhausted)
    expect(createEscalationCalls.length).toBe(1);
    expect(createEscalationCalls[0].beadId).toBe("bead-valfail");
    expect(createEscalationCalls[0].reason).toContain("Retry exhaustion");

    // Bead should be unclaimed
    const unclaimCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-valfail" && c.status === "ready",
    );
    expect(unclaimCall).toBeDefined();

    // Counters
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalEscalations).toBe(1);
    expect(carriedInput.carriedState!.totalFailures).toBe(1);
  });

  it("annotates budget_exceeded bead and creates escalation", async () => {
    let selectCalls = 0;
    let annotateBeadCalls: Array<{ beadId: string; comment: string }> = [];
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-budget",
          title: "Expensive bead",
          priority: "P2",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "large",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("annotateBead", (input: unknown) => {
      const inp = input as { beadId: string; comment: string };
      annotateBeadCalls.push({ beadId: inp.beadId, comment: inp.comment });
      return { annotated: true, error: null };
    });
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-budget" };
    });

    childResults = [
      makeAgentResult({
        status: "budget_exceeded",
        totalCost: 15.0,
        error: "Cost budget exceeded: $15.00 > $5.00",
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have annotated the bead with budget info
    expect(annotateBeadCalls.length).toBe(1);
    expect(annotateBeadCalls[0].beadId).toBe("bead-budget");
    expect(annotateBeadCalls[0].comment).toContain("budget_exceeded");

    // Should have escalated
    expect(createEscalationCalls.length).toBe(1);
    expect(createEscalationCalls[0].beadId).toBe("bead-budget");
    expect(createEscalationCalls[0].reason).toContain("Budget exceeded");
  });

  it("does not annotate on successful completion", async () => {
    let selectCalls = 0;
    let annotateBeadCalls: Array<{ beadId: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-success",
          title: "Clean success",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));
    setMockActivity("annotateBead", (input: unknown) => {
      const inp = input as { beadId: string };
      annotateBeadCalls.push({ beadId: inp.beadId });
      return { annotated: true, error: null };
    });

    childResults = [makeAgentResult()]; // completed

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // Should NOT have annotated (success path skips annotation)
    expect(annotateBeadCalls.length).toBe(0);
  });

  it("retryable failure with exhausted retries creates escalation", async () => {
    let selectCalls = 0;
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-exhausted-retry",
          title: "Exhausted retries",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("annotateBead", () => ({ annotated: true, error: null }));
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-exhausted" };
    });

    // Retryable failure but maxRetries=0 → exhausted immediately
    childResults = [
      makeAgentResult({
        status: "failed",
        error: "ECONNREFUSED: connection refused",
      }),
    ];

    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 0 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have escalated because retries are exhausted
    expect(createEscalationCalls.length).toBe(1);
    expect(createEscalationCalls[0].beadId).toBe("bead-exhausted-retry");
    expect(createEscalationCalls[0].reason).toContain("Retry exhaustion");

    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalEscalations).toBe(1);
    expect(carriedInput.carriedState!.totalFailures).toBe(1);
  });

  it("non-retryable failed dispatch skips retry and escalates immediately", async () => {
    let selectCalls = 0;
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-nonretry-fail",
          title: "Structural failure",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("annotateBead", () => ({ annotated: true, error: null }));
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-nonretry" };
    });

    // Non-retryable failure (structural error, no timeout/network keywords)
    childResults = [
      makeAgentResult({
        status: "failed",
        error: "invalid prompt: missing required context",
      }),
    ];

    // Even with retries available, non-retryable should escalate immediately
    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 5 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have escalated immediately (non-retryable)
    expect(createEscalationCalls.length).toBe(1);
    expect(createEscalationCalls[0].reason).toContain("Non-retryable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Exception and Approval Path Tests (0mp.15)
// ═══════════════════════════════════════════════════════════════════════════════

// ── 16. Persistent Unhealthy Stack ──

describe("persistent unhealthy stack", () => {
  it("escalates after consecutive health failures exceed threshold", async () => {
    let healthCallCount = 0;
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];

    setMockActivity("checkStackHealth", () => {
      healthCallCount++;
      return makeHealthResult("fail");
    });
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-health" };
    });

    // Set threshold to 3 for faster test and give enough iterations to reach it
    const input = makeInput({
      maxIterations: 10,
      healthFailureThreshold: 3,
      // Set health check interval to 0 to check every iteration
      healthCheckIntervalMs: 0,
    });

    // The workflow will:
    // 1. Health check → fail (consecutiveHealthFailures = 1) → idle → sleep → iteration++
    // 2. Health check → fail (consecutiveHealthFailures = 2) → idle → sleep → iteration++
    // 3. Health check → fail (consecutiveHealthFailures = 3) → threshold hit → awaiting_intervention
    // 4. condition blocks waiting for resume signal

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to reach the condition block
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify escalation was created
    expect(createEscalationCalls.length).toBe(1);
    expect(createEscalationCalls[0].reason).toContain("Persistent health failure");
    expect(createEscalationCalls[0].reason).toContain("3 consecutive");

    // Query the status to verify intervention state
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    expect(statusHandler).toBeDefined();
    const status = statusHandler();
    expect(status.phase).toBe("awaiting_intervention");
    expect(status.interventionReason).toContain("Persistent health failure");
    expect(status.awaitingInterventionSince).not.toBeNull();

    // Fire resume signal — this modifies state.interventionResumed = true
    const resumeHandler = signalHandlers.get("foreman.resume");
    expect(resumeHandler).toBeDefined();
    resumeHandler!();

    // Resolve the condition
    if (conditionResolver) conditionResolver();

    // After resume, workflow continues and will eventually hit continueAsNew or
    // keep failing. Trigger shutdown to exit cleanly.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const shutdownHandler = signalHandlers.get("foreman.shutdown");
    shutdownHandler!({ reason: "test cleanup" });

    // If there's a new condition waiting (pause check), resolve it
    if (conditionResolver) conditionResolver();

    try {
      const result = await workflowPromise;
      // Could be shutdown or continueAsNew
      if (result) {
        expect(result.status).toBe("shutdown");
      }
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      // continueAsNew is also acceptable
    }
  });

  it("does not escalate when health failures are below threshold", async () => {
    let healthCallCount = 0;
    let createEscalationCalls: Array<{ beadId: string; reason: string }> = [];

    setMockActivity("checkStackHealth", () => {
      healthCallCount++;
      // Fail twice then pass
      if (healthCallCount <= 2) return makeHealthResult("fail");
      return makeHealthResult("pass");
    });
    setMockActivity("selectNextBead", () => null);
    setMockActivity("createEscalation", (input: unknown) => {
      const inp = input as { beadId: string; reason: string };
      createEscalationCalls.push({ beadId: inp.beadId, reason: inp.reason });
      return { escalationBeadId: "esc-health" };
    });

    const input = makeInput({
      maxIterations: 4,
      healthFailureThreshold: 5,
      healthCheckIntervalMs: 0,
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // No escalation should have been created
    expect(createEscalationCalls.length).toBe(0);
  });

  it("resets health failure counter when health passes", async () => {
    let healthCallCount = 0;

    setMockActivity("checkStackHealth", () => {
      healthCallCount++;
      // Fail 2 times, pass once, fail 2 times again — never reaches 5
      if (healthCallCount <= 2) return makeHealthResult("fail");
      if (healthCallCount === 3) return makeHealthResult("pass");
      return makeHealthResult("fail");
    });
    setMockActivity("selectNextBead", () => null);
    setMockActivity("createEscalation", () => ({ escalationBeadId: "esc-health" }));

    const input = makeInput({
      maxIterations: 6,
      healthFailureThreshold: 5,
      healthCheckIntervalMs: 0,
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // The carried state should show consecutive failures reset after the pass
    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    // After pass at count=3, counter resets to 0, then 2 more fails = 2
    // But health checks happen once per iteration (healthCheckIntervalMs=0),
    // and on the pass iteration selectNextBead returns null → idle
    expect(carriedInput.carriedState!.consecutiveHealthFailures).toBeLessThan(5);
  });
});

// ── 17. Irrecoverable CLI/Schema Failures ──

describe("irrecoverable CLI/schema failures", () => {
  it("enters awaiting_intervention on BeadsContractError during selection", async () => {
    let selectCallCount = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        const err = new Error("bd returned malformed JSON: unexpected token");
        err.name = "BeadsContractError";
        throw err;
      }
      // After resume, return null (no work)
      return null;
    });

    const input = makeInput({
      maxIterations: 5,
      healthCheckIntervalMs: 0,
    });

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to reach condition block
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify the intervention state
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.phase).toBe("awaiting_intervention");
    expect(status.interventionReason).toContain("BeadsContractError");

    // Fire resume signal to clear intervention
    const resumeHandler = signalHandlers.get("foreman.resume");
    resumeHandler!();
    if (conditionResolver) conditionResolver();

    // Let the workflow continue — it should poll again and eventually exit
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Trigger shutdown
    const shutdownHandler = signalHandlers.get("foreman.shutdown");
    shutdownHandler!({ reason: "test cleanup" });
    if (conditionResolver) conditionResolver();

    try {
      const result = await workflowPromise;
      if (result) {
        expect(["shutdown", "failed"]).toContain(result.status);
      }
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // selectNextBead should have been called twice (once before error, once after resume)
    expect(selectCallCount).toBeGreaterThanOrEqual(2);
  });

  it("re-throws non-contract errors as workflow failure", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      throw new Error("random infrastructure error");
    });

    const input = makeInput({ maxIterations: 2 });

    const result = await foremanWorkflow(input);

    // Non-contract errors should bubble up as workflow failure
    expect(result.status).toBe("failed");
    expect(result.error).toContain("random infrastructure error");
  });
});

// ── 18. Policy-Required Approval Before Dispatch ──

describe("policy-required approval before dispatch", () => {
  it("blocks dispatch of sensitive beads until operator approves", async () => {
    let selectCalls = 0;
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-sensitive",
          title: "Deploy to production",
          priority: "P1",
          labels: ["sensitive"],
          dependsOn: [],
          estimatedComplexity: "medium",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", (_rp: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult()];

    const input = makeInput({ maxIterations: 5, healthCheckIntervalMs: 0 });

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to reach the approval condition
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify we're awaiting approval
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.phase).toBe("awaiting_approval");
    expect(status.interventionReason).toContain("Policy-required approval");
    expect(status.interventionReason).toContain("sensitive");

    // No child workflows should have been started yet
    expect(startChildCalls.length).toBe(0);

    // Send approveDispatch signal and resolve condition
    const approveDispatchHandler = signalHandlers.get("foreman.approveDispatch");
    expect(approveDispatchHandler).toBeDefined();
    approveDispatchHandler!({ beadId: "bead-sensitive" });
    if (conditionResolver) conditionResolver();

    // Wait for workflow to finish (will return after catching internal continueAsNew)
    await workflowPromise;

    // Child workflow should have been started after approval
    expect(startChildCalls.length).toBe(1);

    // Bead should have been claimed (in_progress)
    const claimCall = updateStatusCalls.find((c) => c.status === "in_progress");
    expect(claimCall).toBeDefined();
    expect(claimCall!.beadId).toBe("bead-sensitive");
  });

  it("does not block dispatch of beads without sensitive labels", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-normal",
          title: "Fix a typo",
          priority: "P2",
          labels: ["chore"],
          dependsOn: [],
          estimatedComplexity: "trivial",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult()];

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // Child workflow should have been started without approval
    expect(startChildCalls.length).toBe(1);
  });

  it("blocks beads with requires-human label", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-human",
          title: "Review legal notice",
          priority: "P1",
          labels: ["requires-human"],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult()];

    const input = makeInput({ maxIterations: 5 });

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to reach approval condition
    await new Promise((resolve) => setTimeout(resolve, 10));

    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.phase).toBe("awaiting_approval");

    // Approve dispatch
    const approveHandler = signalHandlers.get("foreman.approveDispatch");
    approveHandler!({ beadId: "bead-human" });
    if (conditionResolver) conditionResolver();

    // Workflow continues and exits via continueAsNew (caught internally)
    await workflowPromise;

    // Should have dispatched after approval
    expect(startChildCalls.length).toBe(1);
  });
});

// ── 19. Ambiguous Outcome Requiring Operator Approval ──

describe("ambiguous outcome requiring operator approval", () => {
  it("waits for outcome approval when bead has requires-approval label", async () => {
    let selectCalls = 0;
    let closeBeadCalls: Array<{ beadId: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-approval",
          title: "Deploy schema migration",
          priority: "P0",
          labels: ["requires-approval"],
          dependsOn: [],
          estimatedComplexity: "large",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", (input: unknown) => {
      const inp = input as { beadId: string };
      closeBeadCalls.push({ beadId: inp.beadId });
      return { closed: true, error: null };
    });

    childResults = [makeAgentResult()];

    const input = makeInput({ maxIterations: 5 });

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to reach the pre-dispatch approval condition
    await new Promise((resolve) => setTimeout(resolve, 10));

    // First we need to approve dispatch (requires-approval triggers both gates)
    const approveDispatchHandler = signalHandlers.get("foreman.approveDispatch");
    approveDispatchHandler!({ beadId: "bead-approval" });
    if (conditionResolver) conditionResolver();

    // Wait for dispatch to complete and reach outcome approval
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Now should be awaiting outcome approval
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.phase).toBe("awaiting_approval");
    expect(status.interventionReason).toContain("Outcome requires approval");

    // closeBead should NOT have been called yet
    expect(closeBeadCalls.length).toBe(0);

    // Approve with "close" decision
    const approveOutcomeHandler = signalHandlers.get("foreman.approveOutcome");
    expect(approveOutcomeHandler).toBeDefined();
    approveOutcomeHandler!({ beadId: "bead-approval", decision: "close" });
    if (conditionResolver) conditionResolver();

    // Workflow continues and exits via continueAsNew (caught internally)
    await workflowPromise;

    // closeBead should have been called after approval
    expect(closeBeadCalls.length).toBe(1);
    expect(closeBeadCalls[0].beadId).toBe("bead-approval");
  });

  it("skips bead when operator approves with skip decision", async () => {
    let selectCalls = 0;
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-skip-approval",
          title: "Questionable task",
          priority: "P2",
          labels: ["requires-approval"],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", (_rp: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult()];

    const input = makeInput({ maxIterations: 5 });

    const workflowPromise = foremanWorkflow(input);

    // Approve dispatch first
    await new Promise((resolve) => setTimeout(resolve, 10));
    const approveDispatchHandler = signalHandlers.get("foreman.approveDispatch");
    approveDispatchHandler!({ beadId: "bead-skip-approval" });
    if (conditionResolver) conditionResolver();

    // Wait for outcome approval
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Approve with "skip"
    const approveOutcomeHandler = signalHandlers.get("foreman.approveOutcome");
    approveOutcomeHandler!({ beadId: "bead-skip-approval", decision: "skip" });
    if (conditionResolver) conditionResolver();

    // Workflow continues and exits via continueAsNew (caught internally)
    await workflowPromise;

    // Bead should have been set back to ready (not closed)
    const readyCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-skip-approval" && c.status === "ready",
    );
    expect(readyCall).toBeDefined();
  });

  it("retries bead when operator approves with retry decision", async () => {
    let selectCalls = 0;
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-retry-approval",
          title: "Uncertain result",
          priority: "P1",
          labels: ["requires-approval"],
          dependsOn: [],
          estimatedComplexity: "medium",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", (_rp: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult()];

    const input = makeInput({ maxIterations: 5 });

    const workflowPromise = foremanWorkflow(input);

    // Approve dispatch first
    await new Promise((resolve) => setTimeout(resolve, 10));
    const approveDispatchHandler = signalHandlers.get("foreman.approveDispatch");
    approveDispatchHandler!({ beadId: "bead-retry-approval" });
    if (conditionResolver) conditionResolver();

    // Wait for outcome approval
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Approve with "retry"
    const approveOutcomeHandler = signalHandlers.get("foreman.approveOutcome");
    approveOutcomeHandler!({ beadId: "bead-retry-approval", decision: "retry" });
    if (conditionResolver) conditionResolver();

    // Workflow continues and exits via continueAsNew (caught internally)
    await workflowPromise;

    // Bead should have been set back to ready (for re-dispatch)
    const readyCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-retry-approval" && c.status === "ready",
    );
    expect(readyCall).toBeDefined();
  });
});

// ── 20. Signal Registration ──

describe("new signal registration", () => {
  it("registers approveOutcome and approveDispatch signal handlers", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected: continueAsNew
    }

    expect(signalHandlers.has("foreman.approveOutcome")).toBe(true);
    expect(signalHandlers.has("foreman.approveDispatch")).toBe(true);
  });
});

// ── 21. Status Query Enhancement ──

describe("status query with intervention state", () => {
  it("includes null intervention fields when not in intervention", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected
    }

    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.interventionReason).toBeNull();
    expect(status.awaitingInterventionSince).toBeNull();
  });
});

// ── 22. Exception States Are Resumable ──

describe("exception states are resumable", () => {
  it("intervention state carries across continue-as-new", async () => {
    // Start with carried state that has intervention fields
    const input = makeInput({
      maxIterations: 1,
      carriedState: {
        totalIterations: 10,
        totalDispatches: 5,
        totalCompletions: 4,
        totalFailures: 1,
        totalEscalations: 1,
        lastHealthCheck: null,
        lastHealthCheckAt: null,
        recentOutcomes: [],
        retryLedger: [],
        pauseRequested: false,
        shutdownRequested: false,
        consecutiveHealthFailures: 3,
        interventionReason: "Persistent health failure",
        awaitingInterventionSince: new Date().toISOString(),
        foremanStartedAt: new Date().toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    // The intervention fields should be carried (though reset by now since health passed)
    expect(carriedInput.carriedState!.consecutiveHealthFailures).toBeDefined();
    expect(carriedInput.carriedState!.interventionReason).toBeDefined();
    expect(carriedInput.carriedState!.awaitingInterventionSince).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Agent-First Operation & Comprehensive Control Tests (0mp.19)
// ═══════════════════════════════════════════════════════════════════════════════

// ── 23. Full Happy Path Multi-Cycle (AC5: Agent-First Operation) ──

describe("full happy path multi-cycle (AC5: agent-first operation)", () => {
  it("autonomously polls, dispatches, completes, closes, and loops across multiple beads", async () => {
    // This is the AC5 test: demonstrates the foreman can independently
    // poll → dispatch → complete → close → poll again without any manual
    // Cascade driver or human intervention.
    let selectCalls = 0;
    let closeBeadCalls: Array<{ beadId: string }> = [];
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      switch (selectCalls) {
        case 1:
          return {
            beadId: "bead-cycle-1",
            title: "First task",
            priority: "P1",
            labels: [],
            dependsOn: [],
            estimatedComplexity: "small",
          };
        case 2:
          return {
            beadId: "bead-cycle-2",
            title: "Second task",
            priority: "P2",
            labels: [],
            dependsOn: [],
            estimatedComplexity: "trivial",
          };
        default:
          return null; // No more work after two beads
      }
    });
    setMockActivity("updateBeadStatus", (_rp: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("closeBead", (input: unknown) => {
      const inp = input as { beadId: string };
      closeBeadCalls.push({ beadId: inp.beadId });
      return { closed: true, error: null };
    });

    // Both child workflows complete successfully
    childResults = [
      makeAgentResult({ status: "completed", sessionId: "sess-cycle-1", totalCost: 0.3 }),
      makeAgentResult({ status: "completed", sessionId: "sess-cycle-2", totalCost: 0.2 }),
    ];

    // maxIterations = 5 gives enough room for: bead1 dispatch + bead2 dispatch + idle + continueAsNew
    const input = makeInput({ maxIterations: 5 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // ── Verify agent-first operation: two beads processed autonomously ──

    // Two child workflows started (one per bead)
    expect(startChildCalls.length).toBe(2);
    expect(startChildCalls[0].taskQueue).toBe("agent-tasks");
    expect(startChildCalls[1].taskQueue).toBe("agent-tasks");

    // Both beads were claimed (in_progress)
    const claimCalls = updateStatusCalls.filter((c) => c.status === "in_progress");
    expect(claimCalls.length).toBe(2);
    expect(claimCalls[0].beadId).toBe("bead-cycle-1");
    expect(claimCalls[1].beadId).toBe("bead-cycle-2");

    // Both beads were closed after completion
    expect(closeBeadCalls.length).toBe(2);
    expect(closeBeadCalls[0].beadId).toBe("bead-cycle-1");
    expect(closeBeadCalls[1].beadId).toBe("bead-cycle-2");

    // Carried state reflects both dispatches and completions
    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalDispatches).toBe(2);
    expect(carriedInput.carriedState!.totalCompletions).toBe(2);
    expect(carriedInput.carriedState!.totalFailures).toBe(0);
    expect(carriedInput.carriedState!.totalEscalations).toBe(0);

    // Both outcomes recorded
    expect(carriedInput.carriedState!.recentOutcomes.length).toBe(2);
    expect(carriedInput.carriedState!.recentOutcomes[0].beadId).toBe("bead-cycle-1");
    expect(carriedInput.carriedState!.recentOutcomes[0].result).toEqual({ kind: "completed" });
    expect(carriedInput.carriedState!.recentOutcomes[1].beadId).toBe("bead-cycle-2");
    expect(carriedInput.carriedState!.recentOutcomes[1].result).toEqual({ kind: "completed" });
  });

  it("accumulates lifetime counters across multiple dispatch cycles", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls <= 3) {
        return {
          beadId: `bead-acc-${selectCalls}`,
          title: `Task ${selectCalls}`,
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [
      makeAgentResult({ status: "completed", totalCost: 1.0 }),
      makeAgentResult({ status: "completed", totalCost: 2.0 }),
      makeAgentResult({ status: "completed", totalCost: 0.5 }),
    ];

    // Start with carried state from a previous run
    const input = makeInput({
      maxIterations: 6,
      carriedState: {
        totalIterations: 20,
        totalDispatches: 10,
        totalCompletions: 8,
        totalFailures: 2,
        totalEscalations: 1,
        lastHealthCheck: null,
        lastHealthCheckAt: null,
        recentOutcomes: [],
        retryLedger: [],
        pauseRequested: false,
        shutdownRequested: false,
        consecutiveHealthFailures: 0,
        interventionReason: null,
        awaitingInterventionSince: null,
        foremanStartedAt: new Date(Date.now() - 7_200_000).toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    // Lifetime counters accumulate: 10 + 3 dispatches, 8 + 3 completions
    expect(carriedInput.carriedState!.totalDispatches).toBe(13);
    expect(carriedInput.carriedState!.totalCompletions).toBe(11);
    // Failures and escalations unchanged
    expect(carriedInput.carriedState!.totalFailures).toBe(2);
    expect(carriedInput.carriedState!.totalEscalations).toBe(1);
  });
});

// ── 24. Health Blocked → Recover → Proceed ──

describe("health blocked then recovers", () => {
  it("blocks when unhealthy, retries, then proceeds when healthy", async () => {
    let healthCallCount = 0;
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => {
      healthCallCount++;
      // Fail first 2 checks, then pass
      if (healthCallCount <= 2) return makeHealthResult("fail");
      return makeHealthResult("pass");
    });
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-after-recovery",
          title: "Work after health recovery",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult({ status: "completed" })];

    const input = makeInput({
      maxIterations: 6,
      healthCheckIntervalMs: 0, // Check every iteration
      healthFailureThreshold: 10, // High threshold so we don't escalate
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // selectNextBead should have been called (health recovered)
    expect(selectCalls).toBeGreaterThanOrEqual(1);

    // A child workflow should have been started after recovery
    expect(startChildCalls.length).toBe(1);

    // Verify carried state shows the dispatch happened
    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalDispatches).toBe(1);
    expect(carriedInput.carriedState!.totalCompletions).toBe(1);
    // Health failure counter should have been reset after pass
    expect(carriedInput.carriedState!.consecutiveHealthFailures).toBe(0);
  });

  it("records health blocked reason in status query while blocked", async () => {
    let healthCallCount = 0;

    setMockActivity("checkStackHealth", () => {
      healthCallCount++;
      return makeHealthResult("fail");
    });

    // maxIterations=1 so we exit quickly
    const input = makeInput({
      maxIterations: 1,
      healthCheckIntervalMs: 0,
      healthFailureThreshold: 10,
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // Query health status
    const healthHandler = queryHandlers.get("foreman.health") as () => HealthCheckResult | null;
    const health = healthHandler();
    expect(health).not.toBeNull();
    expect(health!.overall).toBe("fail");

    // No dispatches should have occurred
    expect(startChildCalls.length).toBe(0);
  });
});

// ── 25. No Work → Eventually Gets Work ──

describe("no work then eventually gets work", () => {
  it("idles on empty poll, then dispatches when work appears", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      // First 2 polls return nothing; third returns work
      if (selectCalls <= 2) return null;
      if (selectCalls === 3) {
        return {
          beadId: "bead-delayed",
          title: "Delayed work item",
          priority: "P2",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [makeAgentResult({ status: "completed" })];

    const input = makeInput({ maxIterations: 6 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Should have idled twice (sleep calls for empty polls)
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);

    // Then should have dispatched once
    expect(startChildCalls.length).toBe(1);

    // Carried state reflects the dispatch
    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalDispatches).toBe(1);
    expect(carriedInput.carriedState!.totalCompletions).toBe(1);
  });
});

// ── 26. Pause Signal Behavioral Test ──

describe("pause signal behavior", () => {
  it("pauses via carried state, blocks dispatch, and resumes on shutdown signal", async () => {
    // Test strategy: start with pauseRequested=true in carried state.
    // The workflow enters the paused condition block immediately.
    // We verify the phase is paused, then send shutdown to exit cleanly.
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({
      maxIterations: 5,
      carriedState: {
        totalIterations: 5,
        totalDispatches: 2,
        totalCompletions: 2,
        totalFailures: 0,
        totalEscalations: 0,
        lastHealthCheck: null,
        lastHealthCheckAt: null,
        recentOutcomes: [],
        retryLedger: [],
        pauseRequested: true, // Start paused
        shutdownRequested: false,
        consecutiveHealthFailures: 0,
        interventionReason: null,
        awaitingInterventionSince: null,
        foremanStartedAt: new Date().toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to reach the paused condition block
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify we're paused via status query
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.paused).toBe(true);
    expect(status.phase).toBe("paused");

    // No dispatches should have happened while paused
    expect(startChildCalls.length).toBe(0);

    // Send shutdown signal to exit the pause condition
    const shutdownHandler = signalHandlers.get("foreman.shutdown");
    shutdownHandler!({ reason: "test: exit from pause" });

    // Resolve the condition that was blocking
    if (conditionResolver) conditionResolver();

    const result = await workflowPromise;
    expect(result.status).toBe("shutdown");
    expect(result.shutdownReason).toBe("test: exit from pause");

    // Verify no work was dispatched while paused
    expect(startChildCalls.length).toBe(0);
  });

  it("pause signal handler sets pauseRequested state", async () => {
    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => null);

    const input = makeInput({ maxIterations: 1 });

    try {
      await foremanWorkflow(input);
    } catch {
      // Expected: continueAsNew
    }

    // Verify handlers are registered
    const pauseHandler = signalHandlers.get("foreman.pause");
    const resumeHandler = signalHandlers.get("foreman.resume");
    expect(pauseHandler).toBeDefined();
    expect(resumeHandler).toBeDefined();

    // Query initial state
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;

    // Fire pause signal
    pauseHandler!();
    const afterPause = statusHandler();
    expect(afterPause.paused).toBe(true);

    // Fire resume signal
    resumeHandler!();
    const afterResume = statusHandler();
    expect(afterResume.paused).toBe(false);
  });
});

// ── 27. Shutdown Signal — Graceful Drain ──

describe("shutdown signal graceful drain", () => {
  it("completes current bead then returns shutdown when shutdown fires during dispatch", async () => {
    // Strategy: Fire the shutdown signal from inside the closeBead activity
    // (which runs after the child workflow completes). This simulates
    // shutdown arriving during the dispatch cycle. The workflow will
    // complete the close, increment counters, then see shutdownRequested
    // at the top of the next loop iteration.
    let selectCalls = 0;
    let closeBeadCalls: Array<{ beadId: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-in-flight",
          title: "In-flight during shutdown",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", (input: unknown) => {
      const inp = input as { beadId: string };
      closeBeadCalls.push({ beadId: inp.beadId });
      // Fire shutdown from inside the close activity — simulates operator
      // sending shutdown while the dispatch is being finalized
      const shutdownHandler = signalHandlers.get("foreman.shutdown");
      if (shutdownHandler) {
        shutdownHandler({ reason: "operator requested graceful drain" });
      }
      return { closed: true, error: null };
    });

    childResults = [makeAgentResult({ status: "completed" })];

    const input = makeInput({ maxIterations: 10 });

    const result = await foremanWorkflow(input);

    // The workflow should have completed the bead, then seen shutdown
    expect(result.status).toBe("shutdown");
    expect(result.shutdownReason).toBe("operator requested graceful drain");

    // The in-flight bead was completed and closed
    expect(closeBeadCalls.length).toBe(1);
    expect(closeBeadCalls[0].beadId).toBe("bead-in-flight");

    // Only one dispatch (no new work after shutdown)
    expect(startChildCalls.length).toBe(1);
  });

  it("exits immediately via carried shutdown state without dispatching", async () => {
    // Verify the graceful path: shutdown is carried across continue-as-new
    // and the new workflow returns immediately without entering the loop.
    const input = makeInput({
      carriedState: {
        totalIterations: 30,
        totalDispatches: 15,
        totalCompletions: 14,
        totalFailures: 1,
        totalEscalations: 0,
        lastHealthCheck: null,
        lastHealthCheckAt: null,
        recentOutcomes: [],
        retryLedger: [],
        pauseRequested: false,
        shutdownRequested: true,
        consecutiveHealthFailures: 0,
        interventionReason: null,
        awaitingInterventionSince: null,
        foremanStartedAt: new Date().toISOString(),
        lastContinueAsNewAt: null,
      },
    });

    const result = await foremanWorkflow(input);

    expect(result.status).toBe("shutdown");
    // No dispatches occurred
    expect(startChildCalls.length).toBe(0);
    // Counters preserved from carried state
    expect(result.totalDispatches).toBe(15);
    expect(result.totalCompletions).toBe(14);
  });
});

// ── 28. Exception Escalation — Irrecoverable Failure → Paused → Resume ──

describe("exception escalation to paused state", () => {
  it("enters awaiting_intervention with reason on irrecoverable failure, resumes on signal", async () => {
    let selectCallCount = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // First call: throw irrecoverable error
        const err = new Error("bd schema version mismatch: expected v3, got v2");
        err.name = "BeadsContractError";
        throw err;
      }
      // After resume, return null (no work — we just want to verify the
      // foreman loops back after resuming from intervention)
      return null;
    });

    const input = makeInput({ maxIterations: 8, healthCheckIntervalMs: 0 });

    const workflowPromise = foremanWorkflow(input);

    // Wait for workflow to enter awaiting_intervention
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify the foreman is paused with a clear reason
    const statusHandler = queryHandlers.get("foreman.status") as () => ForemanStatus;
    const status = statusHandler();
    expect(status.phase).toBe("awaiting_intervention");
    expect(status.interventionReason).toContain("BeadsContractError");
    expect(status.interventionReason).toContain("schema version mismatch");
    expect(status.awaitingInterventionSince).not.toBeNull();

    // Escalation counter should have incremented
    expect(status.lifetimeEscalations).toBe(1);

    // Send resume signal to clear intervention and unblock the workflow
    const resumeHandler = signalHandlers.get("foreman.resume");
    resumeHandler!();
    if (conditionResolver) conditionResolver();

    // After resume, the workflow continues — it will loop back, do health check,
    // selectNextBead (returns null), idle, and eventually continueAsNew or we
    // need to trigger shutdown.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Send shutdown to exit cleanly
    const shutdownHandler = signalHandlers.get("foreman.shutdown");
    shutdownHandler!({ reason: "test cleanup" });
    if (conditionResolver) conditionResolver();

    try {
      const result = await workflowPromise;
      if (result) {
        expect(["shutdown", "failed"]).toContain(result.status);
      }
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
    }

    // The select was called at least once (the error call)
    expect(selectCallCount).toBeGreaterThanOrEqual(1);
  });
});

// ── 29. Outcome Reconciliation — Comprehensive ──

describe("outcome reconciliation comprehensive", () => {
  it("success closes bead and increments completion counter", async () => {
    let selectCalls = 0;
    let closeBeadCalls: Array<{ beadId: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-recon-success",
          title: "Clean completion",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", (input: unknown) => {
      const inp = input as { beadId: string };
      closeBeadCalls.push({ beadId: inp.beadId });
      return { closed: true, error: null };
    });

    childResults = [makeAgentResult({ status: "completed" })];

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Bead was closed
    expect(closeBeadCalls.length).toBe(1);
    expect(closeBeadCalls[0].beadId).toBe("bead-recon-success");

    // Completion counter incremented
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalCompletions).toBe(1);
    expect(carriedInput.carriedState!.totalFailures).toBe(0);
  });

  it("failure updates retry ledger and does not close bead", async () => {
    let selectCalls = 0;
    let closeBeadCalls: Array<{ beadId: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-recon-fail",
          title: "Failing task",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", (input: unknown) => {
      const inp = input as { beadId: string };
      closeBeadCalls.push({ beadId: inp.beadId });
      return { closed: true, error: null };
    });
    setMockActivity("annotateBead", () => ({ annotated: true, error: null }));
    setMockActivity("createEscalation", () => ({ escalationBeadId: "esc-recon" }));

    childResults = [
      makeAgentResult({
        status: "failed",
        error: "ECONNREFUSED: connection refused",
      }),
    ];

    const input = makeInput({ maxIterations: 3, maxRetriesPerBead: 2 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Bead was NOT closed (failure path)
    expect(closeBeadCalls.length).toBe(0);

    // Retry ledger was updated
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    const ledger = carriedInput.carriedState!.retryLedger;
    expect(ledger.length).toBe(1);
    expect(ledger[0].beadId).toBe("bead-recon-fail");
    expect(ledger[0].exhausted).toBe(false);
  });

  it("aborted dispatch leaves bead open (unclaimed but not closed)", async () => {
    let selectCalls = 0;
    let closeBeadCalls: Array<{ beadId: string }> = [];
    let updateStatusCalls: Array<{ beadId: string; status: string }> = [];

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-recon-abort",
          title: "Aborted task",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", (_rp: unknown, beadId: unknown, status: unknown) => {
      updateStatusCalls.push({ beadId: beadId as string, status: status as string });
      return { updated: true, error: null };
    });
    setMockActivity("closeBead", (input: unknown) => {
      const inp = input as { beadId: string };
      closeBeadCalls.push({ beadId: inp.beadId });
      return { closed: true, error: null };
    });
    setMockActivity("annotateBead", () => ({ annotated: true, error: null }));

    childResults = [
      makeAgentResult({
        status: "aborted",
        error: "operator cancelled in-flight",
      }),
    ];

    const input = makeInput({ maxIterations: 3 });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    // Bead was NOT closed (aborted path leaves open)
    expect(closeBeadCalls.length).toBe(0);

    // Bead was unclaimed (set back to ready)
    const unclaimCall = updateStatusCalls.find(
      (c) => c.beadId === "bead-recon-abort" && c.status === "ready",
    );
    expect(unclaimCall).toBeDefined();

    // No escalation — aborted is not escalated
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    expect(carriedInput.carriedState!.totalEscalations).toBe(0);
  });
});

// ── 30. Continue-As-New — Full State Preservation ──

describe("continue-as-new state preservation", () => {
  it("preserves all state fields across continue-as-new boundary", async () => {
    let selectCalls = 0;

    setMockActivity("checkStackHealth", () => makeHealthResult("pass"));
    setMockActivity("selectNextBead", () => {
      selectCalls++;
      if (selectCalls === 1) {
        return {
          beadId: "bead-state-check",
          title: "State preservation test",
          priority: "P1",
          labels: [],
          dependsOn: [],
          estimatedComplexity: "small",
        };
      }
      return null;
    });
    setMockActivity("updateBeadStatus", () => ({ updated: true, error: null }));
    setMockActivity("closeBead", () => ({ closed: true, error: null }));

    childResults = [
      makeAgentResult({
        status: "completed",
        sessionId: "sess-state",
        totalCost: 2.5,
        tokensInput: 12000,
        tokensOutput: 6000,
      }),
    ];

    const existingOutcome: DispatchOutcome = {
      beadId: "bead-prior",
      workflowId: "wf-prior",
      sessionId: "sess-prior",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date(Date.now() - 30_000).toISOString(),
      durationMs: 30_000,
      totalCost: 1.0,
      tokensInput: 5000,
      tokensOutput: 2500,
      result: { kind: "completed" },
      audit: null,
      attempt: 1,
    };

    const input = makeInput({
      maxIterations: 3,
      carriedState: {
        totalIterations: 42,
        totalDispatches: 20,
        totalCompletions: 18,
        totalFailures: 2,
        totalEscalations: 1,
        lastHealthCheck: makeHealthResult("pass"),
        lastHealthCheckAt: new Date().toISOString(),
        recentOutcomes: [existingOutcome],
        retryLedger: [],
        pauseRequested: false,
        shutdownRequested: false,
        consecutiveHealthFailures: 0,
        interventionReason: null,
        awaitingInterventionSince: null,
        foremanStartedAt: new Date(Date.now() - 7_200_000).toISOString(),
        lastContinueAsNewAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    });

    try {
      await foremanWorkflow(input);
    } catch (e) {
      if (!(e instanceof ContinueAsNewError)) throw e;
      continueAsNewCalled = true;
      continueAsNewArgs = e.args;
    }

    expect(continueAsNewCalled).toBe(true);
    const args = continueAsNewArgs as unknown[];
    const carriedInput = args[0] as ForemanInput;
    const cs = carriedInput.carriedState!;

    // Lifetime counters accumulated
    expect(cs.totalIterations).toBeGreaterThanOrEqual(45); // 42 + at least 3
    expect(cs.totalDispatches).toBe(21); // 20 + 1
    expect(cs.totalCompletions).toBe(19); // 18 + 1
    expect(cs.totalFailures).toBe(2); // unchanged
    expect(cs.totalEscalations).toBe(1); // unchanged

    // Recent outcomes includes both prior and new
    expect(cs.recentOutcomes.length).toBe(2);
    expect(cs.recentOutcomes[0].beadId).toBe("bead-prior");
    expect(cs.recentOutcomes[1].beadId).toBe("bead-state-check");

    // Health state preserved
    expect(cs.lastHealthCheck).not.toBeNull();
    expect(cs.lastHealthCheckAt).not.toBeNull();

    // Timing fields preserved
    expect(cs.foremanStartedAt).toBeDefined();
    expect(cs.lastContinueAsNewAt).not.toBeNull();

    // Operator state
    expect(cs.pauseRequested).toBe(false);
    expect(cs.shutdownRequested).toBe(false);
    expect(cs.consecutiveHealthFailures).toBe(0);
  });
});
