// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP Tasks extension (`io.modelcontextprotocol/tasks`) on the inbound
 * gateway: a long-running `tools/call` (an app or workflow run) answers with a
 * task handle instead of holding the request open, and the client polls
 * `tasks/get` for the outcome.
 *
 * A task is only ever returned to a client that declared the extension in the
 * request's client capabilities (2026-07-28 per-request `_meta` envelope); every
 * other caller gets the ordinary result, as before. The store is
 * `mcpTaskStore.js`.
 *
 * @module services/mcp/gatewayTasks
 */
import * as z from 'zod/v4';
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode
} from '@modelcontextprotocol/server';
import { getMcpTaskStore, taskWireShape } from './mcpTaskStore.js';
import logger from '../../utils/logger.js';

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

const COMPONENT = 'McpGatewayTasks';

/** JSON-RPC internal error, the code a failed task reports. */
const INTERNAL_ERROR = -32603;

const taskParams = z.looseObject({ taskId: z.string().min(1).max(128) });

/**
 * Whether the client of this request takes a task handle as the answer.
 *
 * @param {Object} ctx - The SDK's request context
 * @returns {boolean}
 */
export function clientAcceptsTasks(ctx) {
  const capabilities = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY];
  const extension = capabilities?.extensions?.[TASKS_EXTENSION_ID];
  return Boolean(extension) && typeof extension === 'object';
}

function unknownTask(taskId) {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task: ${taskId}`);
}

/**
 * Serve `tasks/get`, `tasks/update` and `tasks/cancel` for one caller and
 * declare the extension. Only a caller's own tasks are found; anyone else's
 * task id is answered as unknown.
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {Object} params
 * @param {Object} params.user - The authenticated caller
 * @param {import('./mcpTaskStore.js').McpTaskStore} [params.store]
 */
export function attachGatewayTasks(server, { user, store = getMcpTaskStore() }) {
  const low = server.server;
  low.setRequestHandler('tasks/get', { params: taskParams }, async ({ taskId }) => {
    const record = await store.get(taskId, user.id);
    if (!record) throw unknownTask(taskId);
    return taskWireShape(record);
  });
  // The gateway's tasks never ask for input (`input_required`), so there is
  // never an outstanding request to answer: the update is acknowledged and
  // ignored, as the extension says for keys it does not know.
  low.setRequestHandler('tasks/update', { params: taskParams }, async ({ taskId }) => {
    if (!(await store.get(taskId, user.id))) throw unknownTask(taskId);
    return {};
  });
  low.setRequestHandler('tasks/cancel', { params: taskParams }, async ({ taskId }) => {
    if (!(await store.cancel(taskId, user.id))) throw unknownTask(taskId);
    return {};
  });
  low.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
}

/**
 * Start a run as a task and answer with its handle. The run goes on after the
 * request ends; its outcome is recorded on the task. A run that throws fails
 * the task; a tool result with `isError` completes it, as the result it is.
 *
 * @param {Object} params
 * @param {Object} params.user - The caller who owns the task
 * @param {string} params.toolName - The tool the run belongs to
 * @param {(signal: AbortSignal) => Promise<Object>} params.run - Produces the tool result
 * @param {import('./mcpTaskStore.js').McpTaskStore} [params.store]
 * @returns {Promise<Object>} The `tools/call` answer (`resultType: "task"`)
 */
export async function startGatewayTask({ user, toolName, run, store = getMcpTaskStore() }) {
  const record = await store.create({ ownerId: user.id, toolName, statusMessage: 'Running' });
  const controller = new AbortController();
  store.registerRun(record.taskId, controller);
  logger.info('MCP gateway task started', {
    component: COMPONENT,
    taskId: record.taskId,
    tool: toolName,
    userId: user.id
  });

  (async () => {
    let outcome;
    try {
      outcome = { result: await run(controller.signal) };
    } catch (error) {
      outcome = {
        error: { code: INTERNAL_ERROR, message: error?.message || 'The run failed' }
      };
    } finally {
      store.releaseRun(record.taskId);
    }
    // A cancel recorded `cancelled` already; the run's outcome is dropped.
    if (controller.signal.aborted) return;
    const finished = await store.finish(record.taskId, outcome);
    logger.info('MCP gateway task finished', {
      component: COMPONENT,
      taskId: record.taskId,
      tool: toolName,
      status: finished?.status
    });
  })().catch(error =>
    logger.error('MCP gateway task could not record its outcome', {
      component: COMPONENT,
      taskId: record.taskId,
      error: error.message
    })
  );

  return { resultType: 'task', ...taskWireShape(record) };
}
