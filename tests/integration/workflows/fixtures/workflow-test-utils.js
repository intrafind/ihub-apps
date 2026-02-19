/**
 * Utility functions for workflow E2E tests.
 *
 * These utilities are designed to work with Jest's CommonJS mode
 * by dynamically importing the ESM workflow modules.
 */

/**
 * Workflow status constants (matching StateManager.WorkflowStatus)
 */
export const WorkflowStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Check if LLM API keys are available for testing.
 * Tests will be skipped if no API keys are configured.
 * @returns {boolean} True if API keys are missing
 */
export function skipIfNoApiKey() {
  const hasGoogleKey = !!process.env.GOOGLE_API_KEY;
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

  return !hasGoogleKey && !hasOpenAIKey && !hasAnthropicKey;
}

/**
 * Check if Google Search API is configured.
 * @returns {boolean} True if search API is not configured
 */
export function skipIfNoSearchApi() {
  return !process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_CX;
}

/**
 * Get a message describing why tests are being skipped.
 * @returns {string} Skip reason message
 */
export function getSkipReason() {
  if (skipIfNoApiKey()) {
    return 'No LLM API key configured (GOOGLE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY required)';
  }
  return '';
}

/**
 * Dynamically load the workflow engine and related modules.
 * This is needed because the server uses ESM and Jest has issues with it.
 * @returns {Promise<Object>} Object containing engine-related modules
 */
export async function loadWorkflowModules() {
  const [WorkflowEngine, StateManager, ExecutionRegistry] = await Promise.all([
    import('../../../../server/services/workflow/WorkflowEngine.js'),
    import('../../../../server/services/workflow/StateManager.js'),
    import('../../../../server/services/workflow/ExecutionRegistry.js')
  ]);

  return {
    WorkflowEngine: WorkflowEngine.WorkflowEngine || WorkflowEngine.default,
    StateManager: StateManager.StateManager || StateManager.default,
    getExecutionRegistry: ExecutionRegistry.getExecutionRegistry
  };
}

/**
 * Create a new workflow engine instance with fresh state manager.
 * Must be called after loadWorkflowModules().
 * @param {Object} modules - Object from loadWorkflowModules()
 * @returns {Object} Object containing engine and stateManager
 */
export function createTestEngine(modules) {
  const { WorkflowEngine, StateManager } = modules;
  const stateManager = new StateManager();
  const engine = new WorkflowEngine({ stateManager });
  return { engine, stateManager };
}

/**
 * Wait for a workflow execution to reach a specific status.
 * @param {WorkflowEngine} engine - The workflow engine
 * @param {string} executionId - The execution ID
 * @param {string} targetStatus - The status to wait for
 * @param {number} maxWaitMs - Maximum wait time in milliseconds
 * @returns {Promise<Object>} The execution state
 */
export async function waitForStatus(engine, executionId, targetStatus, maxWaitMs = 30000) {
  const startTime = Date.now();
  const terminalStatuses = [
    WorkflowStatus.COMPLETED,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
    'approved',
    'rejected'
  ];

  while (Date.now() - startTime < maxWaitMs) {
    const state = await engine.getState(executionId);

    if (!state) {
      throw new Error(`Execution ${executionId} not found`);
    }

    if (state.status === targetStatus) {
      return state;
    }

    // If the workflow has entered a terminal state that isn't the target, fail
    if (terminalStatuses.includes(state.status) && state.status !== targetStatus) {
      throw new Error(
        `Workflow reached terminal status '${state.status}' instead of '${targetStatus}'`
      );
    }

    // Poll every 100ms
    await new Promise(r => setTimeout(r, 100));
  }

  const finalState = await engine.getState(executionId);
  throw new Error(
    `Workflow did not reach status '${targetStatus}' within ${maxWaitMs}ms. Current status: ${finalState?.status}`
  );
}

/**
 * Wait for a workflow execution to complete (any terminal state).
 * @param {WorkflowEngine} engine - The workflow engine
 * @param {string} executionId - The execution ID
 * @param {number} maxWaitMs - Maximum wait time in milliseconds
 * @returns {Promise<Object>} The final execution state
 */
export async function waitForCompletion(engine, executionId, maxWaitMs = 60000) {
  const startTime = Date.now();
  const terminalStatuses = [
    WorkflowStatus.COMPLETED,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
    // Custom terminal statuses from end nodes
    'approved',
    'rejected'
  ];

  while (Date.now() - startTime < maxWaitMs) {
    const state = await engine.getState(executionId);

    if (!state) {
      throw new Error(`Execution ${executionId} not found`);
    }

    if (terminalStatuses.includes(state.status)) {
      return state;
    }

    // Poll every 100ms
    await new Promise(r => setTimeout(r, 100));
  }

  const finalState = await engine.getState(executionId);
  throw new Error(
    `Workflow did not complete within ${maxWaitMs}ms. Current status: ${finalState?.status}`
  );
}

/**
 * Wait for a workflow to pause (at a human checkpoint).
 * @param {WorkflowEngine} engine - The workflow engine
 * @param {string} executionId - The execution ID
 * @param {number} maxWaitMs - Maximum wait time in milliseconds
 * @returns {Promise<Object>} The paused state with checkpoint info
 */
export async function waitForPause(engine, executionId, maxWaitMs = 30000) {
  return waitForStatus(engine, executionId, WorkflowStatus.PAUSED, maxWaitMs);
}

/**
 * Respond to a human checkpoint and resume the workflow.
 * @param {WorkflowEngine} engine - The workflow engine
 * @param {string} executionId - The execution ID
 * @param {string} response - The response option value (e.g., 'approve', 'reject')
 * @param {Object} data - Additional form data
 * @param {Object} workflowDefinition - The workflow definition (required for resume)
 * @returns {Promise<Object>} The resumed state
 */
export async function respondToCheckpoint(
  engine,
  executionId,
  response,
  data = {},
  workflowDefinition
) {
  // Get the current state to find the checkpoint
  const state = await engine.getState(executionId);

  if (!state) {
    throw new Error(`Execution ${executionId} not found`);
  }

  if (state.status !== WorkflowStatus.PAUSED) {
    throw new Error(`Workflow is not paused (status: ${state.status})`);
  }

  const checkpoint = state.data?.pendingCheckpoint;
  if (!checkpoint) {
    throw new Error('No pending checkpoint found in workflow state');
  }

  // Resume with the human response
  return engine.resume(
    executionId,
    {
      _humanResponse: {
        checkpointId: checkpoint.id,
        response,
        data
      }
    },
    {
      workflow: workflowDefinition || state.data._workflowDefinition
    }
  );
}

/**
 * Clean up an execution from the registry.
 * @param {Function} getExecutionRegistry - Function to get the registry
 * @param {string} executionId - The execution ID to clean up
 */
export function cleanupExecution(getExecutionRegistry, executionId) {
  try {
    if (getExecutionRegistry) {
      const registry = getExecutionRegistry();
      registry.remove(executionId);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a mock user context for tests.
 * @returns {Object} User context object
 */
export function createTestUser() {
  return {
    id: 'test-user-1',
    username: 'test-user',
    email: 'test@example.com',
    groups: ['users']
  };
}

/**
 * Default options for workflow execution in tests.
 */
export const defaultTestOptions = {
  checkpointOnNode: false,
  timeout: 120000, // 2 minutes per node
  language: 'en'
};

/**
 * Measures execution time of an async function.
 * @param {Function} fn - Async function to measure
 * @returns {Promise<{result: *, durationMs: number}>}
 */
export async function measureTime(fn) {
  const startTime = Date.now();
  const result = await fn();
  const durationMs = Date.now() - startTime;
  return { result, durationMs };
}

/**
 * Assert that the workflow completed successfully.
 * @param {Object} state - Final workflow state
 */
export function assertWorkflowCompleted(state) {
  expect(state).toBeDefined();
  expect(state.status).toBe(WorkflowStatus.COMPLETED);
  expect(state.errors).toHaveLength(0);
  expect(state.completedAt).toBeTruthy();
}

/**
 * Assert that the workflow failed.
 * @param {Object} state - Final workflow state
 */
export function assertWorkflowFailed(state) {
  expect(state).toBeDefined();
  expect(state.status).toBe(WorkflowStatus.FAILED);
  expect(state.errors.length).toBeGreaterThan(0);
}

/**
 * Assert that the workflow is paused at a human checkpoint.
 * @param {Object} state - Current workflow state
 */
export function assertWorkflowPaused(state) {
  expect(state).toBeDefined();
  expect(state.status).toBe(WorkflowStatus.PAUSED);
  expect(state.data?.pendingCheckpoint).toBeDefined();
  expect(state.data?.pendingCheckpoint?.id).toBeTruthy();
}
