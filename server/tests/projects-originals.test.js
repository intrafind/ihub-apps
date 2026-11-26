// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The original file of a project upload: kept, encrypted, next to the text
 * when `platform.uploads.storageMode` is `original_and_text` (the setting chat
 * uploads use, and its default); not kept in the text-only modes. It follows
 * the item through a copy, goes when the item goes and when its text is
 * replaced, and is served by `GET …/items/:itemId/original`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import {
  LocalFileKeyProvider,
  _resetKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import { bootstrapProjects, shutdownProjects } from '../services/projects/bootstrap.js';
import {
  PROJECT_FILES_NAMESPACE,
  getProjectRepository
} from '../services/projects/ProjectRepository.js';
import { getProjectService } from '../services/projects/ProjectService.js';
import { readOriginal, readText } from '../services/projects/ItemTextStore.js';
import { serializeItem } from '../services/projects/projectView.js';
import { sendItemOriginal } from '../routes/projectItemRoutes.js';
import { evictItemText } from '../services/knowledge/ItemTextService.js';

const MASTER = crypto.createHash('sha256').update('originals-master').digest('hex');
const ADMIN = { id: 'admin', name: 'Admin' };
const MARKDOWN = Buffer.from('# Offer\n\nThe offer for ACME, version 3.\n', 'utf8');

let scratch;
let service;
let repository;

function setPlatform(uploads = {}) {
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    uploads,
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

async function createProject(id) {
  return service.createAdminProject(
    { id, name: { en: id }, tier: 'ihub', enabled: true, tags: [], items: [] },
    { actor: ADMIN }
  );
}

async function upload(projectId, name = 'offer.md', buffer = MARKDOWN) {
  const { item } = await service.addItem(
    projectId,
    {
      kind: 'upload',
      ref: {},
      file: { buffer, name, contentType: 'text/markdown' }
    },
    { user: ADMIN, wait: true }
  );
  return item;
}

async function stored(projectId, itemId) {
  const project = await repository.get(projectId);
  return { project, item: project.items.find(entry => entry.id === itemId) };
}

async function blobKeys(prefix) {
  const page = await repository.blobs.list(PROJECT_FILES_NAMESPACE, { prefix, limit: 100 });
  return page.items.map(entry => entry.key);
}

function fakeResponse() {
  const res = {
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-originals-'));
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
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
  service = getProjectService();
  repository = getProjectRepository();
});

beforeEach(() => setPlatform());

after(async () => {
  shutdownProjects();
  evictItemText();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('project originals', () => {
  it('keeps the original of an upload by default, encrypted, next to its text', async () => {
    await createProject('orig-default');
    const added = await upload('orig-default');
    const { project, item } = await stored('orig-default', added.id);

    assert.equal(item.status, 'ready');
    assert.ok(item.originalFile?.blobKey, 'the item records its original');
    assert.notEqual(item.originalFile.blobKey, item.text.blobKey);
    assert.equal(item.originalFile.size, MARKDOWN.length);
    assert.equal(item.originalFile.name, 'offer.md');
    assert.deepEqual(await readOriginal(project, item), MARKDOWN);
    assert.match(await readText(project, item), /ACME/);

    // Encrypted at rest: the stored blob is not the file.
    const blob = await repository.blobs.get(PROJECT_FILES_NAMESPACE, item.originalFile.blobKey);
    assert.ok(!blob.data.includes(Buffer.from('ACME')));

    const view = serializeItem(item, project);
    assert.equal(view.hasOriginal, true);
    assert.equal(view.original.name, 'offer.md');
    assert.equal(view.original.size, MARKDOWN.length);
    assert.equal(view.originalFile, undefined, 'the wrapped key never leaves the server');
  });

  it('keeps only the text in the text-only modes', async () => {
    for (const storageMode of ['server_text_only', 'client_text_only']) {
      setPlatform({ storageMode });
      const id = `orig-${storageMode.replace(/_/g, '-')}`;
      await createProject(id);
      const added = await upload(id);
      const { project, item } = await stored(id, added.id);
      assert.equal(item.status, 'ready');
      assert.equal(item.originalFile, undefined, storageMode);
      assert.equal(serializeItem(item, project).hasOriginal, false);
      assert.equal((await blobKeys(`${id}__${item.id}__`)).length, 1, 'only the text blob');
    }
  });

  it('drops the original when the text is edited', async () => {
    await createProject('orig-edit');
    const added = await upload('orig-edit');
    const before = (await stored('orig-edit', added.id)).item.originalFile.blobKey;

    await service.replaceItemText('orig-edit', added.id, 'A new text, typed by hand.', {
      user: ADMIN
    });

    const { item } = await stored('orig-edit', added.id);
    assert.equal(item.originalFile, undefined);
    const keys = await blobKeys(`orig-edit__${added.id}__`);
    assert.ok(!keys.includes(before), 'the old original blob is deleted');
    assert.deepEqual(keys, [item.text.blobKey]);
  });

  it('copies the original with the item, encrypted again for the target', async () => {
    await createProject('orig-copy-from');
    await createProject('orig-copy-to');
    const added = await upload('orig-copy-from');

    const result = await service.transferItems('orig-copy-from', [added.id], 'orig-copy-to', {
      mode: 'copy',
      user: ADMIN
    });
    assert.equal(result.failed.length, 0);

    const target = await repository.get('orig-copy-to');
    const copy = target.items[0];
    assert.ok(copy.originalFile?.blobKey.startsWith(`orig-copy-to__${copy.id}__`));
    assert.deepEqual(await readOriginal(target, copy), MARKDOWN);
    // The source keeps its own.
    const { project, item } = await stored('orig-copy-from', added.id);
    assert.deepEqual(await readOriginal(project, item), MARKDOWN);
  });

  it('deletes the original with the item', async () => {
    await createProject('orig-remove');
    const added = await upload('orig-remove');
    assert.equal((await blobKeys(`orig-remove__${added.id}__`)).length, 2);

    await service.removeItem('orig-remove', added.id, { user: ADMIN });

    assert.deepEqual(await blobKeys(`orig-remove__${added.id}__`), []);
  });

  it('serves the original, and 410 when only the text is stored', async () => {
    await createProject('orig-serve');
    const added = await upload('orig-serve');
    const project = await repository.get('orig-serve');

    const res = fakeResponse();
    await sendItemOriginal(
      { params: { itemId: added.id }, query: { download: '1' }, user: ADMIN },
      res,
      { project }
    );
    assert.deepEqual(res.body, MARKDOWN);
    assert.match(res.headers['content-type'], /^text\/markdown/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-disposition'], /^attachment;.*offer\.md/);

    setPlatform({ storageMode: 'server_text_only' });
    const textOnly = await upload('orig-serve', 'plain.md');
    const after = await repository.get('orig-serve');
    await assert.rejects(
      sendItemOriginal(
        { params: { itemId: textOnly.id }, query: {}, user: ADMIN },
        fakeResponse(),
        {
          project: after
        }
      ),
      error => error.code === 'ORIGINAL_DISCARDED'
    );
  });

  it('serves an HTML original sandboxed, so its script cannot run', async () => {
    await createProject('orig-html');
    const html = Buffer.from('<html><body><script>alert(1)</script><p>Hi</p></body></html>');
    const { item: added } = await service.addItem(
      'orig-html',
      {
        kind: 'upload',
        ref: {},
        file: { buffer: html, name: 'page.html', contentType: 'text/html' }
      },
      { user: ADMIN, wait: true }
    );
    const project = await repository.get('orig-html');
    const res = fakeResponse();
    await sendItemOriginal({ params: { itemId: added.id }, query: {}, user: ADMIN }, res, {
      project
    });
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.doesNotMatch(res.headers['content-security-policy'], /allow-scripts/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});
