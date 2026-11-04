// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemStorageProvider } from '../../storage/index.js';

/**
 * A2A client with files: `fileIds` of the chat are forwarded as `FilePart`s,
 * and `FilePart`s a remote agent returns (inline `bytes` or a `uri`, in
 * artifacts, the status message or a direct reply) are stored in the chat and
 * reach the model only as compact descriptors — never as base64.
 */

const requests = [];
const agents = {}; // host -> { card, reply(method, body), files: { path: {body, type} } }

jest.unstable_mockModule('../../services/mcp/safeFetch.js', () => ({
  assertSafeHost: jest.fn(async () => {}),
  safeFetch: jest.fn(async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({
      host: u.host,
      path: u.pathname,
      method: init.method,
      body,
      headers: init.headers
    });
    const agent = agents[u.host];
    if (!agent) return new Response('no agent', { status: 502 });
    if (u.pathname.endsWith('agent-card.json')) return Response.json(agent.card);
    if (agent.files?.[u.pathname]) {
      const file = agent.files[u.pathname];
      return new Response(file.body, {
        status: file.status || 200,
        headers: { 'content-type': file.type || 'application/octet-stream' }
      });
    }
    const result = agent.reply(body.method, body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  })
}));
jest.unstable_mockModule('../../services/CredentialService.js', () => ({
  default: { resolveSecret: ref => `secret-of-${ref}` }
}));
jest.unstable_mockModule('../../services/loop/RunStream.js', () => ({
  emitToolProgress: () => {}
}));

const actualRepo = await import('../../services/chatFiles/ChatFileRepository.js');
let repo;
jest.unstable_mockModule('../../services/chatFiles/ChatFileRepository.js', () => ({
  ...actualRepo,
  getChatFileRepository: () => repo
}));

const { default: manager } = await import('../../services/a2a/A2aClientManager.js');
const { A2aClientContextStore } = await import('../../services/a2a/a2aClientContextStore.js');
const { scratchDocuments } = await import('../helpers/testStorage.js');
const scratch = await scratchDocuments();
manager.contexts = new A2aClientContextStore({ documents: scratch.documents });
const { buildSkillTools, partsFiles, StreamCollector, A2A_ACCEPTED_OUTPUT_MODES } =
  await import('../../services/a2a/a2aTools.js');
const { chatFilesToSend } = await import('../../services/a2a/a2aFiles.js');
const { chatToolSeam } = await import('../../services/chat/chatSeams.js');
const { clearHeldToolImages } = await import('../../services/chat/toolOutputFiles.js');
const { clearHeldGeneratedFiles } = await import('../../services/documents/generatedFiles.js');

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const CSV = 'city,pop\nBerlin,3.7\n';
const user = { id: 'alice', permissions: {} };
const chat = { type: 'chat', id: 'chat-1' };
const TOOL = 'a2a__one__ask';

let tmpDir;
let provider;
let replyParts;
let replyKind;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-a2a-client-files-'));
  provider = new FilesystemStorageProvider({ baseDir: tmpDir });
  await provider.initialize();
  repo = new actualRepo.ChatFileRepository({
    documents: provider.documents,
    blobs: provider.blobs
  });
});
afterAll(async () => {
  await manager.shutdown();
  await provider?.shutdown?.();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  requests.length = 0;
  clearHeldToolImages();
  clearHeldGeneratedFiles();
  replyParts = [{ kind: 'text', text: 'ok' }];
  replyKind = 'message';
  agents['one.example'] = {
    card: {
      name: 'one',
      url: 'https://one.example/a2a',
      protocolVersion: '0.3.0',
      capabilities: { streaming: false },
      skills: [{ id: 'ask', name: 'Ask' }]
    },
    files: {},
    reply: (method, body) => {
      if (replyKind === 'task') {
        return {
          kind: 'task',
          id: 't1',
          contextId: 'c1',
          status: { state: 'completed' },
          artifacts: [{ artifactId: 'a1', parts: replyParts }]
        };
      }
      if (replyKind === 'status') {
        return {
          kind: 'task',
          id: 't1',
          contextId: 'c1',
          status: {
            state: 'completed',
            message: { kind: 'message', role: 'agent', messageId: 'x', parts: replyParts }
          }
        };
      }
      return {
        kind: 'message',
        role: 'agent',
        messageId: 'm',
        contextId: body.params.message.contextId || 'c1',
        parts: replyParts
      };
    }
  };
  await manager.shutdown();
  await manager.initialize({
    agents: [
      {
        id: 'one',
        name: { en: 'Agent one' },
        cardUrl: 'https://one.example/.well-known/agent-card.json'
      }
    ]
  });
});

async function seedChatFile(name, mimeType, bytes, text) {
  return repo.put(chat, {
    ownerId: 'alice',
    name,
    mimeType,
    text: text ?? bytes.toString('utf8'),
    originalBuffer: bytes,
    origin: 'upload'
  });
}

const call = (extra = {}) =>
  manager.callTool(TOOL, { message: 'please look', chatId: 'chat-1', user, ...extra });

describe('the tool schema', () => {
  it('offers optional fileIds beside message and data', () => {
    const { tools } = buildSkillTools(
      { id: 'one', allowedSkills: ['*'] },
      { skills: [{ id: 'ask' }] }
    );
    const { properties, required } = tools[0].parameters;
    expect(properties.fileIds).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(required).toEqual(['message']);
  });

  it('tells agents iHub accepts files and pictures', () => {
    expect(A2A_ACCEPTED_OUTPUT_MODES.slice(0, 2)).toEqual(['text/plain', 'application/json']);
    expect(A2A_ACCEPTED_OUTPUT_MODES).toEqual(
      expect.arrayContaining(['application/pdf', 'image/png', 'application/zip'])
    );
  });
});

describe('forwarding chat files (fileIds)', () => {
  it('sends the stored original as a file part, never iHub context', async () => {
    const original = Buffer.from(CSV);
    const stored = await seedChatFile('cities.csv', 'text/csv', original);
    const answer = await call({ fileIds: [stored.id] });
    expect(answer).toBe('ok');
    const rpc = requests.find(r => r.body?.method === 'message/send');
    expect(rpc.body.params.message.parts).toEqual([
      { kind: 'text', text: 'please look' },
      {
        kind: 'file',
        file: { name: 'cities.csv', mimeType: 'text/csv', bytes: original.toString('base64') }
      }
    ]);
    expect(JSON.stringify(rpc.body)).not.toMatch(/alice|chat-1/);
    expect(rpc.body.params.configuration.acceptedOutputModes).toContain('application/pdf');
  });

  it('falls back to the extracted text when the original was not kept', async () => {
    const stored = await repo.put(chat, {
      ownerId: 'alice',
      name: 'letter.pdf',
      mimeType: 'application/pdf',
      text: 'Dear all, the extracted text',
      origin: 'upload'
    });
    await call({ fileIds: [stored.id] });
    const rpc = requests.find(r => r.body?.method === 'message/send');
    const file = rpc.body.params.message.parts[1].file;
    expect(file).toMatchObject({ name: 'letter.pdf.txt', mimeType: 'text/plain' });
    expect(Buffer.from(file.bytes, 'base64').toString()).toBe('Dear all, the extracted text');
  });

  it('refuses ids that are not files of this chat, and too many files', async () => {
    const other = await repo.put(
      { type: 'chat', id: 'chat-2' },
      { ownerId: 'bob', name: 'x.txt', mimeType: 'text/plain', text: 'secret', origin: 'upload' }
    );
    await expect(call({ fileIds: [other.id] })).rejects.toThrow(/not found in this chat/);
    await expect(call({ fileIds: ['file_nope'] })).rejects.toThrow(/not found in this chat/);
    await expect(call({ fileIds: 'x' })).rejects.toThrow(/array/);
    await expect(call({ fileIds: Array.from({ length: 11 }, (_, i) => `f${i}`) })).rejects.toThrow(
      /At most 10/
    );
    await expect(
      chatFilesToSend({ fileIds: ['a'], chatId: undefined }, { store: repo })
    ).rejects.toThrow(/from a chat/);
    expect(requests.find(r => r.body?.method === 'message/send')).toBeUndefined();
  });

  it('sends nothing extra without fileIds', async () => {
    await call();
    const rpc = requests.find(r => r.body?.method === 'message/send');
    expect(rpc.body.params.message.parts).toEqual([{ kind: 'text', text: 'please look' }]);
  });
});

describe('files an agent returns', () => {
  it('are read from file parts of a direct reply, artifacts and the status message', () => {
    expect(
      partsFiles([
        { kind: 'text', text: 't' },
        { kind: 'file', file: { name: 'a', bytes: 'QQ==' } },
        { kind: 'file', file: { uri: 'https://x/y' } },
        { kind: 'file', file: {} },
        { kind: 'file' }
      ])
    ).toEqual([{ name: 'a', bytes: 'QQ==' }, { uri: 'https://x/y' }]);
    const collector = new StreamCollector();
    collector.add({ kind: 'task', id: 't', contextId: 'c', status: { state: 'working' } });
    collector.add({
      kind: 'artifact-update',
      taskId: 't',
      contextId: 'c',
      artifact: { artifactId: 'a', parts: [{ kind: 'file', file: { name: 'f', bytes: 'QQ==' } }] }
    });
    expect(collector.files()).toEqual([{ name: 'f', bytes: 'QQ==' }]);
  });

  it('are stored in the chat and described compactly; the bytes never reach the model', async () => {
    replyKind = 'task';
    replyParts = [
      { kind: 'text', text: 'Here is the data' },
      {
        kind: 'file',
        file: { name: 'out.csv', mimeType: 'text/csv', bytes: Buffer.from(CSV).toString('base64') }
      },
      { kind: 'file', file: { name: 'chart.png', mimeType: 'image/png', bytes: PNG_B64 } }
    ];
    const answer = await call();
    expect(typeof answer).toBe('object');
    expect(answer.text).toBe('Here is the data');
    expect(JSON.stringify(answer)).not.toContain(PNG_B64);
    expect(JSON.stringify(answer)).not.toContain(Buffer.from(CSV).toString('base64'));
    expect(answer.files).toHaveLength(1);
    expect(answer.files[0]).toMatchObject({
      name: 'out.csv',
      mimeType: 'text/csv',
      bytes: CSV.length
    });
    expect(typeof answer.files[0].fileId).toBe('string');
    expect(answer.images).toHaveLength(1);
    expect(answer.images[0]).toMatchObject({ name: 'chart.png', mimeType: 'image/png' });

    const stored = await repo.getText(chat, answer.files[0].fileId);
    expect(stored).toMatchObject({ name: 'out.csv', origin: 'a2a' });
    expect(stored.text).toContain('Berlin');
  });

  it('are taken from the status message and fetched from a uri', async () => {
    replyKind = 'status';
    agents['one.example'].files['/files/report.csv'] = { body: CSV, type: 'text/csv' };
    replyParts = [
      { kind: 'text', text: 'see file' },
      { kind: 'file', file: { name: 'report.csv', uri: 'https://one.example/files/report.csv' } }
    ];
    const answer = await call();
    expect(answer.files[0]).toMatchObject({ name: 'report.csv', bytes: CSV.length });
    // same origin as the agent: its credentials/headers go along (the agent has none here)
    expect(requests.some(r => r.path === '/files/report.csv' && r.method === 'GET')).toBe(true);
  });

  it('fail soft: oversized, unreadable and unsupported files come back with an error note', async () => {
    replyParts = [
      { kind: 'text', text: 'results' },
      {
        kind: 'file',
        file: { name: 'huge.pdf', mimeType: 'application/pdf', bytes: 'A'.repeat(15 * 1024 * 1024) }
      },
      { kind: 'file', file: { name: 'broken.csv', bytes: 'not base64 !!' } },
      { kind: 'file', file: { name: 'gone.csv', uri: 'https://one.example/files/gone.csv' } },
      {
        kind: 'file',
        file: { name: 'tool.exe', mimeType: 'application/x-msdownload', bytes: 'QUJD' }
      },
      { kind: 'file', file: { name: 'local.csv', uri: 'http://10.0.0.5/x.csv' } }
    ];
    agents['one.example'].files['/files/gone.csv'] = { body: 'no', status: 404 };
    const answer = await call();
    expect(answer.text).toBe('results');
    const entries = answer.files;
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(typeof entry.error).toBe('string');
      expect(entry.fileId).toBeUndefined();
    }
    expect(entries[0].error).toMatch(/larger than 10 MB/);
    expect(JSON.stringify(answer).length).toBeLessThan(3000);
  });

  it('leave a text-only answer a plain string', async () => {
    expect(await call()).toBe('ok');
  });
});

describe('what the chat does with an agent skill result', () => {
  it('emits download cards and picture deltas for the files, only for A2A skill tools', async () => {
    replyParts = [
      { kind: 'text', text: 'done' },
      {
        kind: 'file',
        file: { name: 'out.csv', mimeType: 'text/csv', bytes: Buffer.from(CSV).toString('base64') }
      },
      { kind: 'file', file: { name: 'chart.png', mimeType: 'image/png', bytes: PNG_B64 } }
    ];
    const rawResult = await call();

    const frames = [];
    const files = [];
    const images = [];
    const seam = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      generatedFiles: files,
      generatedImages: images
    });
    const ctx = {
      iteration: 1,
      meta: { stream: { emit: (type, data) => frames.push({ type, data }) } }
    };
    const outcome = { rawResult, message: { content: JSON.stringify(rawResult) } };
    await seam.postTool(
      ctx,
      { toolId: TOOL, toolDef: { id: TOOL, _a2a: { agentId: 'one' } }, call: { id: '1' } },
      outcome
    );
    const completed = frames.find(f => f.type === 'tool/completed').data;
    expect(completed.files).toHaveLength(1);
    expect(Buffer.from(completed.files[0].data, 'base64').toString()).toBe(CSV);
    expect(files).toHaveLength(1);
    expect(images).toEqual([expect.objectContaining({ mimeType: 'image/png', data: PNG_B64 })]);
    expect(frames.find(f => f.type === 'step/delta').data.kind).toBe('image');
    // the model's copy of the result has no bytes
    expect(outcome.message.content).not.toContain(PNG_B64);

    // another tool returning the same fields gets nothing
    const frames2 = [];
    const files2 = [];
    const other = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      generatedFiles: files2
    });
    await other.postTool(
      { iteration: 1, meta: { stream: { emit: (type, data) => frames2.push({ type, data }) } } },
      { toolId: 'evil', toolDef: { id: 'evil', script: 'x.js' }, call: { id: '2' } },
      { rawResult, message: { content: '' } }
    );
    expect(files2).toEqual([]);
    expect(frames2.find(f => f.type === 'tool/completed').data.files).toBeUndefined();
  });
});
