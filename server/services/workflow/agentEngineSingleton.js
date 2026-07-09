import { WorkflowEngine } from './WorkflowEngine.js';

/**
 * Shared WorkflowEngine instance for agent runs, used by both the manual/
 * triggered run-start path (routes/agents/runs.js) and the boot-time
 * interrupted-run resume path (server.js). A single instance keeps the
 * 30-minute default node timeout in one place instead of two constructor
 * calls drifting apart, and — like getStateManager() — ensures every caller
 * observes the same in-memory execution state.
 *
 * 30-minute default node timeout: the phased planner node blocks while its
 * entire sub-workflow runs (up to 6 tasks × several minutes each), so the
 * 5-minute DEFAULT_NODE_TIMEOUT would kill it mid-run. 30 min matches
 * MAX_NODE_TIMEOUT in WorkflowEngine and is the ceiling _normalizeTimeout
 * allows.
 * @type {WorkflowEngine|null}
 * @private
 */
let _engine = null;

/**
 * Returns the shared agent-run WorkflowEngine singleton, creating it on
 * first call.
 * @returns {WorkflowEngine}
 */
export function getAgentWorkflowEngine() {
  if (!_engine) _engine = new WorkflowEngine({ defaultTimeout: 30 * 60 * 1000 });
  return _engine;
}

/**
 * Resets the singleton instance (for testing purposes only).
 */
export function resetAgentWorkflowEngine() {
  _engine = null;
}
