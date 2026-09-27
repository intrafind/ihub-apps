import { describe, it, expect } from '@jest/globals';
import { dispatchA2A } from '../../services/mcp/a2aHandler.js';

const platform = {
  defaultLanguage: 'en',
  mcpServer: { expose: { tools: true, apps: true, workflows: true } }
};

describe('A2A dispatcher', () => {
  it('rejects non-jsonrpc messages with -32600', async () => {
    const r = await dispatchA2A({ method: 'message/send' }, { user: { id: 'u' }, platform });
    expect(r.error.code).toBe(-32600);
  });

  it('returns -32601 for unknown methods', async () => {
    const r = await dispatchA2A(
      { jsonrpc: '2.0', id: 1, method: 'agent/unknown', params: {} },
      { user: { id: 'u', scopes: [] }, platform }
    );
    expect(r.error.code).toBe(-32601);
  });

  it('returns -32601 for the removed pre-0.3 draft methods', async () => {
    for (const method of ['agent/info', 'agent/skills', 'tasks/send']) {
      const r = await dispatchA2A(
        { jsonrpc: '2.0', id: 1, method, params: { skillId: 'app__chat' } },
        { user: { id: 'u', scopes: ['mcp:apps:invoke'] }, platform }
      );
      expect(r.error.code).toBe(-32601);
    }
  });
});
