#!/usr/bin/env node

/**
 * Migration V126 specs — registers the WebVTT and "any text file" upload
 * formats and lets apps that accept plain text also accept .vtt transcripts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V126__vtt_and_generic_text_mimetypes.js';

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files || Object.keys(files).some(name => name.startsWith(`${p}/`)),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, data) => {
      files[p] = data;
      writes.push(p);
    },
    listFiles: async dir =>
      Object.keys(files)
        .filter(name => name.startsWith(`${dir}/`))
        .map(name => name.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

function installedMimetypes() {
  return {
    categories: {
      documents: { name: { en: 'Documents' }, mimeTypes: ['text/plain', 'application/pdf'] }
    },
    mimeTypes: {
      'text/plain': { extensions: ['.txt'], displayName: 'TXT', category: 'documents' },
      'application/pdf': { extensions: ['.pdf'], displayName: 'PDF', category: 'documents' }
    }
  };
}

const app = supportedFormats => ({
  id: 'x',
  upload: { fileUpload: { enabled: true, supportedFormats } }
});

test('version is the next unused number', () => {
  assert.equal(version, '126');
});

test('precondition is false on an empty contents directory', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(
    await precondition(fakeCtx({ 'config/mimetypes.json': installedMimetypes() })),
    true
  );
});

test('registers text/vtt and text/* in the documents category', async () => {
  const ctx = fakeCtx({ 'config/mimetypes.json': installedMimetypes() });
  await up(ctx);

  const stored = ctx.files['config/mimetypes.json'];
  assert.deepEqual(stored.categories.documents.mimeTypes, [
    'text/plain',
    'application/pdf',
    'text/vtt',
    'text/*'
  ]);
  assert.deepEqual(stored.mimeTypes['text/vtt'], {
    extensions: ['.vtt'],
    displayName: 'VTT',
    category: 'documents'
  });
  assert.deepEqual(stored.mimeTypes['text/*'].extensions, []);
});

test('keeps an admin-defined entry and is idempotent', async () => {
  const mimetypes = installedMimetypes();
  mimetypes.mimeTypes['text/vtt'] = {
    extensions: ['.vtt', '.webvtt'],
    displayName: 'Transcript',
    category: 'documents'
  };
  const ctx = fakeCtx({ 'config/mimetypes.json': mimetypes });
  await up(ctx);
  await up(ctx);

  const stored = ctx.files['config/mimetypes.json'];
  assert.equal(stored.mimeTypes['text/vtt'].displayName, 'Transcript');
  assert.equal(stored.categories.documents.mimeTypes.filter(t => t === 'text/vtt').length, 1);
  assert.deepEqual(ctx.writes, ['config/mimetypes.json']);
});

test('adds text/vtt only to apps that accept text/plain, never text/*', async () => {
  const ctx = fakeCtx({
    'apps/plain.json': app(['text/plain', 'application/pdf']),
    'apps/pdf-only.json': app(['application/pdf']),
    'apps/has-vtt.json': app(['text/plain', 'text/vtt']),
    'apps/no-upload.json': { id: 'y' }
  });
  await up(ctx);

  assert.deepEqual(ctx.files['apps/plain.json'].upload.fileUpload.supportedFormats, [
    'text/plain',
    'application/pdf',
    'text/vtt'
  ]);
  assert.deepEqual(ctx.files['apps/pdf-only.json'].upload.fileUpload.supportedFormats, [
    'application/pdf'
  ]);
  assert.deepEqual(ctx.writes, ['apps/plain.json']);
});
