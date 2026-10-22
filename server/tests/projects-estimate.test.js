// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The token estimate of a project: every item is read, its tokens counted,
 * and the item and the project get a recommendation (prompt or search).
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
import { evictItemText } from '../services/knowledge/ItemTextService.js';
import { importPendingProjects } from '../services/projects/projectImport.js';
import {
  estimateProject,
  recommendForItem,
  recommendForProject
} from '../services/projects/projectEstimate.js';

const MASTER = crypto.createHash('sha256').update('estimate-master').digest('hex');
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
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-estimate-'));
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

describe('recommendations', () => {
  it('pins small documents and leaves large ones to the tools', () => {
    assert.deepEqual(recommendForItem(1000, 50000), { recommendation: 'prompt', reason: 'small' });
    assert.deepEqual(recommendForItem(10000, 50000), { recommendation: 'prompt', reason: 'small' });
    assert.deepEqual(recommendForItem(10001, 50000), { recommendation: 'search', reason: 'large' });
    assert.deepEqual(recommendForItem(null, 50000), {
      recommendation: 'unknown',
      reason: 'unmeasured'
    });
  });

  it('puts a project that fits into the prompt and searches one that does not', () => {
    assert.deepEqual(recommendForProject(20000, 50000), {
      recommendation: 'prompt',
      reason: 'comfortable'
    });
    assert.deepEqual(recommendForProject(40000, 50000), {
      recommendation: 'prompt',
      reason: 'tight'
    });
    assert.deepEqual(recommendForProject(50001, 50000), {
      recommendation: 'search',
      reason: 'exceeds'
    });
    assert.deepEqual(recommendForProject(100, 50000, { unmeasured: 1 }), {
      recommendation: 'unknown',
      reason: 'incomplete'
    });
    assert.deepEqual(recommendForProject(0, 50000), { recommendation: 'unknown', reason: 'empty' });
    // Too large already: unmeasured items cannot make it fit.
    assert.equal(recommendForProject(60000, 50000, { unmeasured: 2 }).recommendation, 'search');
  });
});

describe('estimateProject', () => {
  it('counts every readable item, names the ones it cannot and recommends', async () => {
    const repository = getProjectRepository();
    await write(path.join(defaultsDir, 'sources/small.md'), '# Small\n\nA short note.');
    await write(path.join(defaultsDir, 'sources/large.md'), `# Large\n\n${'Word '.repeat(40000)}`);
    await repository.createAdmin(
      {
        id: 'estimated',
        name: { en: 'Estimated' },
        items: [
          item('itm_small', { managedFile: 'sources/small.md' }),
          item('itm_large', { managedFile: 'sources/large.md' }),
          item('itm_search', {
            kind: 'ifinder-query',
            storage: 'link',
            status: 'ready',
            ref: { query: '' }
          }),
          item('itm_broken', {
            kind: 'url',
            storage: 'link',
            status: 'failed',
            ref: { url: 'https://example.com' },
            error: { code: 'EXTRACTION_FAILED', message: 'nope' }
          })
        ]
      },
      { actor: SYSTEM }
    );
    await importPendingProjects({ contentsDir: scratch, defaultsDir });
    const project = await repository.get('estimated');

    const estimate = await estimateProject(project, { user: SYSTEM, budgetTokens: 50000 });
    const byId = Object.fromEntries(estimate.items.map(entry => [entry.id, entry]));

    assert.equal(byId.itm_small.ok, true);
    assert.ok(byId.itm_small.tokens > 0 && byId.itm_small.tokens < 50);
    assert.equal(byId.itm_small.recommendation, 'prompt');
    assert.ok(byId.itm_large.tokens > 10000);
    assert.equal(byId.itm_large.recommendation, 'search');
    assert.equal(byId.itm_search.dynamic, true);
    assert.equal(byId.itm_search.tokens, null);
    assert.equal(byId.itm_search.recommendation, 'search');
    assert.equal(byId.itm_broken.ok, false);
    assert.equal(byId.itm_broken.code, 'ITEM_NOT_READY');

    assert.equal(estimate.tokens, byId.itm_small.tokens + byId.itm_large.tokens);
    assert.equal(estimate.unmeasured, 1, 'the dynamic search is not a failure; the broken item is');
    assert.equal(estimate.budgetTokens, 50000);
    assert.equal(estimate.minContextWindow, Math.ceil(estimate.tokens / 0.4));
  });

  it('recommends the prompt for a project that fits the budget', async () => {
    const repository = getProjectRepository();
    await write(
      path.join(defaultsDir, 'sources/note.md'),
      '# Note\n\nTen words about the rent being due.'
    );
    await repository.createAdmin(
      {
        id: 'fits',
        name: { en: 'Fits' },
        items: [item('itm_note', { managedFile: 'sources/note.md' })]
      },
      { actor: SYSTEM }
    );
    await importPendingProjects({ contentsDir: scratch, defaultsDir });
    const estimate = await estimateProject(await repository.get('fits'), {
      user: SYSTEM,
      budgetTokens: 50000
    });
    assert.equal(estimate.recommendation, 'prompt');
    assert.equal(estimate.reason, 'comfortable');
    assert.equal(estimate.unmeasured, 0);
    assert.ok(estimate.share > 0 && estimate.share < 0.01);
  });
});
