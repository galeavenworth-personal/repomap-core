/**
 * Workflow barrel — re-exports all workflows for the Temporal bundler.
 *
 * The worker's workflowsPath points here so that all workflows are
 * bundled into a single deterministic sandbox.
 */

export { agentTaskWorkflow, abortSignal, statusQuery } from "./workflows.js";
export {
  dependencyWatchWorkflow,
  reportQuery,
} from "./dep-watch.workflows.js";
