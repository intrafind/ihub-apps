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

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { actionTracker } from '../actionTracker.js';
import { getRootDir } from '../pathUtils.js';
import { atomicWriteFile } from '../utils/atomicWrite.js';
import { isValidId, resolveAndValidatePath } from '../utils/pathSecurity.js';
import logger from '../utils/logger.js';
import memoryFile from '../agents/memory/memoryFile.js';
import inboxStore from '../agents/inbox/inboxStore.js';

function ensureAgent(user) {
  if (!user || user.isAgent !== true) {
    throw new Error('Agent tools require an agent principal');
  }
  if (!user.profileId) {
    throw new Error('Agent principal missing profileId');
  }
  return user;
}

function emit(event, payload, chatId) {
  try {
    actionTracker.emit('fire-sse', { event, chatId, ...payload });
  } catch (err) {
    logger.warn('Agent tool event emit failed', {
      component: 'AgentTools',
      event,
      error: err.message
    });
  }
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
  const task = {
    id: `task_${new Date().toISOString().replace(/[:.]/g, '-')}_${uuidv4().slice(0, 8)}`,
    title,
    brief: brief || '',
    priority,
    status: 'open',
    createdBy: user.id,
    parentTaskId: currentTask?.id || null,
    depth: nextDepth,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
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

function safeArtifactName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('artifact name is required');
  }
  if (name.includes('/') || name.includes('..') || name.startsWith('.')) {
    throw new Error('artifact name must be a simple filename');
  }
  if (name.length > 128) {
    throw new Error('artifact name too long');
  }
  // path.basename is a CodeQL-recognized sanitizer; reject if anything
  // changed (i.e. embedded separators).
  const base = path.basename(name);
  if (base !== name) {
    throw new Error('artifact name must be a simple filename');
  }
  return base;
}

export async function writeArtifact(params = {}) {
  const user = ensureAgent(params.user);
  const { name, content, contentType = 'text/markdown' } = params;
  const safeName = safeArtifactName(name);
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }
  const rawRunId = params.appConfig?._workflowState?.executionId || params.chatId;
  if (!rawRunId || !isValidId(rawRunId)) {
    throw new Error('writeArtifact requires a valid runId/executionId');
  }
  // path.basename is a CodeQL-recognized sanitizer for js/path-injection.
  const safeRunId = path.basename(String(rawRunId));
  if (safeRunId !== rawRunId) {
    throw new Error(`writeArtifact: invalid runId: ${rawRunId}`);
  }
  const artifactsRoot = path.join(getRootDir(), 'contents', 'data', 'agent-artifacts');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const dir = await resolveAndValidatePath(safeRunId, artifactsRoot);
  if (!dir) {
    throw new Error(`writeArtifact: invalid runId path: ${safeRunId}`);
  }
  // lgtm[js/path-injection] -- runId validated by isValidId; path canonicalized.
  await fs.mkdir(dir, { recursive: true });
  const file = await resolveAndValidatePath(safeName, dir);
  if (!file) {
    throw new Error(`writeArtifact: invalid artifact path: ${safeName}`);
  }
  // lgtm[js/path-injection] -- runId+name validated; path canonicalized.
  await atomicWriteFile(file, content);
  const bytes = Buffer.byteLength(content);

  const state = params.appConfig?._workflowState;
  if (state && state.data) {
    state.data._agent = state.data._agent || {};
    state.data._agent.artifacts = state.data._agent.artifacts || [];
    state.data._agent.artifacts.push({
      name: safeName,
      writtenAt: new Date().toISOString(),
      bytes,
      contentType
    });
  }
  emit(
    'agent.artifact.written',
    { profileId: user.profileId, runId, name: safeName, bytes, contentType },
    params.chatId
  );
  return { ok: true, name: safeName, bytes };
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
