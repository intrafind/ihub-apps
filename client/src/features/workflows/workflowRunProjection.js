/**
 * Pure projection of an SSE v2 StreamState (shared/run/runReducer.js) onto the
 * workflow execution state that `WorkflowExecutionPage` /
 * `AgentRunDetailPage` / `ExecutionProgress` read:
 *
 *   { status, currentNodes, completedNodes, failedNodes, errors, history,
 *     pendingCheckpoint, completedAt, _lastIteration,
 *     data: { nodeResults, nodeInvocations, executionMetrics, planCreated,
 *             subworkflows, _taskQueue, _taskTimings, _agent, _toolErrors,
 *             _activatedSkills, currentInboxItem, _inboxMeta, … } }
 *
 * `baseState` is the REST state (`GET /api/workflows/executions/:id`) the
 * live frames are layered on. Several runs may share one stream (child
 * sub-workflow executions keep their own executionId); their progress is
 * interleaved by stream sequence and folded into the same projected state.
 *
 * @module features/workflows/workflowRunProjection
 */
import {
  getRun,
  getRuns,
  getStreamProgress,
  getStreamInteractions,
  isRunFinished
} from '../../shared/run/runReducer';
import {
  interactionToCheckpoint,
  isCheckpointInteraction
} from '../../shared/run/interactionToCheckpoint';

/** Statuses during which the execution page keeps a live stream open. */
export function isActiveWorkflowStatus(status) {
  return status === 'running' || status === 'paused';
}

/** finishReason values that are NOT a custom terminal status of a decision workflow. */
const NON_CUSTOM_FINISH = new Set(['completed', 'cancelled', 'error']);

/**
 * Map the root run's lifecycle onto the legacy execution status vocabulary.
 *
 * @param {Object|null} rootRun - RunState of the root execution
 * @param {string|null|undefined} baseStatus - Status from the REST state
 * @returns {string|null}
 */
export function deriveWorkflowStatus(rootRun, baseStatus) {
  // A run the reducer only inferred (no run/started|ended|paused|resumed
  // frame yet) says nothing about the lifecycle — trust the server state.
  if (!rootRun || !rootRun.lastLifecycleAt) return baseStatus ?? (rootRun ? 'running' : null);
  switch (rootRun.status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'completed':
      return rootRun.finishReason && !NON_CUSTOM_FINISH.has(rootRun.finishReason)
        ? rootRun.finishReason
        : 'completed';
    case 'error':
    case 'budget_exhausted':
      return 'failed';
    case 'aborted':
      return 'cancelled';
    default:
      return baseStatus ?? rootRun.status;
  }
}

function emptyMetrics() {
  return { totalDuration: 0, totalTokens: { input: 0, output: 0, total: 0 }, nodeCount: 0 };
}

function pushUnique(list, id) {
  return list.includes(id) ? list : [...list, id];
}

function timing(d) {
  return { startedAt: d.startedAt, completedAt: d.completedAt, durationMs: d.durationMs };
}

/**
 * Fold one `progress/node` entry (former workflow.node.* / iteration /
 * subworkflow events) into the accumulator.
 */
function applyNodeEntry(acc, entry) {
  const nodeId = entry.nodeId;
  if (typeof nodeId !== 'string' || !nodeId) return;
  const at = entry.at;

  // workflow.iteration → nodeId '__loop__'
  if (nodeId === '__loop__') {
    if (entry.iteration !== undefined) acc.lastIteration = entry.iteration;
    return;
  }

  // workflow.subworkflow.start/complete → nodeId 'sub:<childExecutionId>'
  if (nodeId.startsWith('sub:')) {
    const childId = entry.progress?.executionId || nodeId.slice(4);
    const prev = acc.data.subworkflows?.[childId];
    if (entry.status === 'running') {
      acc.data.subworkflows = {
        ...(acc.data.subworkflows || {}),
        [childId]: {
          status: 'running',
          depth: entry.progress?.depth,
          taskCount: entry.progress?.taskCount
        }
      };
    } else if (entry.status === 'completed') {
      acc.data.subworkflows = {
        ...(acc.data.subworkflows || {}),
        [childId]: { ...(prev || {}), status: 'completed', completedAt: at }
      };
    }
    return;
  }

  // workflow.node.progress (progress.message) was not consumed by the page before.
  if (entry.progress && entry.progress.message !== undefined && entry.output === undefined) return;

  const executionId = entry.executionId;
  switch (entry.status) {
    case 'running':
      acc.currentNodes = [nodeId];
      acc.history.push({
        event: 'workflow.node.start',
        nodeId,
        ...(executionId ? { executionId } : {}),
        at
      });
      break;

    case 'completed': {
      const result = entry.output;
      const iteration = entry.iteration ?? result?.iteration ?? result?.output?.iteration;
      const nodeResults = { ...(acc.data.nodeResults || {}) };
      if (iteration !== undefined) nodeResults[`${nodeId}_iter${iteration}`] = result;
      nodeResults[nodeId] = result;
      acc.data.nodeResults = nodeResults;

      const prevMetrics = acc.data.executionMetrics || emptyMetrics();
      const resultMetrics = result?.metrics;
      const resultTokens = result?.tokens;
      acc.data.executionMetrics = resultMetrics
        ? {
            totalDuration: prevMetrics.totalDuration + (resultMetrics.duration || 0),
            totalTokens: {
              input: prevMetrics.totalTokens.input + (resultTokens?.input || 0),
              output: prevMetrics.totalTokens.output + (resultTokens?.output || 0),
              total:
                prevMetrics.totalTokens.total +
                ((resultTokens?.input || 0) + (resultTokens?.output || 0))
            },
            nodeCount: prevMetrics.nodeCount + 1
          }
        : prevMetrics;

      acc.currentNodes = acc.currentNodes.filter(id => id !== nodeId);
      acc.history.push({
        event: 'workflow.node.complete',
        ...(executionId ? { executionId } : {}),
        nodeId,
        result,
        iteration,
        at
      });
      acc.completedNodes = pushUnique(acc.completedNodes, nodeId);
      acc.data.nodeInvocations = (acc.data.nodeInvocations || 0) + 1;
      break;
    }

    case 'failed':
      acc.failedNodes = pushUnique(acc.failedNodes, nodeId);
      acc.errors.push(entry.error);
      break;

    default:
      // pending / skipped / paused / cancelled carry no page-level state today
      break;
  }
}

/**
 * Fold one `tool/progress` entry (former agent.* bus events; `phase` is the
 * former event name, `data` the former payload) into the accumulator —
 * exactly what the legacy `useWorkflowExecution` switch did.
 */
function applyToolProgress(acc, entry) {
  const phase = entry.phase;
  const d = entry.data || {};
  const at = entry.at;
  const historyEntry = () => ({ event: phase, ...d, at });

  switch (phase) {
    case 'agent.task.created':
      acc.data._taskQueue = [
        ...(acc.data._taskQueue || []),
        {
          id: d.taskId,
          title: d.title,
          parentTaskId: d.parentTaskId || null,
          depth: d.depth ?? 0,
          status: 'open'
        }
      ];
      break;

    // The living-plan tools (set_plan / update_task) emit a full plan snapshot
    // rather than per-task create events. Replace the queue with the snapshot.
    case 'agent.plan.updated':
      if (Array.isArray(d.tasks)) {
        acc.data._taskQueue = d.tasks.map(t => ({
          id: t.id,
          title: t.title,
          activeForm: t.activeForm,
          status: t.status || 'open',
          depth: t.depth ?? 0,
          priority: t.priority,
          parentTaskId: t.parentTaskId || null
        }));
      }
      break;

    case 'agent.task.completed':
    case 'agent.task.failed':
      acc.data._taskQueue = (acc.data._taskQueue || []).map(t =>
        t.id === d.taskId ? { ...t, status: phase === 'agent.task.failed' ? 'failed' : 'done' } : t
      );
      // Mirror the timing so the step timeline shows Started + Duration the
      // moment the task ends, without waiting for a refetch.
      if (phase === 'agent.task.completed' && d.taskId && d.durationMs != null) {
        acc.data._taskTimings = { ...(acc.data._taskTimings || {}), [d.taskId]: timing(d) };
      }
      break;

    case 'agent.artifact.written':
      acc.data._agent = {
        ...(acc.data._agent || {}),
        artifacts: [
          ...(acc.data._agent?.artifacts || []),
          { name: d.name || d.artifactName, bytes: d.bytes, at }
        ]
      };
      break;

    case 'agent.tool.hallucinated':
      acc.data._toolErrors = [
        ...(acc.data._toolErrors || []),
        {
          ts: at,
          requestedName: d.requestedName,
          availableTools: d.availableTools,
          reason: 'not_registered'
        }
      ];
      break;

    case 'agent.inbox.read':
      // The deterministic inbox-load executor includes a `picked` field with
      // the item it injected into state; the LLM read_inbox tool does not.
      acc.history.push(historyEntry());
      if (d.picked && typeof d.picked === 'object') {
        acc.data.currentInboxItem = {
          id: d.picked.line != null ? `line-${d.picked.line}` : null,
          line: d.picked.line,
          text: d.picked.text,
          priority: d.picked.priority,
          raw: d.picked.raw
        };
        acc.data._inboxMeta = { ...(acc.data._inboxMeta || {}), inboxId: d.inboxId };
      }
      break;

    case 'agent.step.completed':
      // Live timing for orchestrator steps (planner, synthesizer, inbox-load …).
      if (d.nodeId && d.durationMs != null) {
        acc.data._taskTimings = { ...(acc.data._taskTimings || {}), [d.nodeId]: timing(d) };
      }
      break;

    case 'agent.skill.activated':
      acc.history.push(historyEntry());
      acc.data._activatedSkills = {
        ...(acc.data._activatedSkills || {}),
        [d.skillName]: {
          description: d.description || '',
          activatedAt: at,
          activatedBy: d.activatedBy || 'unknown'
        }
      };
      break;

    case 'agent.inbox.marked_done':
      acc.history.push(historyEntry());
      if (acc.data.currentInboxItem) {
        acc.data.currentInboxItem = { ...acc.data.currentInboxItem, _markedDone: true };
      }
      break;

    case 'agent.memory.read':
    case 'agent.memory.write':
    case 'agent.inbox.empty':
    case 'agent.inbox.write':
    case 'agent.hitl.requested':
    case 'agent.hitl.approved':
    case 'agent.hitl.rejected':
      // Chronological tape only.
      acc.history.push(historyEntry());
      break;

    default:
      break;
  }
}

/**
 * Project the stream state onto the execution page state.
 *
 * @param {Object} streamState - StreamState from the run reducer
 * @param {string} rootRunId - The execution id whose run is the root of the stream
 * @param {Object|null} [baseState] - REST state to layer the live frames on
 * @returns {Object} execution state in the shape the pages read
 */
export function projectWorkflowState(streamState, rootRunId, baseState) {
  const base = baseState && typeof baseState === 'object' ? baseState : {};
  const rootRun = getRun(streamState, rootRunId);
  const runs = getRuns(streamState);

  const acc = {
    currentNodes: [...(base.currentNodes || [])],
    completedNodes: [...(base.completedNodes || [])],
    failedNodes: [...(base.failedNodes || [])],
    errors: [...(base.errors || [])],
    history: [...(base.history || [])],
    lastIteration: base._lastIteration,
    data: { ...(base.data || {}) }
  };

  // ── progress (all runs on the stream, in sequence order) ─────────────
  for (const entry of getStreamProgress(streamState)) {
    if (entry.kind === 'progress/node') applyNodeEntry(acc, entry);
    else if (entry.kind === 'tool/progress') applyToolProgress(acc, entry);
  }

  // ── meta.extra (planCreated) ─────────────────────────────────────────
  for (const run of runs) {
    const extra = run.meta?.extra;
    if (extra && extra.planCreated !== undefined) acc.data.planCreated = extra.planCreated;
  }

  // ── root run lifecycle ───────────────────────────────────────────────
  let completedAt = base.completedAt;
  if (rootRun) {
    if (rootRun.status === 'completed') {
      completedAt = rootRun.endedAt || completedAt || null;
      // Merge the final output into data (handle empty/undefined output gracefully).
      if (rootRun.output && typeof rootRun.output === 'object' && !Array.isArray(rootRun.output)) {
        acc.data = { ...acc.data, ...rootRun.output };
      }
    }
    if (rootRun.status === 'error' && rootRun.error) acc.errors.push(rootRun.error);
  }

  // ── pending checkpoint ───────────────────────────────────────────────
  const checkpointInteractions = getStreamInteractions(streamState).filter(isCheckpointInteraction);
  const rootFinished = !!rootRun && isRunFinished(rootRun);
  let pending = null;
  if (!rootFinished) {
    for (let i = checkpointInteractions.length - 1; i >= 0; i--) {
      if (checkpointInteractions[i].status === 'pending') {
        pending = checkpointInteractions[i];
        break;
      }
    }
  }
  let pendingCheckpoint;
  if (pending) {
    pendingCheckpoint = interactionToCheckpoint(pending);
    if (pendingCheckpoint.nodeId) acc.currentNodes = [pendingCheckpoint.nodeId];
  } else if (
    checkpointInteractions.length > 0 ||
    rootFinished ||
    (rootRun && rootRun.lastLifecycleAt && rootRun.status !== 'paused')
  ) {
    // The stream told us about interactions / the lifecycle: nothing is pending.
    pendingCheckpoint = null;
  } else {
    pendingCheckpoint = base.pendingCheckpoint ?? null;
  }

  return {
    ...base,
    status: deriveWorkflowStatus(rootRun, base.status),
    currentNodes: acc.currentNodes,
    completedNodes: acc.completedNodes,
    failedNodes: acc.failedNodes,
    errors: acc.errors,
    history: acc.history,
    pendingCheckpoint,
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(acc.lastIteration !== undefined ? { _lastIteration: acc.lastIteration } : {}),
    data: acc.data
  };
}

export default projectWorkflowState;
