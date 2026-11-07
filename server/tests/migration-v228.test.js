#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V228 specs — upload types left on the editor's default formats take the entire
 * format category; curated lists and types that are not enabled stay as they are.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V228__upload_formats_entire_category.js';

const CATEGORIES = {
  images: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/tiff'],
  documents: ['text/plain', 'text/markdown', 'text/vtt', 'application/pdf', 'text/*'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
  video: ['video/mp4', 'video/webm', 'video/mpeg']
};

const mimetypes = () => ({
  categories: Object.fromEntries(
    Object.entries(CATEGORIES).map(([id, mimeTypes]) => [id, { name: { en: id }, mimeTypes }])
  ),
  mimeTypes: {}
});

function fakeCtx(files) {
  const logs = [];
  return {
    files,
    logs,
    fileExists: async p => p in files || Object.keys(files).some(name => name.startsWith(`${p}/`)),
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    readDefaultJson: async () => mimetypes(),
    writeJson: async (p, data) => {
      files[p] = data;
    },
    listFiles: async dir =>
      Object.keys(files)
        .filter(name => name.startsWith(`${dir}/`))
        .map(name => name.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const IMAGE_DEFAULT = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const AUDIO_DEFAULT = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/flac',
  'audio/ogg',
  'audio/mp4'
];
const CHAT_FILE_DEFAULT = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/vtt',
  'application/json',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/pdf'
];

const withUpload = upload => ({ id: 'x', upload: { enabled: true, ...upload } });

test('version is the next unused number', () => {
  assert.equal(version, '228');
});

test('precondition is false without apps', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(await precondition(fakeCtx({ 'apps/a.json': {} })), true);
});

test('a type without formats takes the entire category', async () => {
  const ctx = fakeCtx({
    'config/mimetypes.json': mimetypes(),
    'apps/a.json': withUpload({ audioUpload: { enabled: true }, videoUpload: { enabled: true } })
  });
  await up(ctx);
  assert.deepEqual(ctx.files['apps/a.json'].upload.audioUpload.supportedFormats, CATEGORIES.audio);
  assert.deepEqual(ctx.files['apps/a.json'].upload.videoUpload.supportedFormats, CATEGORIES.video);
  assert.equal(ctx.files['apps/a.json'].upload.audioUpload.enabled, true);
  assert.equal(ctx.logs.length, 1);
});

test('a type on one of the old default lists takes the entire category, text/vtt aside', async () => {
  const ctx = fakeCtx({
    'config/mimetypes.json': mimetypes(),
    'apps/a.json': withUpload({
      imageUpload: { enabled: true, supportedFormats: IMAGE_DEFAULT, maxFileSizeMB: 10 },
      audioUpload: { enabled: true, supportedFormats: [...AUDIO_DEFAULT].reverse() },
      fileUpload: { enabled: true, supportedFormats: CHAT_FILE_DEFAULT }
    }),
    'apps/b.json': withUpload({
      fileUpload: {
        enabled: true,
        supportedFormats: CHAT_FILE_DEFAULT.filter(format => format !== 'text/vtt')
      }
    })
  });
  await up(ctx);
  const a = ctx.files['apps/a.json'].upload;
  assert.deepEqual(a.imageUpload.supportedFormats, CATEGORIES.images);
  assert.equal(a.imageUpload.maxFileSizeMB, 10);
  assert.deepEqual(a.audioUpload.supportedFormats, CATEGORIES.audio);
  assert.deepEqual(a.fileUpload.supportedFormats, CATEGORIES.documents);
  assert.deepEqual(
    ctx.files['apps/b.json'].upload.fileUpload.supportedFormats,
    CATEGORIES.documents
  );
});

test('a curated list stays as it is', async () => {
  const curated = withUpload({
    fileUpload: { enabled: true, supportedFormats: ['text/plain', 'application/pdf'] },
    imageUpload: { enabled: true, supportedFormats: ['image/png'] }
  });
  const ctx = fakeCtx({ 'config/mimetypes.json': mimetypes(), 'apps/a.json': curated });
  await up(ctx);
  assert.deepEqual(ctx.files['apps/a.json'], curated);
  assert.equal(ctx.logs.length, 0);
});

test('a type that is not enabled stays as it is', async () => {
  const off = withUpload({
    imageUpload: { enabled: false, supportedFormats: IMAGE_DEFAULT },
    audioUpload: {},
    videoUpload: { supportedFormats: ['video/mp4', 'video/webm', 'video/quicktime'] }
  });
  const ctx = fakeCtx({ 'config/mimetypes.json': mimetypes(), 'apps/a.json': off });
  await up(ctx);
  assert.deepEqual(ctx.files['apps/a.json'], off);
});

test('apps without upload settings are not touched, and a second run changes nothing', async () => {
  const ctx = fakeCtx({
    'config/mimetypes.json': mimetypes(),
    'apps/plain.json': { id: 'plain' },
    'apps/a.json': withUpload({ imageUpload: { enabled: true, supportedFormats: IMAGE_DEFAULT } })
  });
  await up(ctx);
  assert.deepEqual(ctx.files['apps/plain.json'], { id: 'plain' });
  const afterFirst = JSON.stringify(ctx.files['apps/a.json']);
  ctx.logs.length = 0;
  await up(ctx);
  assert.equal(JSON.stringify(ctx.files['apps/a.json']), afterFirst);
  assert.equal(ctx.logs.length, 0);
});

test('the category of the installed mimetypes.json is used, the shipped one without it', async () => {
  const custom = mimetypes();
  custom.categories.images.mimeTypes = ['image/png', 'image/svg+xml'];
  const withCustom = fakeCtx({
    'config/mimetypes.json': custom,
    'apps/a.json': withUpload({ imageUpload: { enabled: true } })
  });
  await up(withCustom);
  assert.deepEqual(withCustom.files['apps/a.json'].upload.imageUpload.supportedFormats, [
    'image/png',
    'image/svg+xml'
  ]);

  const shipped = fakeCtx({ 'apps/a.json': withUpload({ imageUpload: { enabled: true } }) });
  await up(shipped);
  assert.deepEqual(
    shipped.files['apps/a.json'].upload.imageUpload.supportedFormats,
    CATEGORIES.images
  );
});
