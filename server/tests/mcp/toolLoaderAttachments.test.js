import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * `_attachments` carries the current message's files with their bytes, for
 * MCP tools with file inputs (#2543). runTool must hand it to MCP tools only:
 * app-as-tool would otherwise turn it into a variable or even the callee's
 * prompt text, and remote A2A agents or local scripts would receive the bytes.
 */

const mcpCallTool = jest.fn(async () => ({ ok: 'mcp' }));
const a2aCallTool = jest.fn(async () => ({ ok: 'a2a' }));
const invokeAppTool = jest.fn(async () => ({ ok: 'app' }));

const mcpTool = { id: 'files__upload', _mcp: { serverId: 'files' } };
const a2aTool = { id: 'a2a__agent__ask', _a2a: { agentId: 'agent' } };

jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getTools: () => ({ data: [] }),
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getWorkflows: () => ({ data: [] })
  }
}));
jest.unstable_mockModule('../../services/mcp/McpClientManager.js', () => ({
  default: { callTool: mcpCallTool, listAllTools: async () => [mcpTool] }
}));
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({
  default: { callTool: a2aCallTool, listAllTools: async () => [a2aTool] }
}));
jest.unstable_mockModule('../../services/chat/appToolsGateway.js', () => ({ invokeAppTool }));

const { runTool } = await import('../../toolLoader.js');

const attachments = [{ fileName: 'report.pdf', mimeType: 'application/pdf', base64: 'data:...' }];
const base = { chatId: 'c1', user: { id: 'alice' }, appConfig: { id: 'chat' }, language: 'en' };

beforeEach(() => {
  mcpCallTool.mockClear();
  a2aCallTool.mockClear();
  invokeAppTool.mockClear();
});

describe('runTool attachments', () => {
  it('hands the attachments to MCP tools', async () => {
    await runTool(mcpTool.id, { ...base, file: 'report.pdf', _attachments: attachments });
    expect(mcpCallTool.mock.calls[0][1]).toMatchObject({
      file: 'report.pdf',
      _attachments: attachments
    });
  });

  it('keeps them away from app-as-tool and A2A agent tools', async () => {
    await runTool('app__summary', { ...base, message: 'sum up', _attachments: attachments });
    expect(invokeAppTool.mock.calls[0][0].args).toEqual({ message: 'sum up' });

    await runTool(a2aTool.id, { ...base, message: 'hi', _attachments: attachments });
    expect(a2aCallTool.mock.calls[0][1]).not.toHaveProperty('_attachments');
  });

  it('leaves an MCP call without attachments unchanged', async () => {
    await runTool(mcpTool.id, { ...base, file: 'x' });
    expect(mcpCallTool.mock.calls[0][1]).not.toHaveProperty('_attachments');
  });
});
