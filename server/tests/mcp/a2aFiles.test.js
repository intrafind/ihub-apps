// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { FilesystemStorageProvider } from '../../storage/index.js';
import { scratchDocuments } from '../helpers/testStorage.js';

const scratch = await scratchDocuments();

/**
 * A2A server: inbound `FilePart`s (base64 `bytes`, or an https `uri`) are
 * ingested into the task's chat and reach the app as file data; the Agent Card
 * advertises the media types; files and pictures an app produced come back as
 * `FilePart` artifacts.
 */

const apps = [{ id: 'chat', name: { en: 'Chat' }, description: { en: 'General chat' } }];
const workflows = [
  { id: 'wf1', name: { en: 'Report' }, chatIntegration: { enabled: true, toolDescription: 'x' } }
];

let platform;
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getApps: () => ({ data: apps }),
    getWorkflows: () => ({ data: workflows }),
    getUI: () => ({ data: { title: { en: 'iHub Test' } } }),
    getPlatform: () => platform
  }
}));

const invokeApp = jest.fn();
jest.unstable_mockModule('../../services/mcp/appInvoker.js', () => ({
  invokeApp,
  invokeAppNonStreaming: jest.fn()
}));
const runTool = jest.fn();
jest.unstable_mockModule('../../services/tools/catalog.js', () => ({}));
jest.unstable_mockModule('../../services/tools/runTool.js', () => ({
  runTool
}));
jest.unstable_mockModule('../../utils/versionHelper.js', () => ({ getAppVersion: () => '9.9.9' }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const actualRepo = await import('../../services/chatFiles/ChatFileRepository.js');
let repo;
jest.unstable_mockModule('../../services/chatFiles/ChatFileRepository.js', () => ({
  ...actualRepo,
  getChatFileRepository: () => repo
}));

const {
  dispatchA2A,
  buildAgentCard,
  A2A_ERRORS,
  A2A_INPUT_MODES,
  A2A_OUTPUT_MODES,
  fileArtifactsOf
} = await import('../../services/mcp/a2aHandler.js');
const { A2aTaskStore } = await import('../../services/mcp/a2aTaskStore.js');
const { fetchInboundUri, filesFromA2aParts, InboundFileError } =
  await import('../../services/mcp/inboundFiles.js');

const user = () => ({
  id: 'alice',
  scopes: ['mcp:apps:invoke', 'mcp:workflows:run'],
  permissions: { apps: new Set(['*']), workflows: new Set(['wf1']) }
});

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const csvB64 = Buffer.from('city,pop\nBerlin,3.7\n').toString('base64');

let store;
let tmpDir;
let provider;
const ctx = (overrides = {}) => ({
  user: user(),
  platform,
  baseUrl: 'https://ihub.example',
  store,
  ...overrides
});
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const send = (parts, extra = {}, configuration) =>
  dispatchA2A(
    rpc('message/send', {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'm1',
        parts,
        metadata: { skillId: 'app__chat' },
        ...extra
      },
      ...(configuration ? { configuration } : {})
    }),
    ctx()
  );

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-a2a-files-'));
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

beforeEach(async () => {
  await scratch.reset();
  platform = {
    defaultLanguage: 'en',
    mcpServer: { expose: { tools: true, apps: true, workflows: true }, a2a: { enabled: true } },
    oauth: { issuer: 'https://ihub.example' }
  };
  store = new A2aTaskStore({ documents: scratch.documents, relayCancel: false });
  invokeApp.mockReset();
  invokeApp.mockResolvedValue({ text: 'Hello', result: {} });
  runTool.mockReset();
  runTool.mockResolvedValue({
    status: 'completed',
    executionId: 'e1',
    output: { output: 'done' },
    outputText: 'done'
  });
});

describe('Agent Card', () => {
  it('advertises the file types it reads and returns', () => {
    const card = buildAgentCard({
      baseUrl: 'https://ihub.example',
      platform,
      user: user()
    });
    expect(card.defaultInputModes).toEqual(A2A_INPUT_MODES);
    expect(card.defaultOutputModes).toEqual(A2A_OUTPUT_MODES);
    expect(card.defaultInputModes).toEqual(
      expect.arrayContaining(['text/plain', 'application/pdf', 'text/csv'])
    );
    expect(card.defaultOutputModes).toEqual(
      expect.arrayContaining(['text/plain', 'application/pdf', 'image/png', 'application/zip'])
    );
    const app = card.skills.find(skill => skill.id === 'app__chat');
    expect(app.inputModes).toContain('application/pdf');
    expect(app.outputModes).toContain('image/png');
    const wf = card.skills.find(skill => skill.id === 'workflow__wf1');
    expect(wf.inputModes).toContain('application/pdf');
    expect(wf.outputModes).toEqual(['text/plain', 'application/json']);
  });
});

describe('inbound FilePart', () => {
  it('ingests base64 bytes into the task chat and gives the app the file data', async () => {
    const r = await send([
      { kind: 'text', text: 'Which city is biggest?' },
      { kind: 'file', file: { name: 'cities.csv', mimeType: 'text/csv', bytes: csvB64 } }
    ]);
    expect(r.error).toBeUndefined();
    expect(r.result.status.state).toBe('completed');
    const call = invokeApp.mock.calls[0][0];
    expect(typeof call.chatId).toBe('string');
    const message = call.messages.at(-1);
    expect(message.content).toBe('Which city is biggest?');
    expect(message.fileData).toMatchObject({ fileName: 'cities.csv', origin: 'a2a' });
    expect(message.fileData.content).toContain('Berlin');
    const stored = await repo.list({ type: 'chat', id: call.chatId });
    expect(stored.map(file => [file.name, file.origin])).toEqual([['cities.csv', 'a2a']]);
  });

  it('never keeps the file content in the stored task', async () => {
    const r = await send([
      { kind: 'text', text: 'hi' },
      { kind: 'file', file: { name: 'cities.csv', mimeType: 'text/csv', bytes: csvB64 } }
    ]);
    const task = await store.getTask(r.result.id, 'alice');
    expect(JSON.stringify(task)).not.toContain(csvB64);
    expect(task.history[0].parts[1]).toEqual({
      kind: 'file',
      file: { name: 'cities.csv', mimeType: 'text/csv' }
    });
  });

  it('answers a message that only carries a file', async () => {
    const r = await send([
      { kind: 'file', file: { name: 'cities.csv', mimeType: 'text/csv', bytes: csvB64 } }
    ]);
    expect(r.result.status.state).toBe('completed');
    expect(invokeApp.mock.calls[0][0].messages.at(-1).content).toMatch(/attached file/);
  });

  it('hands the files of a workflow message to the workflow', async () => {
    const r = await send(
      [
        { kind: 'text', text: 'build' },
        { kind: 'file', file: { name: 'cities.csv', mimeType: 'text/csv', bytes: csvB64 } }
      ],
      { metadata: { skillId: 'workflow__wf1' } }
    );
    expect(r.result.status.state).toBe('completed');
    const params = runTool.mock.calls[0][1];
    expect(params._fileData).toHaveLength(1);
    expect(params._fileData[0].content).toContain('Berlin');
  });

  it('refuses unsupported types with -32005 and bad input with -32602, starting no task', async () => {
    const png = await send([
      { kind: 'text', text: 'x' },
      { kind: 'file', file: { name: 'a.png', mimeType: 'image/png', bytes: PNG_B64 } }
    ]);
    expect(png.error.code).toBe(A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED);

    const invalid = await send([
      { kind: 'text', text: 'x' },
      { kind: 'file', file: { name: 'a.csv', mimeType: 'text/csv', bytes: 'not base64 !!' } }
    ]);
    expect(invalid.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);

    const huge = await send([
      { kind: 'text', text: 'x' },
      {
        kind: 'file',
        file: { name: 'a.csv', mimeType: 'text/csv', bytes: 'A'.repeat(36 * 1024 * 1024) }
      }
    ]);
    expect(huge.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
    expect(huge.error.message).toMatch(/larger than 25 MB/);

    const none = await send([
      { kind: 'text', text: 'x' },
      { kind: 'file', file: { name: 'a.csv' } }
    ]);
    expect(none.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);

    const tooMany = await send([
      { kind: 'text', text: 'x' },
      ...Array.from({ length: 11 }, (_, i) => ({
        kind: 'file',
        file: { name: `f${i}.csv`, mimeType: 'text/csv', bytes: csvB64 }
      }))
    ]);
    expect(tooMany.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
    expect(invokeApp).not.toHaveBeenCalled();
  });
});

describe('inbound file.uri', () => {
  const okAssert = async () => ({ ok: true, addresses: [{ address: '93.184.216.34', family: 4 }] });
  const response = (body, init = {}) => ({
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: new Headers(init.headers || { 'content-type': 'text/csv' }),
    body: Readable.from([Buffer.from(body)])
  });

  it('is fetched through httpFetch from a public https host, with the pinned lookup', async () => {
    const fetch = jest.fn(async () => response('a,b\n1,2\n'));
    const [file] = await filesFromA2aParts(
      [{ kind: 'file', file: { uri: 'https://files.example/data/report.csv' } }],
      { fetch, assertPublic: okAssert }
    );
    expect(file).toMatchObject({ name: 'report.csv', mimeType: 'text/csv' });
    expect(file.bytes.toString()).toBe('a,b\n1,2\n');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', method: 'GET' });
    expect(typeof fetch.mock.calls[0][1].lookup).toBe('function');
  });

  it('refuses http, credentials, private hosts, redirects, errors and oversize', async () => {
    const parts = uri => [{ kind: 'file', file: { uri } }];
    const fetch = jest.fn();
    const reject = async (uri, options = {}) => {
      await expect(
        filesFromA2aParts(parts(uri), { fetch, assertPublic: okAssert, ...options })
      ).rejects.toBeInstanceOf(InboundFileError);
    };
    await reject('http://files.example/a.csv');
    await reject('https://user:pw@files.example/a.csv');
    await reject('not a url');
    await reject('https://internal.example/a.csv', {
      assertPublic: async () => ({ ok: false, reason: 'resolves to a private address' })
    });
    expect(fetch).not.toHaveBeenCalled();

    await reject('https://files.example/a.csv', {
      fetch: async () => response('', { status: 302, headers: { location: 'https://x' } })
    });
    await reject('https://files.example/a.csv', {
      fetch: async () => response('nope', { status: 404 })
    });
    await reject('https://files.example/a.csv', {
      fetch: async () => response('x'.repeat(100)),
      maxBytes: 10
    });
    await expect(
      fetchInboundUri('https://files.example/a.csv', {
        fetch: async () => response('x', { headers: { 'content-length': '99999999' } }),
        assertPublic: okAssert,
        maxBytes: 10
      })
    ).rejects.toThrow(/larger than/);
  });
});

describe('outbound FilePart artifacts', () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  const produced = {
    generatedFiles: [
      {
        id: 'b'.repeat(32),
        name: 'Report.pdf',
        mimeType: 'application/pdf',
        bytes: pdf.length,
        data: pdf.toString('base64')
      }
    ],
    images: [{ mimeType: 'image/png', data: PNG_B64, name: 'chart.png' }]
  };

  it('returns generated files and pictures as file parts next to the text artifact', async () => {
    invokeApp.mockResolvedValue({ text: 'Done', result: produced });
    const r = await send([{ kind: 'text', text: 'make a report' }]);
    const artifacts = r.result.artifacts;
    expect(artifacts[0].parts[0]).toEqual({ kind: 'text', text: 'Done' });
    const fileParts = artifacts.slice(1).map(a => a.parts[0]);
    expect(fileParts).toEqual([
      {
        kind: 'file',
        file: { name: 'Report.pdf', mimeType: 'application/pdf', bytes: pdf.toString('base64') }
      },
      { kind: 'file', file: { name: 'chart.png', mimeType: 'image/png', bytes: PNG_B64 } }
    ]);
    expect(artifacts.slice(1).every(a => typeof a.artifactId === 'string' && a.name)).toBe(true);
    // the agent's status message is text only
    expect(JSON.stringify(r.result.status.message)).not.toContain(PNG_B64);
  });

  it('streams a file artifact event for each file', async () => {
    invokeApp.mockResolvedValue({ text: 'Done', result: produced });
    const events = [];
    await dispatchA2A(
      rpc('message/stream', {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'm2',
          parts: [{ kind: 'text', text: 'go' }],
          metadata: { skillId: 'app__chat' }
        }
      }),
      ctx({ stream: event => events.push(event.result) })
    );
    const fileEvents = events.filter(
      e => e.kind === 'artifact-update' && e.artifact.parts[0]?.kind === 'file'
    );
    expect(fileEvents).toHaveLength(2);
    expect(fileEvents.every(e => e.lastChunk === true && e.append === false)).toBe(true);
  });

  it('leaves out what the client did not accept, and keeps text-only calls unchanged', async () => {
    invokeApp.mockResolvedValue({ text: 'Done', result: produced });
    const only = await send(
      [{ kind: 'text', text: 'go' }],
      {},
      {
        acceptedOutputModes: ['text/plain', 'application/pdf']
      }
    );
    expect(only.result.artifacts.slice(1).map(a => a.parts[0].file.name)).toEqual(['Report.pdf']);

    const textOnly = await send(
      [{ kind: 'text', text: 'go' }],
      {},
      {
        acceptedOutputModes: ['text/plain']
      }
    );
    expect(textOnly.result.artifacts).toHaveLength(1);

    invokeApp.mockResolvedValue({ text: 'Plain', result: {} });
    const none = await send([{ kind: 'text', text: 'go' }]);
    expect(none.result.artifacts).toHaveLength(1);
  });

  it('keeps the files of one task within a size budget', () => {
    const big = Buffer.alloc(12 * 1024 * 1024, 1).toString('base64');
    const { artifacts, omitted } = fileArtifactsOf(
      {
        generatedFiles: [
          { name: 'a.pdf', mimeType: 'application/pdf', data: big },
          { name: 'b.pdf', mimeType: 'application/pdf', data: big }
        ]
      },
      undefined
    );
    expect(artifacts).toHaveLength(1);
    expect(omitted).toEqual(['b.pdf']);
  });
});

describe('provenance (EU AI Act Art. 50(2))', () => {
  const provenance = {
    spec: 'intrafind-provenance/1.0',
    ai_generated: true,
    output_id: '01JC0000000000000000000000'
  };

  it('puts the provenance of an app answer in the Task metadata and the artifact metadata', async () => {
    invokeApp.mockResolvedValue({ text: 'Hello', result: { provenance } });
    const r = await send([{ kind: 'text', text: 'hi' }]);
    expect(r.result.metadata.provenance).toEqual(provenance);
    expect(r.result.metadata.skillId).toBe('app__chat');
    expect(r.result.artifacts[0].metadata.provenance).toEqual(provenance);
    const task = await store.getTask(r.result.id, 'alice');
    expect(task.metadata.provenance).toEqual(provenance);
  });

  it('adds none to a failed task', async () => {
    invokeApp.mockRejectedValue(new Error('boom'));
    const r = await send([{ kind: 'text', text: 'hi' }]);
    expect(r.result.status.state).toBe('failed');
    expect(r.result.metadata.provenance).toBeUndefined();
  });
});
