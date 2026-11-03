// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemStorageProvider } from '../../storage/index.js';
import { ChatFileRepository } from '../../services/chatFiles/ChatFileRepository.js';
import { chatToolSeam } from '../../services/chat/chatSeams.js';
import {
  MAX_LIFTED_BLOCKS,
  clearHeldToolImages,
  decodeBase64Capped,
  headlessToolOutputSeam
} from '../../services/chat/toolOutputFiles.js';
import { clearHeldGeneratedFiles } from '../../services/documents/generatedFiles.js';

/**
 * MCP client: binary content blocks of a tool result (`resource` blob, `image`)
 * are stored as chat files / generated files / pictures and replaced, before
 * the model reads the result, by `{ fileId, name, mimeType, bytes }`
 * descriptors. The bytes reach the client as `files` / image deltas and the
 * stored answer through the turn's collectors; no base64 is left in what the
 * model sees.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const CSV = Buffer.from('name,qty\nwidget,3\ngadget,5\n', 'utf8');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);

const mcpTool = { id: 'srv_export', _mcp: { serverId: 'srv', originalName: 'export' } };

let tmpDir;
let provider;
let repo;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-tool-output-'));
  provider = new FilesystemStorageProvider({ baseDir: tmpDir });
  await provider.initialize();
  repo = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
});

afterAll(async () => {
  await provider?.shutdown?.();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearHeldToolImages();
  clearHeldGeneratedFiles();
});

function setup(extra = {}) {
  const frames = [];
  const files = [];
  const images = [];
  const seam = chatToolSeam({
    chatId: 'chat-1',
    buildLogData: () => ({}),
    logInteraction: async () => {},
    generatedFiles: files,
    generatedImages: images,
    fileStore: repo,
    ...extra
  });
  const ctx = {
    iteration: 1,
    refs: { userId: 'alice' },
    meta: { stream: { emit: (type, data) => frames.push({ type, data }) } }
  };
  return { seam, ctx, frames, files, images };
}

async function run(rawResult, { toolDef = mcpTool, extra } = {}) {
  const s = setup(extra);
  const outcome = {
    rawResult,
    message: { role: 'tool', content: JSON.stringify(rawResult) }
  };
  await s.seam.postTool(s.ctx, { toolId: toolDef.id, toolDef, call: { id: 'c1' } }, outcome);
  return { ...s, outcome };
}

describe('MCP binary content in a chat tool result', () => {
  it('stores an embedded resource blob as a chat file and tells the model only its descriptor', async () => {
    const raw = [
      { type: 'text', text: 'Exported 2 rows' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///exports/stock.csv',
          mimeType: 'text/csv',
          blob: CSV.toString('base64')
        }
      }
    ];
    const { outcome, frames, files } = await run(raw);

    const seen = JSON.parse(outcome.message.content);
    expect(seen[0]).toEqual({ type: 'text', text: 'Exported 2 rows' });
    expect(seen[1]).toMatchObject({
      type: 'file',
      name: 'stock.csv',
      mimeType: 'text/csv',
      bytes: CSV.length
    });
    expect(typeof seen[1].fileId).toBe('string');
    expect(outcome.message.content).not.toContain(CSV.toString('base64'));
    expect(outcome.rawResult).toEqual(seen);

    // The chat file exists in the chat's scope, origin mcp, text extracted
    const stored = await repo.getText({ type: 'chat', id: 'chat-1' }, seen[1].fileId);
    expect(stored).toMatchObject({ name: 'stock.csv', origin: 'mcp' });
    expect(stored.text).toContain('widget');

    // …and also reaches the client as a download card, bytes only there
    const completed = frames.find(f => f.type === 'tool/completed').data;
    expect(completed.files).toHaveLength(1);
    expect(completed.files[0]).toMatchObject({ name: 'stock.csv', mimeType: 'text/csv' });
    expect(Buffer.from(completed.files[0].data, 'base64').equals(CSV)).toBe(true);
    expect(JSON.stringify(completed.resultPreview)).not.toContain(CSV.toString('base64'));
    expect(files).toHaveLength(1);
  });

  it('turns an image block into a picture delta and a stored-answer image', async () => {
    const raw = [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }];
    const { outcome, frames, images } = await run(raw);

    const seen = JSON.parse(outcome.message.content);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'file',
      mimeType: 'image/png',
      bytes: PNG.length,
      displayedToUser: true
    });
    expect(outcome.message.content).not.toContain(PNG.toString('base64'));

    const delta = frames.find(f => f.type === 'step/delta').data;
    expect(delta).toMatchObject({ kind: 'image', image: { mimeType: 'image/png' } });
    expect(delta.image.data).toBe(PNG.toString('base64'));
    expect(images).toEqual([
      expect.objectContaining({ mimeType: 'image/png', data: PNG.toString('base64') })
    ]);
  });

  it('keeps an archive as a download card even though it cannot be read as a document', async () => {
    const raw = [
      {
        type: 'resource',
        resource: {
          uri: 'https://x.example/out/bundle.zip',
          mimeType: 'application/zip',
          blob: ZIP.toString('base64')
        }
      }
    ];
    const { outcome, files } = await run(raw);
    const seen = JSON.parse(outcome.message.content);
    expect(seen[0]).toMatchObject({
      name: 'bundle.zip',
      mimeType: 'application/zip',
      bytes: ZIP.length
    });
    expect(seen[0].error).toBeUndefined();
    expect(files).toHaveLength(1);
    expect(files[0].mimeType).toBe('application/zip');
  });

  it('leaves text resources, embedded view pages and plain text results alone', async () => {
    const raw = [
      { type: 'text', text: 'hello' },
      {
        type: 'resource',
        resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'inline text' }
      }
    ];
    const { outcome, files, images } = await run(raw);
    expect(JSON.parse(outcome.message.content)).toEqual(raw);
    expect(files).toEqual([]);
    expect(images).toEqual([]);

    const view = await run([
      {
        type: 'resource',
        resource: { uri: 'ui://app/view', mimeType: 'text/html', blob: 'PGh0bWw+' }
      }
    ]);
    expect(view.outcome.message.content).toContain('PGh0bWw+');

    const str = await run('just a string');
    expect(str.outcome.rawResult).toBe('just a string');
  });

  it('fails soft: oversized, invalid, empty and unsupported files get an error note, never base64', async () => {
    const huge = 'A'.repeat(36 * 1024 * 1024);
    const raw = [
      {
        type: 'resource',
        resource: { uri: 'file:///big.pdf', mimeType: 'application/pdf', blob: huge }
      },
      { type: 'image', data: 'not base64 !!', mimeType: 'image/png' },
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/svg+xml' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///blob.bin',
          mimeType: 'application/octet-stream',
          blob: Buffer.from('xyz').toString('base64')
        }
      }
    ];
    const { outcome, files, images, frames } = await run(raw);
    const seen = JSON.parse(outcome.message.content);
    expect(seen).toHaveLength(5);
    for (const entry of seen) {
      expect(entry.type).toBe('file');
      expect(typeof entry.error).toBe('string');
      expect(entry.fileId).toBeUndefined();
    }
    expect(seen[0].error).toMatch(/larger than 25 MB/);
    expect(seen[1].error).toMatch(/not valid base64/);
    expect(outcome.message.content.length).toBeLessThan(2000);
    expect(files).toEqual([]);
    expect(images).toEqual([]);
    expect(frames.find(f => f.type === 'tool/completed')).toBeTruthy();
  });

  it(`refuses blocks past ${MAX_LIFTED_BLOCKS} in one result without crashing`, async () => {
    const raw = Array.from({ length: MAX_LIFTED_BLOCKS + 2 }, () => ({
      type: 'image',
      data: PNG.toString('base64'),
      mimeType: 'image/png'
    }));
    const { outcome, images } = await run(raw);
    const seen = JSON.parse(outcome.message.content);
    expect(seen.filter(entry => entry.error)).toHaveLength(2);
    expect(images).toHaveLength(MAX_LIFTED_BLOCKS);
  });

  it('only lifts the results of MCP tools', async () => {
    const raw = [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }];
    const { outcome, images } = await run(raw, { toolDef: { id: 'custom', script: 'x.js' } });
    expect(outcome.message.content).toContain(PNG.toString('base64'));
    expect(images).toEqual([]);
  });

  it('does not lift anything out of a failed call', async () => {
    const s = setup();
    const outcome = { error: new Error('boom'), rawResult: undefined, message: { content: '' } };
    await s.seam.postTool(
      s.ctx,
      { toolId: 'srv_export', toolDef: mcpTool, call: { id: 'c1' } },
      outcome
    );
    expect(s.images).toEqual([]);
    expect(s.files).toEqual([]);
  });
});

describe('runs without a client (apps invoked over MCP / A2A)', () => {
  it('collect the lifted files and pictures of their tools', async () => {
    const generatedFiles = [];
    const generatedImages = [];
    const seam = headlessToolOutputSeam({
      chatId: 'chat-2',
      user: { id: 'alice' },
      generatedFiles,
      generatedImages,
      store: repo
    });
    const raw = [
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      {
        type: 'resource',
        resource: { uri: 'file:///s.csv', mimeType: 'text/csv', blob: CSV.toString('base64') }
      }
    ];
    const outcome = { rawResult: raw, message: { content: JSON.stringify(raw) } };
    await seam.postTool({}, { toolId: 'srv_export', toolDef: mcpTool }, outcome);
    expect(outcome.message.content).not.toContain(PNG.toString('base64'));
    expect(generatedImages).toHaveLength(1);
    expect(generatedFiles).toHaveLength(1);
    expect(generatedFiles[0].name).toBe('s.csv');
  });
});

describe('early lift (before the loop serialises and bounds the result)', () => {
  const raw = () => [
    { type: 'text', text: 'Exported' },
    {
      type: 'resource',
      resource: { uri: 'file:///s.csv', mimeType: 'text/csv', blob: CSV.toString('base64') }
    }
  ];

  it('takes the base64 out in liftResult; postTool then reuses it without lifting twice', async () => {
    const s = setup();
    const info = { toolId: 'srv_export', toolDef: mcpTool, call: { id: 'c1' } };
    const holder = { rawResult: raw() };
    await s.seam.liftResult(s.ctx, info, holder);
    expect(JSON.stringify(holder.rawResult)).not.toContain(CSV.toString('base64'));
    expect(holder.lifted.files).toHaveLength(1);

    const outcome = {
      rawResult: holder.rawResult,
      lifted: holder.lifted,
      message: { role: 'tool', content: JSON.stringify(holder.rawResult) }
    };
    await s.seam.postTool(s.ctx, info, outcome);
    expect(s.files).toHaveLength(1);
    expect(await repo.list({ type: 'chat', id: 'chat-1' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 's.csv' })])
    );
    const stored = (await repo.list({ type: 'chat', id: 'chat-1' })).filter(
      f => f.name === 's.csv'
    );
    expect(stored.length).toBe(1);
  });

  it('leaves non-MCP tools and results without binary blocks to postTool', async () => {
    const s = setup();
    const plain = { rawResult: [{ type: 'text', text: 'hi' }] };
    await s.seam.liftResult(
      s.ctx,
      { toolId: 'srv_export', toolDef: mcpTool, call: { id: 'c1' } },
      plain
    );
    expect(plain.lifted).toBeUndefined();
    const custom = { rawResult: raw() };
    await s.seam.liftResult(
      s.ctx,
      { toolId: 'custom', toolDef: { id: 'custom', script: 'x.js' }, call: { id: 'c2' } },
      custom
    );
    expect(custom.lifted).toBeUndefined();
    expect(JSON.stringify(custom.rawResult)).toContain(CSV.toString('base64'));
  });

  it('is shared with the headless seam', async () => {
    const generatedFiles = [];
    const seam = headlessToolOutputSeam({
      chatId: 'chat-3',
      user: { id: 'alice' },
      generatedFiles,
      generatedImages: [],
      store: repo
    });
    const holder = { rawResult: raw() };
    await seam.liftResult({}, { toolId: 'srv_export', toolDef: mcpTool }, holder);
    expect(JSON.stringify(holder.rawResult)).not.toContain(CSV.toString('base64'));
    const outcome = {
      rawResult: holder.rawResult,
      lifted: holder.lifted,
      message: { content: JSON.stringify(holder.rawResult) }
    };
    await seam.postTool({}, { toolId: 'srv_export', toolDef: mcpTool }, outcome);
    expect(generatedFiles).toHaveLength(1);
  });
});

describe('decodeBase64Capped', () => {
  it('measures before decoding and refuses what is not base64', () => {
    expect(decodeBase64Capped('aGVsbG8=')).toMatchObject({ ok: true });
    expect(decodeBase64Capped('aGVsbG8=', 3)).toEqual({ ok: false, reason: 'too-large', bytes: 5 });
    expect(decodeBase64Capped('****')).toEqual({ ok: false, reason: 'invalid' });
    expect(decodeBase64Capped(12)).toEqual({ ok: false, reason: 'invalid' });
    expect(decodeBase64Capped('  ')).toEqual({ ok: false, reason: 'empty' });
  });
});
