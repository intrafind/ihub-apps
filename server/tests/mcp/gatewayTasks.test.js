// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeEach } from '@jest/globals';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { McpTaskStore, MCP_TASK_TTL_MS, taskWireShape } from '../../services/mcp/mcpTaskStore.js';
import {
  attachGatewayTasks,
  clientAcceptsTasks,
  startGatewayTask,
  TASKS_EXTENSION_ID
} from '../../services/mcp/gatewayTasks.js';

/**
 * The MCP Tasks extension on the gateway: a long run answers with a task
 * handle to a client that declared the extension, and the client polls
 * `tasks/get` for the outcome. Driven with raw 2026-07-28 requests, the shape
 * an MCP host sends.
 */

/** An in-memory document store with the provider's interface. */
function memoryDocuments() {
  const data = new Map();
  return {
    data,
    async get(namespace, key) {
      const value = data.get(`${namespace}/${key}`);
      return value ? { key, data: structuredClone(value.data) } : null;
    },
    async put(namespace, key, value, { ownerId } = {}) {
      data.set(`${namespace}/${key}`, { data: structuredClone(value), ownerId });
    },
    async delete(namespace, key) {
      return data.delete(`${namespace}/${key}`);
    },
    async list(namespace) {
      const items = [...data.entries()]
        .filter(([id]) => id.startsWith(`${namespace}/`))
        .map(([id, value]) => ({ key: id.slice(namespace.length + 1), data: value.data }));
      return { items, nextCursor: null };
    }
  };
}

const alice = { id: 'alice' };
const mallory = { id: 'mallory' };

describe('McpTaskStore', () => {
  let store;
  let clock;

  beforeEach(() => {
    clock = Date.parse('2026-11-26T10:00:00Z');
    store = new McpTaskStore({
      documents: memoryDocuments(),
      now: () => clock,
      relayCancel: false
    });
  });

  it('shows a task to its owner only', async () => {
    const task = await store.create({ ownerId: 'alice', toolName: 'app__chat' });
    expect(task.status).toBe('working');
    expect(await store.get(task.taskId, 'alice')).toMatchObject({ taskId: task.taskId });
    expect(await store.get(task.taskId, 'mallory')).toBeNull();
    expect(await store.cancel(task.taskId, 'mallory')).toBeNull();
  });

  it('records the result of a finished run, or its error', async () => {
    const done = await store.create({ ownerId: 'alice', toolName: 'app__chat' });
    const result = { content: [{ type: 'text', text: 'hi' }] };
    await store.finish(done.taskId, { result });
    expect(taskWireShape(await store.get(done.taskId, 'alice'))).toMatchObject({
      status: 'completed',
      result,
      ttlMs: MCP_TASK_TTL_MS
    });

    const failed = await store.create({ ownerId: 'alice', toolName: 'app__chat' });
    await store.finish(failed.taskId, { error: { code: -32603, message: 'boom' } });
    const wire = taskWireShape(await store.get(failed.taskId, 'alice'));
    expect(wire).toMatchObject({ status: 'failed', error: { code: -32603, message: 'boom' } });
    expect(wire.pollIntervalMs).toBeUndefined();
  });

  it('keeps a cancel when the run finishes afterwards', async () => {
    const task = await store.create({ ownerId: 'alice', toolName: 'app__chat' });
    const controller = new AbortController();
    store.registerRun(task.taskId, controller);
    await store.cancel(task.taskId, 'alice');
    expect(controller.signal.aborted).toBe(true);
    await store.finish(task.taskId, { result: { content: [] } });
    expect((await store.get(task.taskId, 'alice')).status).toBe('cancelled');
  });

  it('drops tasks past their time to live', async () => {
    const task = await store.create({ ownerId: 'alice', toolName: 'app__chat' });
    clock += MCP_TASK_TTL_MS - 1;
    expect(await store.sweep()).toBe(0);
    clock += 2;
    expect(await store.sweep()).toBe(1);
    expect(await store.get(task.taskId, 'alice')).toBeNull();
  });
});

describe('Tasks extension over 2026-07-28', () => {
  let store;
  let release;

  const buildServer = user => {
    const server = new McpServer(
      { name: 'test', version: '0.0.0' },
      { capabilities: { tools: { listChanged: false } } }
    );
    server.registerTool(
      'app__slow',
      { description: 'slow', inputSchema: z.object({}) },
      (_a, ctx) =>
        clientAcceptsTasks(ctx)
          ? startGatewayTask({
              user,
              toolName: 'app__slow',
              store,
              run: () =>
                new Promise(resolve => {
                  release = () => resolve({ content: [{ type: 'text', text: 'done' }] });
                })
            })
          : { content: [{ type: 'text', text: 'done right away' }] }
    );
    attachGatewayTasks(server, { user, store });
    return server;
  };

  // The caller as the gateway's auth hands it over (`authInfo.extra.user`).
  const handler = createMcpHandler(({ authInfo }) => buildServer(authInfo.extra.user), {
    legacy: 'reject'
  });

  let id = 0;
  async function rpc(method, params, { user = alice, tasks = true, name } = {}) {
    const request = new Request('http://gateway.test/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'host', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': tasks
              ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
              : {}
          }
        }
      })
    });
    const response = await handler.fetch(request, {
      authInfo: { token: '', clientId: user.id, scopes: [], extra: { user } }
    });
    return response.json();
  }

  beforeEach(() => {
    store = new McpTaskStore({ documents: memoryDocuments(), relayCancel: false });
  });

  it('advertises the extension', async () => {
    const discover = await rpc('server/discover', {});
    expect(discover.result.capabilities.extensions).toHaveProperty([TASKS_EXTENSION_ID]);
  });

  it('answers a client that takes tasks with a handle, then the result on tasks/get', async () => {
    const call = await rpc(
      'tools/call',
      { name: 'app__slow', arguments: {} },
      { name: 'app__slow' }
    );
    expect(call.result).toMatchObject({ resultType: 'task', status: 'working' });
    const { taskId } = call.result;
    expect(call.result.pollIntervalMs).toBeGreaterThan(0);

    const running = await rpc('tasks/get', { taskId }, { name: taskId });
    expect(running.result).toMatchObject({ taskId, status: 'working' });

    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    const done = await rpc('tasks/get', { taskId }, { name: taskId });
    expect(done.result).toMatchObject({
      taskId,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }] }
    });
  });

  it('runs the call as before for a client that did not declare the extension', async () => {
    const call = await rpc(
      'tools/call',
      { name: 'app__slow', arguments: {} },
      { tasks: false, name: 'app__slow' }
    );
    expect(call.result.resultType).toBe('complete');
    expect(call.result.content).toEqual([{ type: 'text', text: 'done right away' }]);
  });

  it("hides one caller's task from another and cancels on request", async () => {
    const call = await rpc(
      'tools/call',
      { name: 'app__slow', arguments: {} },
      { name: 'app__slow' }
    );
    const { taskId } = call.result;

    const foreign = await rpc('tasks/get', { taskId }, { user: mallory, name: taskId });
    expect(foreign.error.code).toBe(-32602);
    const foreignCancel = await rpc('tasks/cancel', { taskId }, { user: mallory, name: taskId });
    expect(foreignCancel.error.code).toBe(-32602);

    const cancel = await rpc('tasks/cancel', { taskId }, { name: taskId });
    expect(cancel.error).toBeUndefined();
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    const after = await rpc('tasks/get', { taskId }, { name: taskId });
    expect(after.result.status).toBe('cancelled');
  });
});
