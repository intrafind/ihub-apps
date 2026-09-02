/**
 * Checkpoint resume — the one path from an answered `human` node interaction
 * back into the workflow engine (concept §5.5).
 *
 * A workflow `human` node pauses its execution and raises an interaction
 * (`HumanNodeExecutor.execute`). Answering that interaction through the one
 * answer endpoint (`POST /api/runs/:runId/interactions/:id/answer`) runs
 * `resumeWorkflowFromAnswer` BEFORE the answer is persisted: the executor
 * validates the answer against the node, the scheduler routes on the chosen
 * branch, the execution state is updated and the engine resumes. If any step
 * throws, the answer is rejected and the interaction stays pending, so the
 * human can try again.
 *
 * This replaces the resume logic that was duplicated in
 * `POST /api/workflows/executions/:id/respond` and
 * `POST /api/agents/runs/:id/approve`.
 *
 * @module services/workflow/checkpointResume
 */
import interactionService, { InteractionError } from '../loop/InteractionService.js';
import defaultRunLog, { isValidRunId } from '../loop/RunLog.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { getWorkflowEngine } from './WorkflowEngine.js';
import { getExecutionRegistry } from './ExecutionRegistry.js';
import { HumanNodeExecutor } from './executors/HumanNodeExecutor.js';
import logger from '../../utils/logger.js';

/**
 * 30-minute node timeout for agent runs: the phased planner node blocks while
 * its entire sub-workflow runs, so the engine's 5-minute default would kill it
 * mid-run. Matches MAX_NODE_TIMEOUT in WorkflowEngine (the ceiling
 * `_normalizeTimeout` allows). Shared by the manual-trigger, resume and
 * checkpoint-resume paths so a resumed agent run keeps its budget.
 */
export const AGENT_NODE_TIMEOUT_MS = 30 * 60 * 1000;

/** Raised when an answered checkpoint cannot be applied to its execution. */
export class CheckpointResumeError extends InteractionError {
  constructor(message, code, status = 409) {
    super(message, code, status);
    this.name = 'CheckpointResumeError';
  }
}

/** True for interactions raised by a workflow `human` node. */
export function isCheckpointInteraction(interaction) {
  return (
    !!interaction &&
    interaction.origin === 'node' &&
    typeof interaction.source?.checkpointId === 'string' &&
    interaction.source.checkpointId.length > 0
  );
}

const ENGINE_ERROR_STATUS = Object.freeze({
  EXECUTION_NOT_FOUND: 404,
  INVALID_STATE_FOR_RESUME: 409,
  WORKFLOW_NOT_AVAILABLE: 409,
  NO_RESUME_POINT: 409,
  USER_CANCELLED: 409
});

/**
 * Apply an answered checkpoint interaction to its paused execution and resume it.
 *
 * @param {Object} interaction - answered interaction (`status: 'answered'`, `answer` set)
 * @param {Object} [opts]
 * @param {Object|null} [opts.user] - the human who answered (execution principal for the resumed loop)
 * @param {Object} [opts.engine] - WorkflowEngine (default: shared singleton)
 * @param {Object} [opts.registry] - ExecutionRegistry (default: shared singleton)
 * @param {Object} [opts.executor] - HumanNodeExecutor (default: new instance)
 * @returns {Promise<Object>} the execution state after resume
 * @throws {CheckpointResumeError} when the execution is not paused on this checkpoint or rejects the answer
 */
export async function resumeWorkflowFromAnswer(interaction, opts = {}) {
  const {
    user = null,
    engine = getWorkflowEngine(),
    registry = getExecutionRegistry(),
    executor = new HumanNodeExecutor()
  } = opts;
  const executionId = interaction.source?.executionId || interaction.runId;
  const checkpointId = interaction.source?.checkpointId || interaction.id;
  const answer = interaction.answer || {};
  // The execution id keys the persisted state files: only a well-formed run id
  // may reach the engine.
  if (!isValidRunId(executionId)) {
    throw new CheckpointResumeError('Invalid execution id', 'INVALID_EXECUTION_ID', 400);
  }

  let state;
  try {
    state = await engine.getState(executionId);
  } catch (err) {
    throw wrapEngineError(err);
  }
  if (!state) {
    throw new CheckpointResumeError(
      `Execution ${executionId} not found`,
      'EXECUTION_NOT_FOUND',
      404
    );
  }
  if (state.status !== 'paused') {
    throw new CheckpointResumeError(
      `Cannot resume execution with status: ${state.status}`,
      'INVALID_STATE_FOR_RESUME'
    );
  }
  const pending = state.data?.pendingCheckpoint;
  if (!pending) {
    throw new CheckpointResumeError(
      'No pending checkpoint for this execution',
      'NO_PENDING_CHECKPOINT'
    );
  }
  if (pending.id !== checkpointId) {
    throw new CheckpointResumeError(
      'Checkpoint does not match the pending checkpoint',
      'CHECKPOINT_MISMATCH'
    );
  }
  const workflow = state.data?._workflowDefinition;
  if (!workflow) {
    throw new CheckpointResumeError(
      'Workflow definition not available for resume',
      'WORKFLOW_NOT_AVAILABLE'
    );
  }
  const humanNode = (workflow.nodes || []).find(n => n.id === pending.nodeId);
  if (!humanNode) {
    throw new CheckpointResumeError('Human node not found in workflow', 'HUMAN_NODE_NOT_FOUND');
  }

  // The option value (or the approval decision) is the branch the node routes on.
  const response = answer.value ?? answer.decision;
  const resumeResult = await executor.resume(
    humanNode,
    state,
    { checkpointId, response, data: answer.data, note: answer.reason },
    { executionId, user }
  );
  if (resumeResult.status === 'failed') {
    throw new CheckpointResumeError(
      resumeResult.error || 'Failed to process response',
      'RESUME_REJECTED',
      400
    );
  }

  registry.clearPendingCheckpoint(executionId);

  const branch = resumeResult.branch;
  const humanResult = { branch, response, ...(resumeResult.output || {}) };
  const nextNodes = engine.scheduler.getNextNodes(humanNode.id, humanResult, workflow, state);

  logger.info('Human checkpoint routing', {
    component: 'CheckpointResume',
    executionId,
    humanNodeId: humanNode.id,
    checkpointId,
    response,
    branch,
    nextNodes
  });

  await engine.stateManager.update(executionId, {
    completedNodes: [...(state.completedNodes || []), humanNode.id],
    currentNodes: nextNodes,
    data: {
      ...state.data,
      ...(resumeResult.stateUpdates || {}),
      // The human response, for edge condition evaluation.
      [`_humanResult_${humanNode.id}`]: humanResult,
      nodeResults: {
        ...(state.data?.nodeResults || {}),
        [humanNode.id]: humanResult
      }
    }
  });

  const isAgentRun = !!state.data?._agent?.profileId;
  let newState;
  try {
    newState = await engine.resume(
      executionId,
      {},
      {
        user: user || { id: answer.by || 'system', groups: [] },
        workflow,
        ...(isAgentRun ? { timeout: AGENT_NODE_TIMEOUT_MS } : {})
      }
    );
  } catch (err) {
    throw wrapEngineError(err);
  }

  return newState;
}

/** Ledger marker after the answer was accepted: `run/resumed` follows `interaction/answered`. */
function appendRunResumed(interaction, runLog) {
  const executionId = interaction.source?.executionId || interaction.runId;
  try {
    runLog.append(executionId, RUN_LOG_EVENTS.RUN_RESUMED, { interactionId: interaction.id });
  } catch (err) {
    logger.debug('Ledger run/resumed append failed', {
      component: 'CheckpointResume',
      executionId,
      error: err.message
    });
  }
}

function wrapEngineError(err) {
  if (err instanceof InteractionError) return err;
  const status = ENGINE_ERROR_STATUS[err?.code];
  if (status) return new CheckpointResumeError(err.message, err.code, status);
  return err;
}

/**
 * Wire the resume into the interaction service: every answered checkpoint
 * interaction resumes its execution before the answer is accepted.
 *
 * @param {import('../loop/InteractionService.js').InteractionService} [service]
 * @param {Object} [deps] - overrides for `resumeWorkflowFromAnswer` (tests)
 * @returns {() => void} unregister
 */
export function registerCheckpointResume(service = interactionService, deps = {}) {
  const runLog = deps.runLog || defaultRunLog;
  const unregisterAnswer = service.onAnswer(async (interaction, ctx) => {
    if (!isCheckpointInteraction(interaction)) return;
    await resumeWorkflowFromAnswer(interaction, { user: ctx?.user || null, ...deps });
  });
  const onAnswered = interaction => {
    if (isCheckpointInteraction(interaction)) appendRunResumed(interaction, runLog);
  };
  service.on('answered', onAnswered);
  return () => {
    unregisterAnswer();
    service.off('answered', onAnswered);
  };
}
