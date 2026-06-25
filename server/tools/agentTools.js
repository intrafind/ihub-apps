/**
 * Agent Tools
 *
 * Implements the auto-registered tools available to agent runs:
 *   - read_memory / write_memory
 *   - read_inbox / write_inbox
 *   - create_task / list_tasks / mark_task_done
 *   - write_artifact
 *
 * Each function receives the merged params object, which includes the runtime
 * context fields the tool runner injects (`chatId`, `user`, `appConfig`). The
 * agent principal exposes `user.profileId` for memory/inbox scoping, and the
 * dynamic-task tools read/write `appConfig._workflowState.data._taskQueue`.
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { createSseEmitter } from '../utils/sseEmitter.js';
import memoryFile from '../agents/memory/memoryFile.js';
import inboxStore from '../agents/inbox/inboxStore.js';
import {
  buildTaskRecord,
  enforceSingleInProgress,
  deriveActiveForm,
  TASK_STATUSES
} from '../agents/runtime/taskRecord.js';
import { writeArtifactDirect } from '../agents/runtime/artifactStore.js';

const emit = createSseEmitter('AgentTools');

function ensureAgent(user) {
  if (!user || user.isAgent !== true) {
    throw new Error('Agent tools require an agent principal');
  }
  if (!user.profileId) {
    throw new Error('Agent principal missing profileId');
  }
  return user;
}

// ─── Memory ───────────────────────────────────────────────────────────────

export async function readMemory(params = {}) {
  const user = ensureAgent(params.user);
  const mem = await memoryFile.readMemory(user.profileId);
  emit('agent.memory.read', { profileId: user.profileId, version: mem.version }, params.chatId);
  return {
    profileId: user.profileId,
    version: mem.version,
    updatedAt: mem.updatedAt,
    updatedBy: mem.updatedBy,
    body: mem.body
  };
}

export async function writeMemory(params = {}) {
  const user = ensureAgent(params.user);
  const { mode = 'append', content = '', summary, expectedVersion } = params;
  if (!content || typeof content !== 'string') {
    throw new Error('content is required');
  }
  try {
    const result = await memoryFile.writeMemory(user.profileId, {
      mode,
      content,
      summary,
      expectedVersion,
      updatedBy: user.id
    });
    emit(
      'agent.memory.write',
      { profileId: user.profileId, version: result.version, mode, summary },
      params.chatId
    );
    return { ok: true, version: result.version };
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT') {
      return {
        error: true,
        code: 'VERSION_CONFLICT',
        message: err.message,
        currentVersion: err.currentVersion
      };
    }
    throw err;
  }
}

// ─── Inbox ────────────────────────────────────────────────────────────────

function resolveInboxId(params, _user) {
  const inboxId = params.inboxId || params.appConfig?._agentProfile?.inboxId;
  if (!inboxId) {
    throw new Error('inboxId is required and no default is bound to this profile');
  }
  return inboxId;
}

export async function readInbox(params = {}) {
  const user = ensureAgent(params.user);
  const inboxId = resolveInboxId(params, user);
  const status = params.status || 'all';
  const result = await inboxStore.readInbox(inboxId, { status });
  emit(
    'agent.inbox.read',
    { inboxId, profileId: user.profileId, count: result.items.length, status },
    params.chatId
  );
  return result;
}

export async function writeInbox(params = {}) {
  const user = ensureAgent(params.user);
  const inboxId = resolveInboxId(params, user);
  const mode = params.mode || 'add';
  try {
    let result;
    if (mode === 'add') {
      result = await inboxStore.addInboxItem(inboxId, {
        text: params.item || params.text,
        priority: params.priority,
        updatedBy: user.id,
        expectedVersion: params.expectedVersion
      });
    } else if (mode === 'markDone') {
      result = await inboxStore.markInboxItemDone(inboxId, {
        text: params.item || params.text,
        note: params.note,
        updatedBy: user.id,
        expectedVersion: params.expectedVersion
      });
    } else if (mode === 'replace') {
      result = await inboxStore.writeInbox(inboxId, {
        body: params.body,
        updatedBy: user.id,
        expectedVersion: params.expectedVersion
      });
    } else {
      throw new Error(`Unsupported writeInbox mode: ${mode}`);
    }
    emit(
      'agent.inbox.write',
      { inboxId, profileId: user.profileId, mode, version: result.version },
      params.chatId
    );
    return { ok: true, version: result.version };
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT' || err.code === 'NOT_FOUND') {
      return { error: true, code: err.code, message: err.message };
    }
    throw err;
  }
}

// ─── Dynamic task queue ───────────────────────────────────────────────────

function getTaskQueueState(params) {
  const state = params.appConfig?._workflowState;
  if (!state || !state.data) {
    throw new Error('Task tools require workflow state context');
  }
  if (!Array.isArray(state.data._taskQueue)) {
    state.data._taskQueue = [];
  }
  return state;
}

/**
 * Build a compact, UI-friendly snapshot of the current plan and emit
 * `agent.plan.updated` so the run-detail view can render the living plan as
 * it evolves. Called after any mutation of `_taskQueue`.
 */
function emitPlanUpdated(params, user, state, reason) {
  const queue = state.data._taskQueue || [];
  const counts = queue.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  emit(
    'agent.plan.updated',
    {
      profileId: user.profileId,
      reason,
      total: queue.length,
      counts,
      tasks: queue.map(t => ({
        id: t.id,
        title: t.title,
        activeForm: t.activeForm,
        status: t.status,
        depth: t.depth,
        priority: t.priority
      }))
    },
    params.chatId
  );
}

export async function createTask(params = {}) {
  const user = ensureAgent(params.user);
  const { title, activeForm, brief, priority = 'p2' } = params;
  if (!title || typeof title !== 'string') {
    throw new Error('title is required');
  }
  const state = getTaskQueueState(params);
  const currentTask = state.data._currentTask;
  const profile = params.appConfig?._agentProfile || {};
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const nextDepth = (currentTask?.depth ?? -1) + 1;
  if (nextDepth > maxDepth) {
    return {
      error: true,
      code: 'MAX_DEPTH',
      message: `createTask refused: depth ${nextDepth} exceeds maxDepth ${maxDepth}`
    };
  }
  let task;
  try {
    task = buildTaskRecord({
      id: `task_${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4().slice(0, 8)}`,
      title,
      activeForm,
      description: brief || '',
      brief: brief || '',
      priority,
      status: 'open',
      depth: nextDepth,
      parentTaskId: currentTask?.id || null,
      createdBy: user.id
    });
  } catch (err) {
    logger.error('Refusing to enqueue malformed task', {
      component: 'AgentTools',
      reason: err.message,
      title
    });
    return { error: true, code: 'INVALID_TASK', message: err.message };
  }
  state.data._taskQueue.push(task);
  emit(
    'agent.task.created',
    {
      profileId: user.profileId,
      taskId: task.id,
      title: task.title,
      parentTaskId: task.parentTaskId,
      depth: task.depth
    },
    params.chatId
  );
  emitPlanUpdated(params, user, state, 'create_task');
  return { ok: true, taskId: task.id, depth: task.depth };
}

/**
 * Declare or replace the agent's whole plan in one call (TodoWrite analog).
 * Accepts `tasks: [{ title, activeForm?, brief?, priority? }, ...]` and
 * rebuilds `_taskQueue` as a fresh set of `open` tasks. Existing `done`/`failed`
 * tasks are preserved by default so prior work isn't lost; pass
 * `replaceCompleted: true` to wipe everything. Enforces the dynamic-task
 * depth cap and the single-in_progress invariant.
 */
export async function setPlan(params = {}) {
  const user = ensureAgent(params.user);
  const { tasks, replaceCompleted = false } = params;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { error: true, code: 'INVALID_PLAN', message: 'tasks must be a non-empty array' };
  }
  const state = getTaskQueueState(params);
  const profile = params.appConfig?._agentProfile || {};
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const depth = (state.data._currentTask?.depth ?? -1) + 1;
  if (depth > maxDepth) {
    return {
      error: true,
      code: 'MAX_DEPTH',
      message: `set_plan refused: depth ${depth} exceeds maxDepth ${maxDepth}`
    };
  }

  const preserved = replaceCompleted
    ? []
    : state.data._taskQueue.filter(t => t.status === 'done' || t.status === 'failed');

  const built = [];
  for (const [i, raw] of tasks.entries()) {
    const title = typeof raw === 'string' ? raw : raw?.title;
    if (!title || typeof title !== 'string') {
      return {
        error: true,
        code: 'INVALID_PLAN',
        message: `tasks[${i}] is missing a title`
      };
    }
    try {
      built.push(
        buildTaskRecord({
          id: `task_${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4().slice(0, 8)}`,
          title,
          activeForm: raw?.activeForm,
          description: raw?.brief || raw?.description || '',
          brief: raw?.brief || '',
          priority: raw?.priority || 'p2',
          status: 'open',
          depth,
          createdBy: user.id
        })
      );
    } catch (err) {
      return { error: true, code: 'INVALID_PLAN', message: `tasks[${i}]: ${err.message}` };
    }
  }

  state.data._taskQueue = [...preserved, ...built];
  emitPlanUpdated(params, user, state, 'set_plan');
  return { ok: true, total: state.data._taskQueue.length, added: built.length };
}

/**
 * Update an existing task's status and/or fields. Setting `status:
 * 'in_progress'` enforces the single-in_progress invariant by demoting any
 * other in_progress task back to `open`.
 */
export async function updateTask(params = {}) {
  const user = ensureAgent(params.user);
  const { taskId, status, title, activeForm, brief, priority, result } = params;
  if (!taskId) throw new Error('taskId is required');
  const state = getTaskQueueState(params);
  const task = state.data._taskQueue.find(t => t.id === taskId);
  if (!task) return { error: true, code: 'NOT_FOUND', message: `Task ${taskId} not found` };

  if (status !== undefined) {
    if (!TASK_STATUSES.has(status)) {
      return {
        error: true,
        code: 'INVALID_STATUS',
        message: `status must be one of ${[...TASK_STATUSES].join(', ')}`
      };
    }
    task.status = status;
  }
  if (typeof title === 'string' && title.length > 0) {
    task.title = title;
    if (activeForm === undefined) task.activeForm = deriveActiveForm(title);
  }
  if (typeof activeForm === 'string') task.activeForm = activeForm;
  if (typeof brief === 'string') {
    task.brief = brief;
    task.description = brief;
  }
  if (typeof priority === 'string') task.priority = priority;
  if (result !== undefined) task.result = result;
  task.updatedAt = new Date().toISOString();

  if (task.status === 'in_progress') {
    enforceSingleInProgress(state.data._taskQueue, task.id);
  }

  emitPlanUpdated(params, user, state, 'update_task');
  return { ok: true, taskId: task.id, status: task.status };
}

export async function listTasks(params = {}) {
  ensureAgent(params.user);
  const state = getTaskQueueState(params);
  const { status, limit } = params;
  let tasks = state.data._taskQueue;
  if (status) tasks = tasks.filter(t => t.status === status);
  if (typeof limit === 'number') tasks = tasks.slice(0, limit);
  return { tasks };
}

export async function markTaskDone(params = {}) {
  const user = ensureAgent(params.user);
  const state = getTaskQueueState(params);
  const { taskId, result } = params;
  if (!taskId) throw new Error('taskId is required');
  const task = state.data._taskQueue.find(t => t.id === taskId);
  if (!task) return { error: true, code: 'NOT_FOUND', message: `Task ${taskId} not found` };
  task.status = 'done';
  task.result = result || null;
  task.updatedAt = new Date().toISOString();
  emit(
    'agent.task.completed',
    { profileId: user.profileId, taskId: task.id, title: task.title },
    params.chatId
  );
  emitPlanUpdated(params, user, state, 'mark_task_done');
  return { ok: true };
}

// ─── Artifacts ────────────────────────────────────────────────────────────

/**
 * Escape-hatch LLM tool. The runtime auto-persists synthesizer output and
 * per-task results without needing this — but profile authors can still
 * add `write_artifact` to `profile.tools[]` if they need to write a
 * specifically-named artifact mid-run.
 */
export async function writeArtifact(params = {}) {
  const user = ensureAgent(params.user);
  const { name, content, contentType = 'text/markdown' } = params;

  // Be defensive about LLM tool-call args. Gemini in particular often
  // emits a function call with the wrong arg type (e.g. `name: null`,
  // `content: { ... }` instead of a string) and a strict throw burns an
  // iteration without telling the model what to fix. So we fall back to
  // a sensible filename from the profile config, and stringify non-string
  // content. If we still can't recover, return a structured tool error so
  // the model can self-correct on the next turn instead of throwing
  // (which currently crashes the node and aborts the run).
  const profile = params.appConfig?._agentProfile;
  const primaryFilename =
    (profile?.artifacts && typeof profile.artifacts.primary === 'string'
      ? profile.artifacts.primary
      : null) || 'report.md';

  const effectiveName = !name || typeof name !== 'string' ? primaryFilename : name;

  let effectiveContent = content;
  if (typeof effectiveContent !== 'string') {
    if (effectiveContent == null) {
      return {
        error: true,
        code: 'MISSING_CONTENT',
        message: 'content is required and must be a non-empty string'
      };
    }
    try {
      effectiveContent =
        typeof effectiveContent === 'object'
          ? JSON.stringify(effectiveContent, null, 2)
          : String(effectiveContent);
      logger.info('writeArtifact: coerced non-string content', {
        component: 'AgentTools',
        originalType: typeof content
      });
    } catch {
      return {
        error: true,
        code: 'INVALID_CONTENT',
        message: 'content could not be serialized to a string'
      };
    }
  }

  // Resolve the ROOT run id so writes co-locate in one directory regardless
  // of how deep the planner sub-workflow nesting goes. Walk the
  // _parentExecutionId chain on the current workflow state if present.
  let rawRunId;
  const wfState = params.appConfig?._workflowState;
  if (wfState?.data?._parentExecutionId) {
    try {
      const { getStateManager } = await import('../services/workflow/StateManager.js');
      const sm = getStateManager();
      let executionId = wfState.executionId;
      let parentId = wfState.data._parentExecutionId;
      let hops = 0;
      while (parentId && hops < 5) {
        const ps = await sm.get(parentId);
        if (!ps) break;
        executionId = ps.executionId || parentId;
        parentId = ps.data?._parentExecutionId;
        hops++;
      }
      rawRunId = executionId;
    } catch {
      rawRunId = wfState.executionId;
    }
  }
  rawRunId = rawRunId || params.chatId || wfState?.executionId;
  try {
    const result = await writeArtifactDirect({
      runId: rawRunId,
      name: effectiveName,
      content: effectiveContent,
      contentType,
      profileId: user.profileId,
      chatId: params.chatId,
      state: params.appConfig?._workflowState
    });
    return { ok: true, name: result.name, bytes: result.bytes };
  } catch (err) {
    if (err.code === 'ARTIFACT_QUOTA_EXCEEDED') {
      return {
        error: true,
        code: 'ARTIFACT_QUOTA_EXCEEDED',
        message: `${err.message}. Stop writing more artifacts — the run has hit its quota.`
      };
    }
    return {
      error: true,
      code: 'WRITE_FAILED',
      message: `${err.message}. Pass a simple filename like '${primaryFilename}'.`
    };
  }
}

export default {
  readMemory,
  writeMemory,
  readInbox,
  writeInbox,
  createTask,
  setPlan,
  updateTask,
  listTasks,
  markTaskDone,
  writeArtifact
};
