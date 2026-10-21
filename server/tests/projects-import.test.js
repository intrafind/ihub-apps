// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The startup import of file-backed admin project items (#1036, spec 1
 * §8.4): a migrated `import` pointer is extracted, encrypted and cleared
 * and its plaintext copy under `contents/` removed; a managed file is
 * re-imported when the shipped default changes; a missing file fails the
 * item with a code the admin page shows.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import {
  LocalFileKeyProvider,
  _resetKeyProvider,
  registerKeyProvider
} from '../services/projects/crypto/KeyProvider.js';
import {
  bootstrapProjects,
  getIngestService,
  shutdownProjects
} from '../services/projects/bootstrap.js';
import { getProjectRepository } from '../services/projects/ProjectRepository.js';
import { getItemText, evictItemText } from '../services/knowledge/ItemTextService.js';
import {
  importPendingProjects,
  resolveImportFile,
  safeRelativeFile
} from '../services/projects/projectImport.js';

const MASTER = crypto.createHash('sha256').update('import-master').digest('hex');
const SYSTEM = { id: 'system', name: 'Tests' };

let scratch;
let defaultsDir;

function item(id, extra) {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'upload',
    name: `${id}.md`,
    ref: { contentType: 'text/markdown' },
    storage: 'text',
    pinned: false,
    status: 'pending',
    error: null,
    provenance: { origin: 'migrated', by: SYSTEM, at: now, run: null, source: null },
    snapshotAt: null,
    createdAt: now,
    updatedAt: now,
    ...extra
  };
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-import-'));
  defaultsDir = path.join(scratch, 'defaults');
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
  configCache.setCacheEntry('config/features.json', { projects: true });
  configCache.setCacheEntry('config/projects.json', []);
  registerKeyProvider(
    'local-file',
    () => new LocalFileKeyProvider({ readMasterKey: () => MASTER, readPreviousKey: () => null })
  );
  _resetKeyProvider();
  await bootstrapProjects({ reconcile: false });
  getIngestService().tempDir = path.join(scratch, 'uploads');
});

after(async () => {
  shutdownProjects();
  evictItemText();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('import pointers', () => {
  it('refuses paths that leave the directory', async () => {
    assert.equal(safeRelativeFile('sources/faq.md'), 'sources/faq.md');
    assert.equal(safeRelativeFile('./sources/../sources/faq.md'), 'sources/faq.md');
    assert.equal(safeRelativeFile('../etc/passwd'), null);
    assert.equal(safeRelativeFile('/etc/passwd'), null);
    assert.equal(safeRelativeFile('sources/../../x'), null);
    assert.equal(safeRelativeFile(''), null);
    assert.equal(await resolveImportFile('../x', { contentsDir: scratch, defaultsDir }), null);
  });

  it('prefers the installation copy and falls back to the shipped default', async () => {
    await write(path.join(scratch, 'sources/both.md'), 'contents');
    await write(path.join(defaultsDir, 'sources/both.md'), 'defaults');
    await write(path.join(defaultsDir, 'sources/only-default.md'), 'defaults');
    const dirs = { contentsDir: scratch, defaultsDir };
    assert.deepEqual(await resolveImportFile('sources/both.md', dirs), {
      path: path.join(scratch, 'sources/both.md'),
      where: 'contents'
    });
    assert.deepEqual(await resolveImportFile('sources/only-default.md', dirs), {
      path: path.join(defaultsDir, 'sources/only-default.md'),
      where: 'defaults'
    });
    assert.equal(await resolveImportFile('sources/nowhere.md', dirs), null);
  });
});

describe('importPendingProjects', () => {
  it('imports pointers, re-imports managed files on change and fails missing ones', async () => {
    const repository = getProjectRepository();
    await write(path.join(scratch, 'sources/faq.md'), '# FAQ\n\nThe rent is due monthly.');
    await write(path.join(defaultsDir, 'sources/docs.md'), '# Docs v1\n\nFirst edition.');
    await write(path.join(scratch, 'sources/docs.md'), '# Docs v0\n\nAn older synced copy.');
    await repository.createAdmin(
      {
        id: 'imported',
        name: { en: 'Imported' },
        items: [
          item('itm_faq', { import: { file: 'sources/faq.md', encoding: 'utf-8' } }),
          item('itm_docs', { managedFile: 'sources/docs.md' }),
          item('itm_gone', { import: { file: 'sources/missing.md' } }),
          item('itm_link', {
            kind: 'url',
            storage: 'link',
            status: 'ready',
            ref: { url: 'https://example.com' }
          })
        ]
      },
      { actor: SYSTEM }
    );

    const first = await importPendingProjects({ contentsDir: scratch, defaultsDir });
    assert.equal(first.scanned, 4);
    assert.equal(first.imported, 2);
    assert.equal(first.failed, 1);
    assert.equal(first.skipped, 1);

    let project = await repository.get('imported');
    const faq = project.items.find(entry => entry.id === 'itm_faq');
    assert.equal(faq.status, 'ready');
    assert.equal(faq.import, undefined, 'the pointer is cleared');
    assert.equal(faq.snapshotAt, null);
    assert.match((await getItemText(project, faq, { user: SYSTEM })).text, /rent is due monthly/);
    await assert.rejects(
      fs.stat(path.join(scratch, 'sources/faq.md')),
      'the plaintext copy is gone'
    );

    const docs = project.items.find(entry => entry.id === 'itm_docs');
    assert.equal(docs.status, 'ready');
    assert.equal(docs.managedFile, 'sources/docs.md');
    assert.equal(docs.managedSha256.length, 64);
    await fs.stat(path.join(defaultsDir, 'sources/docs.md'));
    await assert.rejects(fs.stat(path.join(scratch, 'sources/docs.md')), 'the synced copy is gone');
    const firstBlob = docs.text.blobKey;

    const gone = project.items.find(entry => entry.id === 'itm_gone');
    assert.equal(gone.status, 'failed');
    assert.equal(gone.error.code, 'IMPORT_MISSING');

    // Nothing changed: the managed file is left as it is, the failed one retried.
    const second = await importPendingProjects({ contentsDir: scratch, defaultsDir });
    assert.equal(second.imported, 0);
    assert.equal(second.failed, 1);
    assert.equal(second.skipped, 3);

    // The shipped default changed: re-imported, old blob gone.
    await write(path.join(defaultsDir, 'sources/docs.md'), '# Docs v2\n\nSecond edition.');
    const third = await importPendingProjects({ contentsDir: scratch, defaultsDir });
    assert.equal(third.imported, 1);
    project = await repository.get('imported');
    const docs2 = project.items.find(entry => entry.id === 'itm_docs');
    assert.notEqual(docs2.text.blobKey, firstBlob);
    assert.notEqual(docs2.managedSha256, docs.managedSha256);
    assert.match((await getItemText(project, docs2, { user: SYSTEM })).text, /Second edition/);
    assert.equal(await repository.blobs.get('project-files', firstBlob), null);

    // The missing file appears: the retry succeeds and the pointer clears.
    await write(path.join(scratch, 'sources/missing.md'), 'Found after all.');
    const fourth = await importPendingProjects({ contentsDir: scratch, defaultsDir });
    assert.equal(fourth.imported, 1);
    assert.equal(fourth.failed, 0);
    project = await repository.get('imported');
    const found = project.items.find(entry => entry.id === 'itm_gone');
    assert.equal(found.status, 'ready');
    assert.equal(found.error, null);
    assert.equal(found.import, undefined);
  });

  it('deletes a shared plaintext file only after the last item importing it is ready', async () => {
    const repository = getProjectRepository();
    await write(path.join(scratch, 'sources/shared.md'), '# Shared\n\nOne file, two projects.');
    for (const id of ['shared-a', 'shared-b']) {
      await repository.createAdmin(
        {
          id,
          name: { en: id },
          items: [item(`itm_${id}`, { import: { file: 'sources/shared.md' } })]
        },
        { actor: SYSTEM }
      );
    }
    const result = await importPendingProjects({ contentsDir: scratch, defaultsDir });
    assert.equal(result.imported, 2);
    assert.equal(result.failed, 0);
    for (const id of ['shared-a', 'shared-b']) {
      const project = await repository.get(id);
      assert.equal(project.items[0].status, 'ready', id);
      assert.match(
        (await getItemText(project, project.items[0], { user: SYSTEM })).text,
        /two projects/
      );
    }
    await assert.rejects(
      fs.stat(path.join(scratch, 'sources/shared.md')),
      'gone after the last import'
    );
  });
});
