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
import { describeStored, ingestChatFile } from '../services/chatFiles/ChatFileService.js';
import { chatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import { getChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import {
  chatRecognizesText,
  declaredRecognizableImageType,
  mergeRecognizedPages,
  ocrSettings,
  pageNumbersOf,
  pagesWithoutText,
  recognizableImageTypeOf,
  recognizedTextOf
} from '../services/ocr/textRecognition.js';
import { discoverIntegrationTools } from '../services/integrations/integrationTools.js';
import {
  getDefinitionTypes,
  publishDefinitionTypes
} from '../services/integrations/integrationTypes.js';
import {
  fixtureIntegrations,
  fixtureTool,
  registerFixtureTools,
  unregisterFixtureTools
} from './helpers/integrationToolFixture.js';

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
    if (content && typeof content === 'object') {
      // Text above a chart-sized picture: half the page.
      page.drawText(content.text, { x: 20, y: 270, size: 10, font, maxWidth: 360, lineHeight: 12 });
      page.drawImage(picture, { x: 20, y: 20, width: 360, height: 200 });
    } else if (typeof content === 'string') {
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
  await unregisterFixtureTools();
  shutdownProjects();
  evictItemText();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('text recognition helpers', () => {
  it('reads the settings, with no model meaning no recognition', () => {
    const off = ocrSettings({});
    assert.equal(off.engine, 'model');
    assert.equal(off.modelId, null);
    assert.equal(off.integrationId, null);
    assert.equal(off.maxPages, 50);
    assert.equal(off.enabled, false);
    assert.deepEqual(off.imageTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const on = ocrSettings({ ocr: { engine: 'model', modelId: ' ocr-vision ', maxPages: 3 } });
    assert.equal(on.modelId, 'ocr-vision');
    assert.equal(on.maxPages, 3);
    assert.equal(on.enabled, true);
  });

  it('counts the model engine as ready only while the model exists, is on and reads images', () => {
    assert.equal(ocrSettings({ ocr: { modelId: 'text-only' } }).enabled, false, 'no vision');
    assert.equal(ocrSettings({ ocr: { modelId: 'gone-model' } }).enabled, false, 'not configured');
    configCache.setCacheEntry('config/models.json', [{ ...OCR_MODEL, enabled: false }, TEXT_MODEL]);
    try {
      assert.equal(ocrSettings({ ocr: { modelId: 'ocr-vision' } }).enabled, false, 'switched off');
    } finally {
      configCache.setCacheEntry('config/models.json', [OCR_MODEL, TEXT_MODEL]);
    }
  });

  it('reads an OCR integration as the engine, ready only while it is installed and on', () => {
    configCache.setCacheEntry('config/integrations.json', {
      installed: [
        { id: 'scanner-ocr', definition: 'acme/ocr' },
        { id: 'off-ocr', definition: 'acme/ocr', enabled: false }
      ]
    });
    try {
      const on = ocrSettings({ ocr: { engine: 'scanner-ocr' } });
      assert.equal(on.engine, 'scanner-ocr');
      assert.equal(on.integrationId, 'scanner-ocr');
      assert.equal(on.enabled, true, 'needs no model');
      assert.equal(ocrSettings({ ocr: { engine: 'off-ocr', modelId: 'm' } }).enabled, false);
      assert.equal(ocrSettings({ ocr: { engine: 'gone-ocr' } }).enabled, false);
    } finally {
      configCache.setCacheEntry('config/integrations.json', { installed: [] });
    }
  });

  it('reads the answer of an OCR integration: a string, a text, pages, or an error', () => {
    assert.equal(recognizedTextOf('  plain  '), 'plain');
    assert.equal(recognizedTextOf({ text: 'field ' }), 'field');
    assert.equal(
      recognizedTextOf({ pages: [{ text: 'one' }, 'two', { text: ' ' }] }),
      'one\n\ntwo'
    );
    assert.throws(
      () => recognizedTextOf({ error: true, status: 415, message: 'no webp' }),
      error => error.status === 415 && /no webp/.test(error.message)
    );
    assert.throws(() => recognizedTextOf({ result: 'x' }), /without a text/);
  });

  it('recognizes in chats only where it is switched on, the app over the installation', () => {
    const on = { ocr: { modelId: 'ocr-vision' }, uploads: { recognizeText: true } };
    const off = { ocr: { modelId: 'ocr-vision' }, uploads: { recognizeText: false } };
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

  it('puts a recognized page with text in place of its lines, keeping its marker', () => {
    const extracted = [
      '[Page 1 (printed: i)]',
      'Old line one',
      'Old line two',
      '',
      '[Page 2]',
      'Kept text',
      '',
      '[Page 3: no extractable text]'
    ].join('\n');
    const merged = mergeRecognizedPages(
      extracted,
      new Map([
        [1, 'Text and chart of page 1'],
        [3, 'Scanned page 3']
      ])
    );
    assert.equal(
      merged,
      '[Page 1 (printed: i)]\nText and chart of page 1\n\n[Page 2]\nKept text\n\n[Page 3]\nScanned page 3'
    );
    assert.deepEqual(pageNumbersOf(extracted), [1, 2, 3]);
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

  it('with a model that cannot read images, refuses an image as without recognition', async () => {
    setPlatform({ ocr: { modelId: 'text-only' } });
    await createProject('ocr-text-model');
    const { error } = await upload('ocr-text-model', 'no-vision.png', png(30), 'image/png');
    assert.equal(error?.code, 'UNSUPPORTED_TYPE');
    assert.equal(calls.length, 0);
  });

  it('keeps the text of a text PDF when its pages without text cannot be read', async () => {
    await createProject('ocr-best-effort');
    // The engine refuses: before recognition this PDF was stored with its text.
    answer = 400;
    const refused = await upload(
      'ocr-best-effort',
      'refused-mixed.pdf',
      await pdfOf([TEXT_PAGE, null]),
      'application/pdf'
    );
    assert.equal(refused.item.status, 'ready', JSON.stringify(refused.item.error));
    const text = await readText(refused.project, refused.item);
    assert.match(text, /real text layer/);
    assert.match(text, /\[Page 2: no extractable text\]/);
    assert.equal(refused.item.text.recognized, undefined);

    // A blank page: the engine reads nothing.
    answer = () => '';
    const blank = await upload(
      'ocr-best-effort',
      'blank-mixed.pdf',
      await pdfOf([TEXT_PAGE, null]),
      'application/pdf'
    );
    assert.equal(blank.item.status, 'ready', JSON.stringify(blank.item.error));
    assert.match(await readText(blank.project, blank.item), /\[Page 2: no extractable text\]/);
  });

  it('sends no further page once the engine has refused one', async () => {
    answer = 400;
    await createProject('ocr-stop');
    const { error } = await upload(
      'ocr-stop',
      'scan-refused.pdf',
      await pdfOf([null, null, null, null, null, null, null]),
      'application/pdf'
    );
    assert.equal(error?.code, 'OCR_FAILED');
    assert.ok(calls.length <= 3, `${calls.length} pages were sent after the refusal`);
  });

  it('smart: also reads a page with text whose picture covers much of it', async () => {
    setPlatform({ ocr: { modelId: 'ocr-vision', pages: 'smart', minFigurePercent: 20 } });
    await createProject('ocr-smart');
    const { project, item } = await upload(
      'ocr-smart',
      'report.pdf',
      await pdfOf([{ text: TEXT_PAGE }, TEXT_PAGE]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 1, 'only the page with the chart is sent');
    const text = await readText(project, item);
    assert.match(text, /\[Page 1\]\nRecognized text of page 1/);
    assert.match(text, /\[Page 2\]\nThis page has a real text layer/);
    assert.equal(item.text.recognized.pages, 1);
  });

  it('scanned: reads no page that has text; all: reads every page', async () => {
    const pdf = await pdfOf([{ text: TEXT_PAGE }, TEXT_PAGE]);
    setPlatform({ ocr: { modelId: 'ocr-vision', pages: 'scanned' } });
    await createProject('ocr-modes');
    const scanned = await upload('ocr-modes', 'scanned-mode.pdf', pdf, 'application/pdf');
    assert.equal(scanned.item.status, 'ready', JSON.stringify(scanned.item.error));
    assert.equal(calls.length, 0);
    assert.equal(scanned.item.text.recognized, undefined);

    setPlatform({ ocr: { modelId: 'ocr-vision', pages: 'all' } });
    const all = await upload('ocr-modes', 'all-mode.pdf', pdf, 'application/pdf');
    assert.equal(all.item.status, 'ready', JSON.stringify(all.item.error));
    assert.equal(calls.length, 2);
    assert.equal(all.item.text.recognized.pages, 2);
  });

  it('keeps the extracted text of a page with text when its recognition fails', async () => {
    setPlatform({ ocr: { modelId: 'ocr-vision', pages: 'all' } });
    answer = n => {
      if (n === 1) throw Object.assign(new Error('upstream timeout'), { status: 504 });
      return `Recognized text of call ${n}.`;
    };
    await createProject('ocr-keep-page');
    const { project, item } = await upload(
      'ocr-keep-page',
      'keep.pdf',
      await pdfOf([TEXT_PAGE, TEXT_PAGE]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    const text = await readText(project, item);
    assert.match(text, /real text layer/, 'the page that failed keeps its text');
    assert.match(text, /Recognized text of call 2/);
    assert.equal(item.text.recognized.failedPages, 1);
  });

  it('counts the pages that failed apart from the page limit', async () => {
    answer = n => {
      if (n === 2) throw Object.assign(new Error('upstream timeout'), { status: 504 });
      return `Recognized text of call ${n}.`;
    };
    await createProject('ocr-failed-page');
    const { item } = await upload(
      'ocr-failed-page',
      'flaky-scan.pdf',
      await pdfOf([null, null, null]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(item.text.recognized.pages, 2);
    assert.equal(item.text.recognized.failedPages, 1);
    assert.equal(item.text.recognized.truncated, undefined, 'no page limit was hit');
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
    // The transcript says so after a reload too: a document read as text, not a picture.
    assert.equal(describeStored(image.file).recognized.modelId, 'ocr-vision');
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

describe('an OCR integration as the engine', () => {
  let received;
  let reply;

  before(async () => {
    await registerFixtureTools([
      fixtureTool('test-ocr', {
        type: 'ocr',
        action: 'recognize',
        run: async args => {
          received.push(args);
          if (typeof reply === 'function') return reply(args, received.length);
          return reply;
        }
      })
    ]);
  });

  beforeEach(() => {
    received = [];
    reply = (_args, n) => ({ text: `Service text of call ${n}` });
    configCache.setCacheEntry('config/integrations.json', fixtureIntegrations('test-ocr'));
    setPlatform({ ocr: { engine: 'test-ocr', maxPages: 50 } });
  });

  after(() => {
    configCache.setCacheEntry('config/integrations.json', { installed: [] });
  });

  it('sends an image to the integration, not to a model, and records it', async () => {
    await createProject('ocr-engine-image');
    const picture = png(77);
    const { project, item } = await upload('ocr-engine-image', 'note.png', picture, 'image/png');
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(calls.length, 0, 'no model call');
    assert.equal(received.length, 1);
    assert.equal(received[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(received[0].content, 'base64'), picture);
    assert.equal(received[0].name, 'note.png');
    assert.match(await readText(project, item), /Service text of call 1/);
    assert.equal(item.text.recognized.integrationId, 'test-ocr');
    assert.equal(item.text.recognized.modelId, undefined);
  });

  it('sends only the scanned pages of a PDF, each as a PNG', async () => {
    await createProject('ocr-engine-pdf');
    const { project, item } = await upload(
      'ocr-engine-pdf',
      'mixed-engine.pdf',
      await pdfOf([TEXT_PAGE, null, null]),
      'application/pdf'
    );
    assert.equal(item.status, 'ready', JSON.stringify(item.error));
    assert.equal(received.length, 2);
    assert.ok(received.every(args => args.mimeType === 'image/png'));
    assert.ok(
      received.every(args =>
        Buffer.from(args.content, 'base64').subarray(1, 4).equals(Buffer.from('PNG'))
      )
    );
    const text = await readText(project, item);
    assert.match(text, /real text layer/);
    assert.match(text, /\[Page 2\]\nService text/);
    assert.match(text, /\[Page 3\]\nService text/);
    assert.equal(item.text.recognized.pages, 2);
  });

  it('fails the document when the integration refuses (4xx)', async () => {
    reply = { error: true, status: 415, message: 'type not read' };
    await createProject('ocr-engine-refused');
    const { error } = await upload('ocr-engine-refused', 'pic.png', png(5), 'image/png');
    assert.equal(error?.code, 'OCR_FAILED');
    assert.match(error?.message || '', /test-ocr refused the request \(415\)/);
  });

  it('is unavailable while the integration is switched off', async () => {
    configCache.setCacheEntry('config/integrations.json', {
      ...fixtureIntegrations('test-ocr'),
      installed: fixtureIntegrations('test-ocr').installed.map(entry => ({
        ...entry,
        enabled: false
      }))
    });
    await createProject('ocr-engine-off');
    const { error } = await upload('ocr-engine-off', 'off.png', png(6), 'image/png');
    assert.ok(error, 'an image is not accepted without a ready engine');
    assert.equal(received.length, 0);
  });

  it('takes only the image types the engine declares', async () => {
    // An engine whose recognize action declares PNG only.
    const loaded = Object.entries(getDefinitionTypes()).map(([id, type]) => ({
      definition: { id, type }
    }));
    publishDefinitionTypes([
      ...loaded,
      {
        definition: {
          id: 'test.ocr/png-only',
          type: 'ocr',
          actions: [
            {
              name: 'recognize',
              parameters: {
                type: 'object',
                properties: { mimeType: { type: 'string', enum: ['image/PNG'] } }
              }
            }
          ]
        }
      }
    ]);
    configCache.setCacheEntry('config/integrations.json', {
      installed: [{ id: 'png-ocr', definition: 'test.ocr/png-only' }]
    });
    setPlatform({ ocr: { engine: 'png-ocr' } });
    try {
      const settings = ocrSettings();
      assert.equal(settings.enabled, true);
      assert.deepEqual(settings.imageTypes, ['image/png']);
      assert.deepEqual(settings.imageExtensions, ['.png']);
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
      assert.equal(recognizableImageTypeOf(webp), null);
      assert.equal(recognizableImageTypeOf(png()), 'image/png');
      assert.equal(declaredRecognizableImageType({ name: 'photo.webp' }), null);

      await createProject('ocr-engine-types');
      const refused = await upload('ocr-engine-types', 'photo.webp', webp, 'image/webp');
      assert.equal(refused.error?.code, 'UNSUPPORTED_TYPE');
      assert.equal(received.length, 0);
    } finally {
      publishDefinitionTypes(loaded);
    }
  });

  it('is no tool for a model', async () => {
    const tools = await discoverIntegrationTools('en');
    assert.equal(
      tools.some(tool => tool._integration?.instanceId === 'test-ocr'),
      false
    );
  });

  it('recognizes chat uploads too, when chats recognize text', async () => {
    setPlatform({ ocr: { engine: 'test-ocr' }, uploads: { recognizeText: true } });
    const scope = { type: 'chat', id: 'ocr-engine-chat' };
    const store = getChatFileRepository();
    const file = await ingestChatFile({
      scope,
      ownerId: ADMIN.id,
      name: 'chat.png',
      mimeType: 'image/png',
      buffer: png(90),
      policy: chatFilePolicy(null),
      store
    });
    assert.equal(file.meta.recognized.integrationId, 'test-ocr');
    assert.match((await store.getText(scope, file.id)).text, /Service text of call 1/);
  });
});
