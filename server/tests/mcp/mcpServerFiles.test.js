// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FilesystemStorageProvider } from '../../storage/index.js';

/**
 * MCP server (`/api/mcp`): `app__<id>` and `workflow__<id>` tools take an
 * optional `files` input, ingested into the invocation's chat, and an app's
 * generated files and pictures come back as standard MCP content blocks
 * (embedded `resource` with a base64 `blob`, `image`) next to the text block.
 * Driven through the real gateway over an in-memory transport.
 */

const invokeAppInternal = jest.fn();
jest.unstable_mockModule('../../services/chat/ChatService.js', () => ({
  __esModule: true,
  default: class ChatServiceMock {
    invokeAppInternal(opts) {
      return invokeAppInternal(opts);
    }
  }
}));

const runTool = jest.fn();
jest.unstable_mockModule('../../services/tools/appTools.js', () => ({
  getToolsForApp: jest.fn(async () => []),
  MAX_SKILL_NAME_ENUM: 100
}));
jest.unstable_mockModule('../../services/tools/catalog.js', () => ({
  loadTools: jest.fn(async () => []),
  discoverMcpTools: jest.fn(async () => []),
  localizeTools: jest.fn(tools => tools),
  discoverA2aTools: jest.fn(async () => [])
}));
jest.unstable_mockModule('../../services/tools/runTool.js', () => ({
  runTool
}));
jest.unstable_mockModule('../../services/tools/webSearchResolver.js', () => ({
  resolveNativeWebSearchProvider: jest.fn(() => null),
  resolveAppNativeWebSearch: jest.fn(() => null),
  DEFAULT_NATIVE_WEB_SEARCH_MAX_USES: 5,
  NATIVE_SEARCH_WITH_PAGE_READER: new Set(),
  NATIVE_WEB_SEARCH_FALLBACK_ENGINE: 'auto',
  READ_URL_TOOL_ID: 'read_url',
  resolveWebSearchEngine: jest.fn(() => null),
  resolveWebSearchEngineTool: jest.fn(() => null),
  resolveWebSearchEngineToolId: jest.fn(async () => null),
  isWebSearchAvailableTo: jest.fn(() => false),
  describeWebSearchAvailability: jest.fn(async () => ({})),
  resolveNativeWebSearchFallbackTools: jest.fn(async () => [])
}));

// The chat files live in a temp directory.
const actualRepo = await import('../../services/chatFiles/ChatFileRepository.js');
let repo;
jest.unstable_mockModule('../../services/chatFiles/ChatFileRepository.js', () => ({
  ...actualRepo,
  getChatFileRepository: () => repo
}));

const { default: configCache } = await import('../../configCache.js');
configCache.setCacheEntry('config/apps.json', [
  { id: 'reader', name: { en: 'Reader' }, description: { en: 'Reads files' }, enabled: true }
]);
configCache.setCacheEntry('config/workflows.json', [
  {
    id: 'review',
    name: { en: 'Review' },
    enabled: true,
    chatIntegration: { enabled: true },
    nodes: [{ id: 'start', type: 'start', config: { inputVariables: [] } }],
    edges: []
  }
]);

const { buildMcpServer, buildAppInputSchema, buildWorkflowMcpParams, appToolResult } =
  await import('../../services/mcp/McpServerService.js');
const { MCP_SCOPES } = await import('../../services/mcp/scopes.js');

const user = {
  id: 'alice',
  scopes: [MCP_SCOPES.APPS_INVOKE, MCP_SCOPES.WORKFLOWS_RUN],
  permissions: { apps: new Set(['reader']), workflows: new Set(['review']) }
};

let tmpDir;
let provider;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-mcp-files-'));
  provider = new FilesystemStorageProvider({ baseDir: tmpDir });
  await provider.initialize();
  repo = new actualRepo.ChatFileRepository({
    documents: provider.documents,
    blobs: provider.blobs
  });
});
afterAll(async () => {
  await provider?.shutdown?.();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function connect() {
  const platform = {
    defaultLanguage: 'en',
    mcpServer: { expose: { tools: false, apps: true, workflows: true, resources: false } }
  };
  const server = await buildMcpServer({ user, platform });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const answer = (extra = {}) => ({
  status: 'ok',
  runId: 'run-1',
  finalMessage: { role: 'assistant', content: 'done' },
  toolCalls: [],
  generatedFiles: [],
  images: [],
  model: 'm1',
  ...extra
});

beforeEach(() => {
  invokeAppInternal.mockReset();
  invokeAppInternal.mockResolvedValue(answer());
  runTool.mockReset();
});

describe('the files input of app and workflow tools', () => {
  it('is advertised on both tools and stays optional', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ['app__reader', 'workflow__review']) {
      const tool = tools.find(t => t.name === name);
      expect(tool.inputSchema.properties.files).toMatchObject({ type: 'array' });
      expect(Object.keys(tool.inputSchema.properties.files.items.properties)).toEqual(
        expect.arrayContaining(['name', 'mimeType', 'data', 'text'])
      );
      expect(tool.inputSchema.required).not.toContain('files');
    }
    expect(buildAppInputSchema({ id: 'x' }).properties.files).toBeDefined();
    expect(buildWorkflowMcpParams({ id: 'w' }).properties.files).toBeDefined();
  });

  it('is ingested into the invocation chat and handed to the app as fileData', async () => {
    const client = await connect();
    const text = 'Quarterly numbers\nrevenue,42\n';
    const result = await client.callTool({
      name: 'app__reader',
      arguments: {
        message: 'Summarize the file',
        files: [
          { name: 'q3.csv', mimeType: 'text/csv', data: Buffer.from(text).toString('base64') }
        ]
      }
    });
    expect(result.isError).toBeFalsy();
    expect(invokeAppInternal).toHaveBeenCalledTimes(1);
    const call = invokeAppInternal.mock.calls[0][0];
    expect(typeof call.chatId).toBe('string');
    const last = call.messages.at(-1);
    expect(last.content).toBe('Summarize the file');
    // one file arrives as one entry, the way a chat upload does
    expect(last.fileData).toMatchObject({ fileName: 'q3.csv', origin: 'mcp' });
    expect(last.fileData.content).toContain('revenue,42');
    expect(last.fileIds).toBeUndefined();
    // `files` is not a prompt variable
    expect(call.variables.files).toBeUndefined();

    const stored = await repo.list({ type: 'chat', id: call.chatId });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'q3.csv', origin: 'mcp' });
  });

  it('accepts a text file as well as base64', async () => {
    const client = await connect();
    await client.callTool({
      name: 'app__reader',
      arguments: { message: 'Read it', files: [{ name: 'note.md', text: '# Note\nhello' }] }
    });
    const last = invokeAppInternal.mock.calls[0][0].messages.at(-1);
    expect(last.fileData.content).toContain('hello');
  });

  it('without files nothing changes: no chat id, no file data', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'app__reader', arguments: { message: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    const call = invokeAppInternal.mock.calls[0][0];
    expect(call.chatId).toBeUndefined();
    expect(call.messages.at(-1).fileData).toBeUndefined();
  });

  it('fails soft on invalid, oversized and unsupported files: an error result, no app run', async () => {
    const client = await connect();
    const cases = [
      [{ name: 'a.csv', data: 'not base64 !!' }, /not valid base64/],
      [{ name: 'a.csv', data: 'A'.repeat(36 * 1024 * 1024) }, /larger than 25 MB/],
      [{ name: 'a.csv' }, /needs "data"/],
      [{ data: 'aGk=' }, /files\[0\]\.name/],
      [{ name: 'pic.png', mimeType: 'image/png', data: PNG_B64 }, /unsupported type/]
    ];
    for (const [file, pattern] of cases) {
      const result = await client.callTool({
        name: 'app__reader',
        arguments: { message: 'x', files: [file] }
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(pattern);
    }
    expect(invokeAppInternal).not.toHaveBeenCalled();
  });

  it('is handed to a workflow as its uploaded files', async () => {
    runTool.mockResolvedValue({
      status: 'completed',
      executionId: 'e1',
      output: { output: 'ok' },
      outputText: 'ok'
    });
    const client = await connect();
    const result = await client.callTool({
      name: 'workflow__review',
      arguments: {
        input: 'check it',
        files: [{ name: 'draft.md', text: 'The draft says hello' }]
      }
    });
    expect(result.isError).toBeFalsy();
    const [toolId, params] = runTool.mock.calls[0];
    expect(toolId).toBe('workflow_review');
    expect(params.files).toBeUndefined();
    expect(params.user).toBe(user);
    expect(params._fileData).toHaveLength(1);
    expect(params._fileData[0].content).toContain('hello');
    expect(typeof params.chatId).toBe('string');
  });
});

describe('what an app returns over MCP', () => {
  it('is its text, then every generated file as an embedded resource and every picture as an image', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake');
    invokeAppInternal.mockResolvedValue(
      answer({
        generatedFiles: [
          {
            id: 'a'.repeat(32),
            name: 'Report.pdf',
            mimeType: 'application/pdf',
            bytes: pdf.length,
            data: pdf.toString('base64')
          }
        ],
        images: [{ mimeType: 'image/png', data: PNG_B64 }]
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'app__reader',
      arguments: { message: 'make it' }
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({ type: 'text', text: 'done' });
    expect(result.content[1]).toMatchObject({
      type: 'resource',
      resource: { mimeType: 'application/pdf', blob: pdf.toString('base64') }
    });
    expect(result.content[1].resource.uri).toMatch(/^ihub:\/\/generated\/.+\/Report\.pdf$/);
    expect(result.content[2]).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/png' });
    // nothing is serialized into the text block
    expect(result.content[0].text).not.toContain(PNG_B64);
  });

  it('appToolResult skips entries without bytes', () => {
    expect(
      appToolResult('t', { generatedFiles: [{ name: 'x', mimeType: 'text/plain' }], images: [{}] })
    ).toEqual({ content: [{ type: 'text', text: 't' }] });
  });
});
