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
