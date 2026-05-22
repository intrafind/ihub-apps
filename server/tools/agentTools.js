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
import { validateTaskRecord } from '../agents/runtime/taskRecord.js';
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

export async function createTask(params = {}) {
  const user = ensureAgent(params.user);
  const { title, brief, priority = 'p2' } = params;
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
  const now = new Date().toISOString();
  const task = {
    id: `task_${now.replace(/[:.]/g, '-')}_${uuidv4().slice(0, 8)}`,
    title,
    description: brief || '',
    brief: brief || '',
    priority,
    status: 'open',
    createdBy: user.id,
    parentTaskId: currentTask?.id || null,
    depth: nextDepth,
    result: null,
    createdAt: now,
    updatedAt: now
  };
  const validation = validateTaskRecord(task);
  if (!validation.ok) {
    logger.error('Refusing to enqueue malformed task', {
      component: 'AgentTools',
      reason: validation.reason,
      task
    });
    return { error: true, code: 'INVALID_TASK', message: validation.reason };
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
  return { ok: true, taskId: task.id, depth: task.depth };
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
  listTasks,
  markTaskDone,
  writeArtifact
};
