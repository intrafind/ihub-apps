// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text recognition at upload (#3986): images and the scanned pages of PDFs are
 * read once by the installation's OCR model and stored as the document's text.
 * The model is stubbed: these tests check what is sent, what is stored and
 * what happens without a model.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PNG } from 'pngjs';

import configCache from '../configCache.js';
import llmClient from '../services/loop/LLMClient.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import {
  LocalFileKeyProvider,
  _resetKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import { bootstrapProjects, shutdownProjects } from '../services/projects/bootstrap.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import { readOriginal, readText } from '../services/projects/ItemTextStore.js';
import { serializeItem } from '../services/projects/projectView.js';
import { evictItemText } from '../services/knowledge/ItemTextService.js';
import { ingestChatFile } from '../services/chatFiles/ChatFileService.js';
import { chatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { getChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import {
  chatRecognizesText,
  declaredRecognizableImageType,
  mergeRecognizedPages,
  ocrSettings,
  pagesWithoutText,
  recognizableImageTypeOf
} from '../services/ocr/textRecognition.js';

const MASTER = crypto.createHash('sha256').update('text-recognition-master').digest('hex');
const ADMIN = { id: 'admin', name: 'Admin' };
const OCR_MODEL = {
  id: 'ocr-vision',
  modelId: 'ocr-vision',
  name: { en: 'OCR vision' },
  provider: 'local',
  url: 'http://localhost:9/v1/chat/completions',
  supportsImages: true,
  enabled: true
};
const TEXT_MODEL = { ...OCR_MODEL, id: 'text-only', modelId: 'text-only', supportsImages: false };

let scratch;
let service;
let repository;
let calls;
let answer;
const originalComplete = llmClient.complete;

function setPlatform({ ocr, uploads } = {}) {
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    ...(ocr ? { ocr } : {}),
    ...(uploads ? { uploads } : {}),
    projects: {
      limits: {
        maxFiles: 25,
        maxFileBytes: 20 * 1024 * 1024,
        maxProjectBytes: 200 * 1024 * 1024,
        maxProjectsPerUser: 0
      }
    }
  });
}

/** A small PNG, the colour seeded by `shade`. */
function png(shade = 120) {
  const image = new PNG({ width: 40, height: 20 });
  image.data.fill(shade);
  return PNG.sync.write(image);
}

/** A PDF of pages that are either text (a string) or a picture (`null`). */
async function pdfOf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const picture = await doc.embedPng(png());
  for (const content of pages) {
    const page = doc.addPage([400, 300]);
    if (typeof content === 'string') {
      page.drawText(content, { x: 20, y: 250, size: 10, font, maxWidth: 360, lineHeight: 12 });
    } else {
      page.drawImage(picture, { x: 20, y: 20, width: 360, height: 260 });
    }
  }
  return Buffer.from(await doc.save());
}

const TEXT_PAGE =
  'This page has a real text layer with enough words to count as text, well over fifty characters.';

async function createProject(id) {
  return service.createAdminProject(
    { id, name: { en: id }, tier: 'ihub', enabled: true, tags: [], items: [] },
    { actor: ADMIN }
  );
}

async function upload(projectId, name, buffer, contentType) {
  try {
    await service.addItem(
      projectId,
      { kind: 'upload', ref: {}, file: { buffer, name, contentType } },
      { user: ADMIN, wait: true }
    );
  } catch (error) {
    // A failed inline job removes the item: the caller gets the error.
    return { error };
  }
  const project = await repository.get(projectId);
  return { project, item: project.items.find(entry => entry.name === name) };
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-text-recognition-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  setPlatform();
  configCache.setCacheEntry('config/features.json', { projects: true });
  configCache.setCacheEntry('config/projects.json', []);
  configCache.setCacheEntry('config/apps.json', []);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/models.json', [OCR_MODEL, TEXT_MODEL]);
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
  service = getProjectService();
  repository = getProjectRepository();
});

beforeEach(() => {
  calls = [];
  answer = n => `Recognized text of page ${n}: an invoice from ACME.`;
  llmClient.complete = async params => {
    calls.push(params);
    const status = typeof answer === 'number' ? answer : null;
    if (status) throw Object.assign(new Error('refused'), { status });
    return { content: answer(calls.length) };
  };
  setPlatform({ ocr: { modelId: 'ocr-vision', maxPages: 50 } });
});

after(async () => {
  llmClient.complete = originalComplete;
  shutdownProjects();
  evictItemText();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('text recognition helpers', () => {
  it('reads the settings, with no model meaning no recognition', () => {
    assert.deepEqual(ocrSettings({}), { modelId: null, maxPages: 50, enabled: false });
    assert.deepEqual(ocrSettings({ ocr: { modelId: ' m ', maxPages: 3 } }), {
      modelId: 'm',
      maxPages: 3,
      enabled: true
    });
  });

  it('recognizes in chats only where it is switched on, the app over the installation', () => {
    const on = { ocr: { modelId: 'm' }, uploads: { recognizeText: true } };
    const off = { ocr: { modelId: 'm' }, uploads: { recognizeText: false } };
    assert.equal(chatRecognizesText(on, null), true);
    assert.equal(chatRecognizesText(off, null), false);
    assert.equal(chatRecognizesText(off, { uploads: { recognizeText: true } }), true);
    assert.equal(chatRecognizesText(on, { uploads: { recognizeText: false } }), false);
    // No model: never, whatever the switches say.
    assert.equal(chatRecognizesText({ uploads: { recognizeText: true } }, null), false);
  });

  it('tells images by their bytes and by their declared type or name', () => {
    assert.equal(recognizableImageTypeOf(png()), 'image/png');
    assert.equal(recognizableImageTypeOf(Buffer.from('ffd8ffe000104a46', 'hex')), 'image/jpeg');
    assert.equal(recognizableImageTypeOf(Buffer.from('%PDF-1.7')), null);
    assert.equal(declaredRecognizableImageType({ name: 'scan.JPG' }), 'image/jpeg');
    assert.equal(declaredRecognizableImageType({ contentType: 'image/webp' }), 'image/webp');
    assert.equal(declaredRecognizableImageType({ name: 'photo.tiff' }), null);
  });

  it('finds the pages without text and puts the recognized text in their place', () => {
    const text = '[Page 1]\nIntro text\n\n[Page 2: no extractable text]\n\n[Page 3]\nEnd';
    assert.deepEqual(pagesWithoutText(text), [2]);
    assert.equal(
      mergeRecognizedPages(text, new Map([[2, 'Scanned words']])),
      '[Page 1]\nIntro text\n\n[Page 2]\nScanned words\n\n[Page 3]\nEnd'
    );
  });
});

describe('projects: text recognition at upload', () => {
  it('stores the recognized text of an image, and its original', async () => {
    await createProject('ocr-image');
    const picture = png();
    const { project, item } = await upload('ocr-image', 'receipt.png', picture, 'image/png');

    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.id, 'ocr-vision');
    assert.equal(calls[0].messages[0].imageData[0].fileType, 'image/png');
    assert.match(await readText(project, item), /invoice from ACME/);
    assert.deepEqual(await readOriginal(project, item), picture);
    assert.equal(item.text.recognized.modelId, 'ocr-vision');
    assert.equal(item.text.recognized.pages, 1);
    assert.equal(serializeItem(item, project).text.recognized.pages, 1);
  });

  it('recognizes every page of a PDF without a text layer', async () => {
    await createProject('ocr-scanned');
    const { project, item } = await upload(
      'ocr-scanned',
      'scan.pdf',
      await pdfOf([null, null]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 2);
    const text = await readText(project, item);
    assert.match(text, /\[Page 1\]\nRecognized text of page/);
    assert.match(text, /\[Page 2\]\nRecognized text of page/);
    assert.equal(item.text.recognized.pages, 2);
  });

  it('recognizes only the scanned pages of a mixed PDF and keeps the text layer', async () => {
    await createProject('ocr-mixed');
    const { project, item } = await upload(
      'ocr-mixed',
      'mixed.pdf',
      await pdfOf([TEXT_PAGE, null]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 1, 'the text page is not sent to the model');
    const text = await readText(project, item);
    assert.match(text, /real text layer/);
    assert.match(text, /\[Page 2\]\nRecognized text of page 1/);
    assert.doesNotMatch(text, /no extractable text/);
    assert.equal(item.text.recognized.pages, 1);
  });

  it('stops at the page limit and says so', async () => {
    setPlatform({ ocr: { modelId: 'ocr-vision', maxPages: 2 } });
    await createProject('ocr-limit');
    const { project, item } = await upload(
      'ocr-limit',
      'long-scan.pdf',
      await pdfOf([null, null, null]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 2);
    assert.equal(item.text.recognized.truncated, true);
    assert.match(await readText(project, item), /\[Page 3: no extractable text\]/);
  });

  it('fails the document when the model refuses, with the recognition code', async () => {
    answer = 400;
    await createProject('ocr-refused');
    const { error } = await upload('ocr-refused', 'refused.png', png(10), 'image/png');
    assert.equal(error?.code, 'OCR_FAILED');
  });

  it('refuses a model that cannot read images', async () => {
    setPlatform({ ocr: { modelId: 'text-only' } });
    await createProject('ocr-text-model');
    const { error } = await upload('ocr-text-model', 'no-vision.png', png(30), 'image/png');
    assert.equal(error?.code, 'OCR_UNAVAILABLE');
    assert.equal(calls.length, 0);
  });

  it('without a model, behaves as before: a scanned PDF has no text, nothing is sent', async () => {
    setPlatform();
    await createProject('ocr-off');
    const { error } = await upload(
      'ocr-off',
      'scan-off.pdf',
      await pdfOf([null]),
      'application/pdf'
    );
    assert.equal(error?.code, 'NO_TEXT');
    assert.equal(calls.length, 0);
  });

  it('sends nothing for a PDF whose pages all have text', async () => {
    await createProject('ocr-text-pdf');
    const { item } = await upload(
      'ocr-text-pdf',
      'text.pdf',
      await pdfOf([TEXT_PAGE, TEXT_PAGE]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 0);
    assert.equal(item.text.recognized, undefined);
  });
});

describe('chats: text recognition is opt-in', () => {
  let chatCounter = 0;
  async function attach(buffer, name, mimeType, appConfig = null) {
    chatCounter += 1;
    const scope = { type: 'chat', id: `ocr-chat-${chatCounter}` };
    const store = getChatFileRepository();
    const file = await ingestChatFile({
      scope,
      ownerId: ADMIN.id,
      name,
      mimeType,
      buffer,
      appConfig,
      policy: chatFilePolicy(appConfig),
      store
    });
    return { file, stored: await store.getText(scope, file.id) };
  }

  it('off (the default): an image is refused and a scanned PDF goes as page images', async () => {
    await assert.rejects(
      attach(png(), 'photo.png', 'image/png'),
      error => error.code === 'UNSUPPORTED_TYPE'
    );
    const { stored } = await attach(await pdfOf([null]), 'scan.pdf', 'application/pdf');
    assert.equal(stored.text, '');
    assert.equal(stored.pageImages.length, 1);
    assert.equal(calls.length, 0);
  });

  it('on: an image and a scanned PDF are read once, and no page images are kept', async () => {
    setPlatform({ ocr: { modelId: 'ocr-vision' }, uploads: { recognizeText: true } });
    const image = await attach(png(), 'photo.png', 'image/png');
    assert.match(image.stored.text, /invoice from ACME/);
    assert.equal(image.file.meta.recognized.modelId, 'ocr-vision');
    assert.equal(image.stored.pageImages, undefined);

    const pdf = await attach(await pdfOf([TEXT_PAGE, null]), 'mixed.pdf', 'application/pdf');
    assert.match(pdf.stored.text, /real text layer/);
    assert.match(pdf.stored.text, /\[Page 2\]\nRecognized text/);
    assert.equal(pdf.stored.pageImages, undefined);
    assert.equal(pdf.file.meta.recognized.pages, 1);
    assert.equal(calls.length, 2);
  });

  it('an app can switch it on or off for its own chats', async () => {
    setPlatform({ ocr: { modelId: 'ocr-vision' }, uploads: { recognizeText: false } });
    const app = { id: 'scanner', uploads: { recognizeText: true } };
    const { stored } = await attach(await pdfOf([null]), 'app-scan.pdf', 'application/pdf', app);
    assert.match(stored.text, /Recognized text/);
    assert.equal(stored.pageImages, undefined);
  });
});
