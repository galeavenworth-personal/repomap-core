/**
 * Molecule Dispatch E2E Integration Tests
 *
 * Proves the full closed loop: formula -> cook -> mol pour -> factory dispatch -> telemetry -> DSPy -> re-dispatch
 * Uses realistic mock data matching the actual decompose-epic.formula.json structure (4 steps).
 *
 * Tests exercise the orchestration logic with mocked external dependencies (bd CLI, kilo serve, Dolt).
 * The test structure would work end-to-end with live infrastructure by swapping in real deps.
 *
 * Coverage:
 *   1. Full pipeline: cook -> pour -> show -> dispatch with realistic formula data
 *   2. bead_id tagging flows through to dispatch config
 *   3. Parent-only steps (action:parent) are correctly skipped
 *   4. MoleculeDispatchResult has correct step counts
 *   5. Backward compatibility: raw prompt dispatch still works alongside molecule dispatch
 *   6. formula_id metadata plumbing for DSPy compiled prompt keying
 *   7. bd output normalization resilience
 *   8. Mode/card override from labels vs config defaults
 *   9. No-monitor mode with molecule dispatch
 */

import { describe, expect, it, vi } from "vitest";
import {
  type FactoryDispatchConfig,
  type MoleculeDispatchResult,
  runDispatch,
  ExitCode,
} from "../src/infra/factory-dispatch.js";
import {
  startHealthyStack,
  mockBdPipeline,
  mockSuccessfulDispatches,
  captureStdout,
  moleculeTestConfig,
  makeTestConfig,
} from "./helpers/factory-dispatch-helpers.js";

// ── Realistic formula data matching decompose-epic.formula.json ─────────

/**
 * Simulates the 4-step decompose-epic formula with realistic labels:
 *   1. discover  -> mode:architect, card:discover-phase
 *   2. explore   -> mode:architect, card:explore-phase
 *   3. prepare   -> mode:architect, card:prepare-phase
 *   4. mint-beads -> action:parent (should be SKIPPED by dispatcher)
 */
const DECOMPOSE_EPIC_STEPS = [
  {
    id: "repomap-core-mol-test.1",
    bead_id: "repomap-core-mol-test.1",
    title: "Discover epic scope",
    description:
      "Dispatch architect child to understand the full scope of epic repomap-core-638: read beads, gather strategic context, identify acceptance criteria, existing children, dependency context, and related architecture documents",
    labels: ["mode:architect", "card:discover-phase", "phase:1"],
  },
  {
    id: "repomap-core-mol-test.2",
    bead_id: "repomap-core-mol-test.2",
    title: "Explore codebase",
    description:
      "Dispatch architect child to perform deep structural and semantic analysis of the implementation surface for epic repomap-core-638: map relevant code architecture, existing patterns, test infrastructure, files to create or modify, and risk assessment",
    labels: ["mode:architect", "card:explore-phase", "phase:2"],
  },
  {
    id: "repomap-core-mol-test.3",
    bead_id: "repomap-core-mol-test.3",
    title: "Prepare subtask plan",
    description:
      "Dispatch architect child to design the subtask decomposition for epic repomap-core-638 via sequential thinking: output an ordered subtask list where each subtask has title, type, priority, description, files, verification, and sibling dependencies",
    labels: ["mode:architect", "card:prepare-phase", "phase:3"],
  },
  {
    id: "repomap-core-mol-test.4",
    bead_id: "repomap-core-mol-test.4",
    title: "Mint child beads",
    description:
      "Parent mints child beads from prepare output: bd create --parent repomap-core-638 for each subtask, wire sibling dependencies with bd dep add, verify graph with bd show repomap-core-638, export with bd export",
    labels: ["action:parent", "card:decompose-epic", "phase:4"],
  },
];

// ── E2E Integration Tests ───────────────────────────────────────────────

describe("MoleculeDispatch E2E Integration", () => {
  describe("full pipeline: cook -> pour -> show -> dispatch with decompose-epic formula", () => {
    it("exercises the complete molecule dispatch pipeline with 4-step formula", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "decompose-epic",
        vars: ["epic_id=repomap-core-638"],
        mode: "process-orchestrator",
        cardId: "",
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-decompose-638",
        moleculeId: "mol-decompose-638",
        steps: DECOMPOSE_EPIC_STEPS,
      });

      // Mock dispatch for each non-parent step (3 dispatches expected)
      let dispatchCallCount = 0;
      const runSingleDispatchFn = vi.fn().mockImplementation(async () => {
        dispatchCallCount++;
        return {
          code: ExitCode.SUCCESS,
          session_id: `sess-step-${dispatchCallCount}`,
          result: `Step ${dispatchCallCount} completed successfully`,
          elapsed_seconds: dispatchCallCount * 10,
        };
      });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        // --- Verify exit code ---
        expect(code).toBe(ExitCode.SUCCESS);

        // --- Verify bd CLI was called correctly ---
        expect(execBdFn).toHaveBeenCalledTimes(4);
        expect(execBdFn).toHaveBeenNthCalledWith(1, [
          "cook",
          "decompose-epic",
          "--var",
          "epic_id=repomap-core-638",
          "--json",
        ]);
        expect(execBdFn).toHaveBeenNthCalledWith(2, [
          "cook",
          "decompose-epic",
          "--persist",
          "--force",
          "--var",
          "epic_id=repomap-core-638",
          "--json",
        ]);
        expect(execBdFn).toHaveBeenNthCalledWith(3, [
          "mol",
          "pour",
          "proto-decompose-638",
          "--var",
          "epic_id=repomap-core-638",
          "--json",
        ]);
        expect(execBdFn).toHaveBeenNthCalledWith(4, [
          "mol",
          "show",
          "mol-decompose-638",
          "--json",
        ]);

        // --- Verify dispatch was called 3 times (4 steps - 1 parent = 3) ---
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(3);

        // --- Verify MoleculeDispatchResult ---
        const output = stdout.json();
        expect(output.molecule_id).toBe("mol-decompose-638");
        expect(output.formula).toBe("decompose-epic");
        expect(output.total_steps).toBe(4);
        expect(output.dispatched_steps).toBe(3);
        expect(output.skipped_steps).toBe(1);
        expect(output.failed_steps).toBe(0);
        expect(output.steps).toHaveLength(4);

        // --- Verify each step's status and details ---
        const discoverStep = output.steps.find((s) => s.step_id === "repomap-core-mol-test.1");
        expect(discoverStep).toMatchObject({
          step_id: "repomap-core-mol-test.1",
          bead_id: "repomap-core-mol-test.1",
          mode: "architect",
          card: "discover-phase",
          status: "completed",
          session_id: "sess-step-1",
        });

        const exploreStep = output.steps.find((s) => s.step_id === "repomap-core-mol-test.2");
        expect(exploreStep).toMatchObject({
          step_id: "repomap-core-mol-test.2",
          bead_id: "repomap-core-mol-test.2",
          mode: "architect",
          card: "explore-phase",
          status: "completed",
          session_id: "sess-step-2",
        });

        const prepareStep = output.steps.find((s) => s.step_id === "repomap-core-mol-test.3");
        expect(prepareStep).toMatchObject({
          step_id: "repomap-core-mol-test.3",
          bead_id: "repomap-core-mol-test.3",
          mode: "architect",
          card: "prepare-phase",
          status: "completed",
          session_id: "sess-step-3",
        });

        const mintStep = output.steps.find((s) => s.step_id === "repomap-core-mol-test.4");
        expect(mintStep).toMatchObject({
          step_id: "repomap-core-mol-test.4",
          bead_id: "repomap-core-mol-test.4",
          mode: "process-orchestrator", // Falls back to config.mode since no mode: label
          card: "decompose-epic",
          status: "skipped",
        });
        expect(mintStep?.session_id).toBeUndefined();
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("verifies bead_id flows through to each step's dispatch config", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "decompose-epic",
        vars: ["epic_id=repomap-core-638"],
        mode: "process-orchestrator",
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-1",
        moleculeId: "mol-1",
        steps: DECOMPOSE_EPIC_STEPS,
      });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-bead-test",
        result: "done",
        elapsed_seconds: 1,
      });

      const stdout = captureStdout();

      try {
        await runDispatch(config, stack.mockFetch, { execBdFn, runSingleDispatchFn });

        // Each dispatched step should have beadId set in the config passed to runSingleDispatchFn
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(3);

        const expectedBeadIds = [
          "repomap-core-mol-test.1",
          "repomap-core-mol-test.2",
          "repomap-core-mol-test.3",
        ];

        for (let i = 0; i < 3; i++) {
          const callArgs = runSingleDispatchFn.mock.calls[i] as Array<{
            config: FactoryDispatchConfig;
          }>;
          expect(callArgs[0].config.beadId).toBe(expectedBeadIds[i]);
        }
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("verifies step descriptions from formula flow through as promptArg", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "decompose-epic",
        mode: "code",
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-1",
        moleculeId: "mol-1",
        steps: DECOMPOSE_EPIC_STEPS,
      });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-desc-test",
        result: "done",
        elapsed_seconds: 1,
      });

      const stdout = captureStdout();

      try {
        await runDispatch(config, stack.mockFetch, { execBdFn, runSingleDispatchFn });

        // Verify each step's description becomes the promptArg
        const calls = runSingleDispatchFn.mock.calls as Array<
          Array<{ config: FactoryDispatchConfig }>
        >;

        expect(calls[0][0].config.promptArg).toContain(
          "Dispatch architect child to understand the full scope",
        );
        expect(calls[1][0].config.promptArg).toContain(
          "Dispatch architect child to perform deep structural and semantic analysis",
        );
        expect(calls[2][0].config.promptArg).toContain(
          "Dispatch architect child to design the subtask decomposition",
        );
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("verifies step titles from formula flow through as config title", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "decompose-epic",
        mode: "code",
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-1",
        moleculeId: "mol-1",
        steps: DECOMPOSE_EPIC_STEPS,
      });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-title-test",
        result: "done",
        elapsed_seconds: 1,
      });

      const stdout = captureStdout();

      try {
        await runDispatch(config, stack.mockFetch, { execBdFn, runSingleDispatchFn });

        const calls = runSingleDispatchFn.mock.calls as Array<
          Array<{ config: FactoryDispatchConfig }>
        >;

        expect(calls[0][0].config.title).toBe("Discover epic scope");
        expect(calls[1][0].config.title).toBe("Explore codebase");
        expect(calls[2][0].config.title).toBe("Prepare subtask plan");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("parent-only step skipping", () => {
    it("skips all action:parent steps and dispatches the rest", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "mixed-formula",
        mode: "code",
      });

      // Formula with alternating parent and dispatch steps
      const execBdFn = mockBdPipeline({
        protoId: "proto-mixed",
        moleculeId: "mol-mixed",
        steps: [
          { id: "step-code-1", title: "Code step 1", description: "Write code", labels: ["mode:code", "card:execute-subtask"] },
          { id: "step-parent-1", title: "Parent orchestration", description: "Orchestrate children", labels: ["action:parent", "card:process-orchestrate"] },
          { id: "step-architect-1", title: "Architect step", description: "Design system", labels: ["mode:architect", "card:explore-phase"] },
          { id: "step-parent-2", title: "Another parent step", description: "More orchestration", labels: ["action:parent"] },
        ],
      });

      const runSingleDispatchFn = mockSuccessfulDispatches(2, "sess-skip");

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(2); // Only non-parent steps

        const output = stdout.json();
        expect(output.total_steps).toBe(4);
        expect(output.dispatched_steps).toBe(2);
        expect(output.skipped_steps).toBe(2);

        // Verify the dispatched steps have correct modes
        expect(output.steps.find((s) => s.step_id === "step-code-1")?.status).toBe("completed");
        expect(output.steps.find((s) => s.step_id === "step-code-1")?.mode).toBe("code");
        expect(output.steps.find((s) => s.step_id === "step-architect-1")?.status).toBe("completed");
        expect(output.steps.find((s) => s.step_id === "step-architect-1")?.mode).toBe("architect");

        // Verify parent steps are skipped
        expect(output.steps.find((s) => s.step_id === "step-parent-1")?.status).toBe("skipped");
        expect(output.steps.find((s) => s.step_id === "step-parent-2")?.status).toBe("skipped");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("MoleculeDispatchResult accuracy", () => {
    it("correctly tracks mixed outcomes: completed, failed, and skipped", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, { formula: "mixed-outcome" });

      const execBdFn = mockBdPipeline({
        protoId: "proto-mix",
        moleculeId: "mol-mix",
        steps: [
          { id: "step-ok", title: "Ok step", description: "P1", labels: ["mode:code"] },
          { id: "step-fail", title: "Fail step", description: "P2", labels: ["mode:code"] },
          { id: "step-parent", title: "Parent", description: "P3", labels: ["action:parent"] },
          { id: "step-ok2", title: "Ok2", description: "P4", labels: ["mode:architect"] },
        ],
      });

      const runSingleDispatchFn = vi
        .fn()
        .mockResolvedValueOnce({
          code: ExitCode.SUCCESS,
          session_id: "sess-ok",
          result: "first done",
          elapsed_seconds: 5,
        })
        .mockResolvedValueOnce(ExitCode.PROMPT_DISPATCH_FAILED)
        .mockResolvedValueOnce({
          code: ExitCode.SUCCESS,
          session_id: "sess-ok2",
          result: "third done",
          elapsed_seconds: 8,
        });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        // Any failed dispatched step should return GENERAL_ERROR
        expect(code).toBe(ExitCode.GENERAL_ERROR);

        const output = stdout.json();
        expect(output.total_steps).toBe(4);
        expect(output.dispatched_steps).toBe(2); // 2 successful
        expect(output.failed_steps).toBe(1);     // 1 failed
        expect(output.skipped_steps).toBe(1);     // 1 parent

        // Verify individual step statuses
        expect(output.steps.find((s) => s.step_id === "step-ok")?.status).toBe("completed");
        expect(output.steps.find((s) => s.step_id === "step-fail")?.status).toBe("failed");
        expect(output.steps.find((s) => s.step_id === "step-parent")?.status).toBe("skipped");
        expect(output.steps.find((s) => s.step_id === "step-ok2")?.status).toBe("completed");

        // Verify details on successful steps
        const okStep = output.steps.find((s) => s.step_id === "step-ok");
        expect(okStep?.session_id).toBe("sess-ok");
        expect(okStep?.elapsed_seconds).toBe(5);
        expect(okStep?.result).toBe("first done");

        // Verify error info on failed step
        const failStep = output.steps.find((s) => s.step_id === "step-fail");
        expect(failStep?.error).toContain("dispatch exit code");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("handles exception during step dispatch gracefully", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, { formula: "exception-test" });

      const execBdFn = mockBdPipeline({
        protoId: "proto-exc",
        moleculeId: "mol-exc",
        steps: [
          { id: "step-throw", title: "Throw step", description: "P1", labels: ["mode:code"] },
          { id: "step-ok", title: "Ok step", description: "P2", labels: ["mode:code"] },
        ],
      });

      const runSingleDispatchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network connection reset"))
        .mockResolvedValueOnce({
          code: ExitCode.SUCCESS,
          session_id: "sess-after-exc",
          result: "recovered",
          elapsed_seconds: 2,
        });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        // Any failed dispatched step should return GENERAL_ERROR
        expect(code).toBe(ExitCode.GENERAL_ERROR);

        const output = stdout.json();
        expect(output.failed_steps).toBe(1);
        expect(output.dispatched_steps).toBe(1);

        const throwStep = output.steps.find((s) => s.step_id === "step-throw");
        expect(throwStep?.status).toBe("failed");
        expect(throwStep?.error).toBe("Network connection reset");

        const okStep = output.steps.find((s) => s.step_id === "step-ok");
        expect(okStep?.status).toBe("completed");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("backward compatibility: raw prompt dispatch still works", () => {
    it("uses single-dispatch path when formula is empty", async () => {
      const stack = await startHealthyStack();
      const config = makeTestConfig({
        promptArg: "Run end-to-end diagnostic on the factory",
        mode: "code",
        formula: "",
        vars: [],
        doltPort: stack.doltPort,
        temporalPort: stack.temporalPort,
      });

      const execBdFn = vi.fn();
      const runSingleDispatchFn = vi.fn().mockResolvedValue(ExitCode.SUCCESS);

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        // bd CLI should NOT be called for raw prompt dispatch
        expect(execBdFn).not.toHaveBeenCalled();
        // Single dispatch should be called exactly once
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(1);

        const callArgs = runSingleDispatchFn.mock.calls[0] as Array<{
          config: FactoryDispatchConfig;
        }>;
        expect(callArgs[0].config.promptArg).toBe(
          "Run end-to-end diagnostic on the factory",
        );
        expect(callArgs[0].config.mode).toBe("code");
      } finally {
        await stack.cleanup();
      }
    });

    it("molecule and raw dispatch use the same runSingleDispatchFn interface", async () => {
      const stack = await startHealthyStack();

      // First: molecule dispatch
      const moleculeConfig = moleculeTestConfig(stack, { formula: "simple-formula" });

      const moleculeExecBd = mockBdPipeline({
        protoId: "proto-compat",
        moleculeId: "mol-compat",
        steps: [{ id: "step-1", title: "S1", description: "Do thing", labels: ["mode:code"] }],
      });

      const moleculeRunSingle = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-mol",
        result: "mol done",
        elapsed_seconds: 3,
      });

      const stdout = captureStdout();

      try {
        await runDispatch(moleculeConfig, stack.mockFetch, {
          execBdFn: moleculeExecBd,
          runSingleDispatchFn: moleculeRunSingle,
        });

        // Then: raw dispatch
        const rawConfig = makeTestConfig({
          promptArg: "raw prompt",
          formula: "",
          doltPort: stack.doltPort,
          temporalPort: stack.temporalPort,
        });

        const rawExecBd = vi.fn();
        const rawRunSingle = vi.fn().mockResolvedValue(ExitCode.SUCCESS);

        await runDispatch(rawConfig, stack.mockFetch, {
          execBdFn: rawExecBd,
          runSingleDispatchFn: rawRunSingle,
        });

        // Both paths call runSingleDispatchFn with the same parameter shape
        const molCallArgs = moleculeRunSingle.mock.calls[0] as Array<{
          config: FactoryDispatchConfig;
          baseUrl: string;
          log: unknown;
          fetchFn: unknown;
        }>;
        const rawCallArgs = rawRunSingle.mock.calls[0] as Array<{
          config: FactoryDispatchConfig;
          baseUrl: string;
          log: unknown;
          fetchFn: unknown;
        }>;

        // Both have config, baseUrl, log, fetchFn
        expect(molCallArgs[0]).toHaveProperty("config");
        expect(molCallArgs[0]).toHaveProperty("baseUrl");
        expect(molCallArgs[0]).toHaveProperty("log");
        expect(molCallArgs[0]).toHaveProperty("fetchFn");
        expect(molCallArgs[0]).toHaveProperty("suppressOutput", true);

        expect(rawCallArgs[0]).toHaveProperty("config");
        expect(rawCallArgs[0]).toHaveProperty("baseUrl");
        expect(rawCallArgs[0]).toHaveProperty("log");
        expect(rawCallArgs[0]).toHaveProperty("fetchFn");
        expect(rawCallArgs[0]).not.toHaveProperty("suppressOutput");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("formula_id metadata plumbing for DSPy compiled prompt keying", () => {
    it("verifies beadId from molecule steps is set on dispatch config for formula_id lookup", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "decompose-epic",
        vars: ["epic_id=repomap-core-638"],
        mode: "process-orchestrator",
        beadId: "repomap-core-638",  // Parent bead ID
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-dspy",
        moleculeId: "mol-dspy",
        steps: [{
          id: "repomap-core-mol-dspy.1",
          title: "Discover",
          description: "discover prompt",
          labels: ["mode:architect", "card:discover-phase"],
        }],
      });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-dspy",
        result: "done",
        elapsed_seconds: 1,
      });

      const stdout = captureStdout();

      try {
        await runDispatch(config, stack.mockFetch, { execBdFn, runSingleDispatchFn });

        const calls = runSingleDispatchFn.mock.calls as Array<
          Array<{ config: FactoryDispatchConfig }>
        >;

        // The step's beadId overrides the parent beadId
        // This is the ID that lookupBeadContext uses to fetch formula_id from Dolt
        expect(calls[0][0].config.beadId).toBe("repomap-core-mol-dspy.1");

        // The card ID from labels flows through — this is what resolveCardExitPrompt
        // uses with formula_id to find the most specific compiled prompt
        expect(calls[0][0].config.cardId).toBe("discover-phase");

        // mode from labels flows through
        expect(calls[0][0].config.mode).toBe("architect");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("verifies the DSPy prompt resolution path: beadId -> lookupBeadContext -> formula_id -> card-exit candidates", async () => {
      // This test verifies the plumbing structure that connects molecule steps
      // to DSPy compiled prompts via formula_id.
      //
      // The chain is:
      //   1. Molecule step has bead_id (e.g. "repomap-core-mol-dspy.1")
      //   2. runMoleculeDispatch sets stepConfig.beadId = step.id
      //   3. runSingleDispatch calls maybeInjectCardPrompt(payload, config)
      //   4. maybeInjectCardPrompt calls lookupBeadContext(config.beadId) -> { formulaId, depth }
      //   5. resolveCardExitPrompt(mode, cardId, depth, formulaId) builds candidates:
      //      - card-exit:{cardId}:formula-{formulaId}:depth-{depth}
      //      - card-exit:{cardId}:formula-{formulaId}
      //      - card-exit:{cardId}:depth-{depth}
      //      - card-exit:{cardId}
      //   6. readCardExitPrompt(candidates) finds the most specific compiled prompt

      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "decompose-epic",
        mode: "architect",
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-chain",
        moleculeId: "mol-chain",
        steps: [{
          id: "repomap-core-mol-chain.1",
          title: "Step with card",
          description: "test prompt",
          labels: ["mode:architect", "card:discover-phase", "phase:1"],
        }],
      });

      const capturedConfigs: FactoryDispatchConfig[] = [];
      const runSingleDispatchFn = vi.fn().mockImplementation(async (params: { config: FactoryDispatchConfig }) => {
        capturedConfigs.push({ ...params.config });
        return {
          code: ExitCode.SUCCESS,
          session_id: "sess-chain",
          result: "done",
          elapsed_seconds: 1,
        };
      });

      const stdout = captureStdout();

      try {
        await runDispatch(config, stack.mockFetch, { execBdFn, runSingleDispatchFn });

        expect(capturedConfigs).toHaveLength(1);
        const dispatched = capturedConfigs[0];

        // These are the exact fields that maybeInjectCardPrompt uses for DSPy lookup:
        // - beadId -> lookupBeadContext -> formula_id from Dolt metadata
        // - cardId -> resolveCardExitPrompt -> candidate prompt IDs
        // - mode -> resolveCardExitPrompt -> mode-card-map fallback
        // - doltPort -> lookupBeadContext -> Dolt connection
        expect(dispatched.beadId).toBe("repomap-core-mol-chain.1");
        expect(dispatched.cardId).toBe("discover-phase");
        expect(dispatched.mode).toBe("architect");
        expect(dispatched.doltPort).toBe(stack.doltPort);

        // The bead_id follows the depth convention: "repomap-core-mol-chain.1" -> depth 2
        // This would be used in the prompt candidate: card-exit:discover-phase:depth-2
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("bd output normalization resilience", () => {
    it("handles alternative field names in bd cook output", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, { formula: "alt-format" });

      // Use alternative field names that normalization should handle
      const execBdFn = vi
        .fn()
        // cook returns proto_id instead of id
        .mockResolvedValueOnce({ proto_id: "proto-alt" })
        .mockResolvedValueOnce({ proto_id: "proto-alt" })
        // pour returns nested molecule.id
        .mockResolvedValueOnce({ molecule: { id: "mol-alt" } })
        // show returns poured_steps with beadId instead of bead_id
        .mockResolvedValueOnce({
          poured_steps: [
            {
              beadId: "alt-step-1",
              name: "Alt step",
              body: "Alt prompt body",
              labels: ["mode:code"],
            },
          ],
        });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-alt",
        result: "done",
        elapsed_seconds: 1,
      });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(1);

        const output = stdout.json();
        expect(output.molecule_id).toBe("mol-alt");
        expect(output.total_steps).toBe(1);
        expect(output.dispatched_steps).toBe(1);

        // Verify alternative field names were normalized
        const step = output.steps[0];
        expect(step.step_id).toBe("alt-step-1");
        expect(step.bead_id).toBe("alt-step-1");

        // Verify the dispatch received the normalized values
        const callArgs = runSingleDispatchFn.mock.calls[0] as Array<{
          config: FactoryDispatchConfig;
        }>;
        expect(callArgs[0].config.beadId).toBe("alt-step-1");
        expect(callArgs[0].config.promptArg).toBe("Alt prompt body");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("falls back to pour output when show returns empty steps", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, { formula: "fallback-test" });

      const execBdFn = vi
        .fn()
        .mockResolvedValueOnce({ id: "proto-fb" })
        .mockResolvedValueOnce({ id: "proto-fb" })
        // pour includes steps in its response
        .mockResolvedValueOnce({
          molecule_id: "mol-fb",
          steps: [
            { id: "fb-step-1", title: "Fallback step", description: "From pour", labels: ["mode:code"] },
          ],
        })
        // show returns empty steps
        .mockResolvedValueOnce({ steps: [] });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-fb",
        result: "fallback worked",
        elapsed_seconds: 1,
      });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(1);

        const output = stdout.json();
        expect(output.total_steps).toBe(1);
        expect(output.dispatched_steps).toBe(1);
        expect(output.steps[0].step_id).toBe("fb-step-1");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("mode and card override from labels vs config defaults", () => {
    it("step labels override config defaults; steps without labels use config defaults", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "override-test",
        mode: "process-orchestrator",
        cardId: "default-card",
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-ov",
        moleculeId: "mol-ov",
        steps: [
          { id: "labeled-step", title: "With labels", description: "P1", labels: ["mode:architect", "card:explore-phase"] },
          { id: "unlabeled-step", title: "No labels", description: "P2", labels: [] },
          { id: "partial-step", title: "Mode only", description: "P3", labels: ["mode:code"] },
        ],
      });

      const capturedConfigs: FactoryDispatchConfig[] = [];
      const runSingleDispatchFn = vi.fn().mockImplementation(async (params: { config: FactoryDispatchConfig }) => {
        capturedConfigs.push({ ...params.config });
        return { code: ExitCode.SUCCESS, session_id: "sess-ov", result: "ok", elapsed_seconds: 1 };
      });

      const stdout = captureStdout();

      try {
        await runDispatch(config, stack.mockFetch, { execBdFn, runSingleDispatchFn });

        expect(capturedConfigs).toHaveLength(3);

        // Step with full labels: overrides both mode and card
        expect(capturedConfigs[0].mode).toBe("architect");
        expect(capturedConfigs[0].cardId).toBe("explore-phase");

        // Step with no labels: uses config defaults
        expect(capturedConfigs[1].mode).toBe("process-orchestrator");
        expect(capturedConfigs[1].cardId).toBe("default-card");

        // Step with only mode label: mode overridden, card from config
        expect(capturedConfigs[2].mode).toBe("code");
        expect(capturedConfigs[2].cardId).toBe("default-card");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("no-monitor mode with molecule dispatch", () => {
    it("reports 'dispatched' status instead of 'completed' for non-monitored steps", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "no-monitor-formula",
        noMonitor: true,
      });

      const execBdFn = mockBdPipeline({
        protoId: "proto-nm",
        moleculeId: "mol-nm",
        steps: [{ id: "nm-step-1", title: "NM step", description: "P1", labels: ["mode:code"] }],
      });

      const runSingleDispatchFn = vi.fn().mockResolvedValue({
        code: ExitCode.SUCCESS,
        session_id: "sess-nm",
        result: "dispatched",
        elapsed_seconds: 0,
      });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);

        const output = stdout.json();
        expect(output.dispatched_steps).toBe(1);
        // In no-monitor mode, status is "dispatched" not "completed"
        expect(output.steps[0].status).toBe("dispatched");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });
});
