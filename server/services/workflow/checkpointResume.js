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
import { actionTracker } from '../../actionTracker.js';
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

/**
 * True for interactions that pause a workflow execution on a checkpoint: a
 * `human` node's approval / review / input (`origin: node`) or an `ask_user`
 * question raised inside a prompt / agent node (`origin: tool`). Both carry
 * `source.checkpointId` and `source.executionId`.
 */
export function isCheckpointInteraction(interaction) {
  return (
    !!interaction &&
    typeof interaction.source?.checkpointId === 'string' &&
    interaction.source.checkpointId.length > 0 &&
    typeof interaction.source?.executionId === 'string' &&
    interaction.source.executionId.length > 0
  );
}

/**
 * A node raises its interaction before the engine has written the paused
 * state, so an answer that arrives at once (the queue, a script) can find the
 * execution still `running`. The resume waits this long for the pause to land
 * before it rejects the answer.
 */
const PAUSE_SETTLE_MS = 1500;
const PAUSE_SETTLE_INTERVAL_MS = 50;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function awaitPaused(engine, executionId, state, maxMs) {
  const deadline = Date.now() + maxMs;
  let current = state;
  while (current?.status === 'running' && Date.now() < deadline) {
    await sleep(Math.min(PAUSE_SETTLE_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    current = (await engine.getState(executionId)) ?? current;
  }
  return current;
}

/** Engine failures that mean the execution moved on: nothing to put back. */
const STATE_MOVED_ON = new Set(['INVALID_STATE_FOR_RESUME', 'EXECUTION_NOT_FOUND']);

/**
 * `engine.resume` failed after the checkpoint was cleared and the state
 * advanced: put the execution back where the answer found it, so the
 * interaction — which stays pending — can be answered again instead of
 * pointing at an execution nothing can resume. When the engine reports that
 * the execution is no longer paused (resumed or gone elsewhere), the state is
 * left alone.
 */
async function restorePausedState({ engine, registry, executionId, state, pending, cause }) {
  if (STATE_MOVED_ON.has(cause?.code)) return;
  try {
    await engine.stateManager.update(executionId, {
      status: 'paused',
      completedNodes: state.completedNodes || [],
      currentNodes: state.currentNodes || [],
      data: { ...state.data, pendingCheckpoint: pending }
    });
    registry.setPendingCheckpoint(executionId, pending);
  } catch (err) {
    logger.error('Could not restore the paused execution after a failed resume', {
      component: 'CheckpointResume',
      executionId,
      checkpointId: pending.id,
      error: err.message
    });
  }
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
 * @param {number} [opts.pauseSettleMs] - how long to wait for a just-raised checkpoint's pause to land
 * @returns {Promise<Object>} the execution state after resume
 * @throws {CheckpointResumeError} when the execution is not paused on this checkpoint or rejects the answer
 */
export async function resumeWorkflowFromAnswer(interaction, opts = {}) {
  const {
    user = null,
    engine = getWorkflowEngine(),
    registry = getExecutionRegistry(),
    executor = new HumanNodeExecutor(),
    pauseSettleMs = PAUSE_SETTLE_MS
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
    if (state) state = await awaitPaused(engine, executionId, state, pauseSettleMs);
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
  if (pending.type === 'question') {
    return resumeQuestion({
      pending,
      workflow,
      state,
      executionId,
      answer,
      user,
      engine,
      registry
    });
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
    await restorePausedState({ engine, registry, executionId, state, pending, cause: err });
    throw wrapEngineError(err);
  }

  return newState;
}

/**
 * Resume an execution paused by an `ask_user` question inside a prompt /
 * agent node: the answer is stored on the state, the pending checkpoint
 * cleared, and the engine re-runs the paused node, which continues its loop
 * from the persisted transcript with the answer as the tool result
 * (`questionPause.resumeTranscript`).
 * @private
 */
async function resumeQuestion({
  pending,
  workflow,
  state,
  executionId,
  answer,
  user,
  engine,
  registry
}) {
  const node = (workflow.nodes || []).find(n => n.id === pending.nodeId);
  if (!node) {
    throw new CheckpointResumeError('Paused node not found in workflow', 'NODE_NOT_FOUND');
  }
  registry.clearPendingCheckpoint(executionId);
  await engine.stateManager.update(executionId, {
    data: {
      pendingCheckpoint: null,
      _questionAnswers: {
        ...(state.data?._questionAnswers || {}),
        [pending.id]: {
          value: answer.value ?? null,
          skipped: answer.skipped === true,
          by: answer.by || null,
          at: answer.at || new Date().toISOString()
        }
      }
    }
  });
  actionTracker.emit('fire-sse', {
    event: 'workflow.human.responded',
    chatId: executionId,
    executionId,
    nodeId: node.id,
    checkpointId: pending.id,
    response: answer.skipped ? null : (answer.value ?? null)
  });
  logger.info('Question answered; resuming the paused node', {
    component: 'CheckpointResume',
    executionId,
    nodeId: node.id,
    checkpointId: pending.id,
    skipped: answer.skipped === true
  });
  const isAgentRun = !!state.data?._agent?.profileId;
  try {
    return await engine.resume(
      executionId,
      {},
      {
        user: user || { id: answer.by || 'system', groups: [] },
        workflow,
        ...(isAgentRun ? { timeout: AGENT_NODE_TIMEOUT_MS } : {})
      }
    );
  } catch (err) {
    await restorePausedState({ engine, registry, executionId, state, pending, cause: err });
    throw wrapEngineError(err);
  }
}

/** Ledger marker after the answer was accepted: `run/resumed` follows `interaction/answered`. */
function appendRunResumed(interaction, runLog) {
  const executionId = interaction.source?.executionId || interaction.runId;
  // The answer may land on a worker that did not start the execution's run:
  // re-register it so the sequence continues from the persisted ledger.
  Promise.resolve()
    .then(() =>
      runLog.appendRecovered(
        executionId,
        RUN_LOG_EVENTS.RUN_RESUMED,
        { interactionId: interaction.id },
        { kind: 'workflow' }
      )
    )
    .catch(err => {
      logger.debug('Ledger run/resumed append failed', {
        component: 'CheckpointResume',
        executionId,
        error: err.message
      });
    });
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
  // `policy.onTimeout: 'fail'` — a checkpoint nobody answered in time ends its
  // execution instead of leaving it paused forever.
  const onExpired = interaction => {
    if (!isCheckpointInteraction(interaction)) return;
    const executionId = interaction.source?.executionId || interaction.runId;
    if (!isValidRunId(executionId)) return;
    const engine = deps.engine || getWorkflowEngine();
    Promise.resolve()
      .then(() => engine.cancel(executionId, 'human_checkpoint_expired'))
      .then(() =>
        logger.info('Execution cancelled: human checkpoint expired', {
          component: 'CheckpointResume',
          executionId,
          interactionId: interaction.id
        })
      )
      .catch(err => {
        if (err?.code === 'EXECUTION_NOT_FOUND') return;
        logger.warn('Could not cancel execution after checkpoint expiry', {
          component: 'CheckpointResume',
          executionId,
          error: err.message
        });
      });
  };
  service.on('expired', onExpired);
  return () => {
    unregisterAnswer();
    service.off('answered', onAnswered);
    service.off('expired', onExpired);
  };
}
