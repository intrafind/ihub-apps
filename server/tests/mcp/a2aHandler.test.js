import { describe, it, expect } from '@jest/globals';
import { dispatchA2A } from '../../services/mcp/a2aHandler.js';

const platform = {
  defaultLanguage: 'en',
  mcpServer: { expose: { tools: true, apps: true, workflows: true } }
};

describe('A2A dispatcher', () => {
  it('agent/info returns capability + scopes', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'agent/info' },
      { user: { id: 'u', scopes: [] }, platform }
    );
    expect(r.jsonrpc).toBe('2.0');
    expect(r.id).toBe(1);
    expect(r.result.name).toBe('ihub-apps');
    expect(r.result.auth.scopes).toHaveLength(5);
  });

  it('rejects non-jsonrpc messages with -32600', async () => {
    const r = await dispatchA2A({ method: 'agent/info' }, { user: { id: 'u' }, platform });
    expect(r.error.code).toBe(-32600);
  });

  it('returns -32601 for unsupported methods', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} },
      { user: { id: 'u', scopes: [] }, platform }
    );
    expect(r.error.code).toBe(-32601);
  });

  it('tasks/send requires skillId', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: {} },
      { user: { id: 'u', scopes: ['mcp:tools:call'] }, platform }
    );
    expect(r.error.code).toBe(-32602);
  });

  it('tasks/send enforces tool scope for raw tool ids', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { skillId: 'someTool' } },
      { user: { id: 'u', scopes: [] }, platform }
    );
    expect(r.error.message).toMatch(/insufficient_scope/);
  });

  it('tasks/send enforces app scope for app__ prefix', async () => {
    const r = await dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { skillId: 'app__chat', input: { message: 'hi' } }
      },
      { user: { id: 'u', scopes: ['mcp:tools:call'] }, platform }
    );
    expect(r.error.message).toMatch(/mcp:apps:invoke/);
  });

  it('tasks/send enforces workflow scope for workflow__ prefix', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { skillId: 'workflow__wf1' } },
      { user: { id: 'u', scopes: ['mcp:tools:call'] }, platform }
    );
    expect(r.error.message).toMatch(/mcp:workflows:run/);
  });

  it('tasks/send rejects path-traversal in app skillId', async () => {
    const r = await dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { skillId: 'app__../etc/passwd' }
      },
      { user: { id: 'u', scopes: ['mcp:apps:invoke'] }, platform }
    );
    expect(r.error.code).toBe(-32602);
  });

  it('tasks/send rejects path-traversal in workflow skillId', async () => {
    const r = await dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { skillId: 'workflow__../wf' }
      },
      { user: { id: 'u', scopes: ['mcp:workflows:run'] }, platform }
    );
    expect(r.error.code).toBe(-32602);
  });

  it('tasks/send rejects path-traversal in raw tool skillId', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { skillId: '../etc/passwd' } },
      { user: { id: 'u', scopes: ['mcp:tools:call'] }, platform }
    );
    expect(r.error.code).toBe(-32602);
  });

  it('tasks/send refuses the read_skill_resource meta-tool (no app grants it)', async () => {
    const r = await dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          skillId: 'read_skill_resource',
          input: { skill_name: 'x', file_path: '../../etc/passwd' }
        }
      },
      {
        user: {
          id: 'u',
          scopes: ['mcp:tools:call'],
          permissions: { apps: new Set(), workflows: new Set() }
        },
        platform
      }
    );
    expect(r.error.code).toBe(-32004);
    expect(r.error.message).toMatch(/not permitted/);
  });

  it('tasks/send denies a tool not granted by any accessible app', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { skillId: 'braveSearch' } },
      {
        user: {
          id: 'u',
          scopes: ['mcp:tools:call'],
          permissions: { apps: new Set(), workflows: new Set() }
        },
        platform
      }
    );
    expect(r.error.code).toBe(-32004);
  });

  it('tasks/send denies a workflow the caller has no permission for', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { skillId: 'workflow__secret' } },
      {
        user: {
          id: 'u',
          scopes: ['mcp:workflows:run'],
          permissions: { workflows: new Set() }
        },
        platform
      }
    );
    expect(r.error.code).toBe(-32004);
  });
});
