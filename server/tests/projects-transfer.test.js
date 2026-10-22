// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Moving, copying and merging admin projects (#1036): an item goes from one
 * project to another with its text decrypted and encrypted again under the
 * target; a merge moves every item, re-points the links of apps, workflows
 * and agents and, when asked, deletes the emptied source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import configStore from '../services/config/ConfigStore.js';
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
import { readText } from '../services/projects/ItemTextStore.js';
import { relinkList } from '../services/projects/projectRelink.js';
import { evictItemText } from '../services/knowledge/ItemTextService.js';

const MASTER = crypto.createHash('sha256').update('transfer-master').digest('hex');
const ADMIN = { id: 'admin', name: 'Admin' };

let scratch;
let service;
let repository;

function setLimits(limits) {
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    projects: {
      limits: {
        maxFiles: 25,
        maxFileBytes: 20 * 1024 * 1024,
        maxProjectBytes: 200 * 1024 * 1024,
        maxProjectsPerUser: 0,
        ...limits
      }
    }
  });
}

async function createProject(id, extra = {}) {
  return service.createAdminProject(
    { id, name: { en: id }, tier: 'ihub', enabled: true, tags: [], items: [], ...extra },
    { actor: ADMIN }
  );
}

async function addText(projectId, name, text) {
  const { item } = await service.addItem(
    projectId,
    { kind: 'upload', ref: { contentType: 'text/markdown' }, name, text },
    { user: ADMIN, origin: 'written', wait: true }
  );
  return item;
}

async function addLink(projectId, name, url) {
  const { item } = await service.addItem(
    projectId,
    { kind: 'url', ref: { url }, name },
    { user: ADMIN }
  );
  return item;
}

async function textOf(projectId, itemId) {
  const project = await repository.get(projectId);
  const item = project.items.find(entry => entry.id === itemId);
  return readText(project, item, { platform: configCache.getPlatform() });
}

async function blobKeys(prefix) {
  const page = await repository.blobs.list(PROJECT_FILES_NAMESPACE, { prefix, limit: 100 });
  return page.items.map(entry => entry.key);
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-transfer-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  setLimits({});
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

after(async () => {
  shutdownProjects();
  evictItemText();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('transferring items', () => {
  it('copies a text and a link, leaving the source as it was', async () => {
    await createProject('copy-from');
    await createProject('copy-to');
    const doc = await addText('copy-from', 'handbook.md', 'The handbook says hello.');
    const link = await addLink('copy-from', 'Website', 'https://example.com/');

    const result = await service.transferItems('copy-from', [doc.id, link.id], 'copy-to', {
      mode: 'copy',
      user: ADMIN
    });

    assert.equal(result.failed.length, 0);
    assert.equal(result.transferred.length, 2);
    const source = await repository.get('copy-from');
    const target = await repository.get('copy-to');
    assert.equal(source.items.length, 2);
    assert.equal(target.items.length, 2);
    const copied = target.items.find(entry => entry.name === 'handbook.md');
    assert.equal(copied.status, 'ready');
    assert.notEqual(copied.text.blobKey, doc.text.blobKey);
    assert.ok(copied.text.blobKey.startsWith('copy-to__'));
    assert.equal(copied.provenance.transferredFrom.projectId, 'copy-from');
    assert.equal(copied.provenance.transferredFrom.mode, 'copy');
    // The text reads back under the target's own key; the source still reads.
    assert.equal(await textOf('copy-to', copied.id), 'The handbook says hello.');
    assert.equal(await textOf('copy-from', doc.id), 'The handbook says hello.');
    const copiedLink = target.items.find(entry => entry.name === 'Website');
    assert.equal(copiedLink.ref.url, 'https://example.com/');
  });

  it('moves a text: the target reads it, the source and its blob are gone', async () => {
    await createProject('move-from');
    await createProject('move-to');
    const doc = await addText('move-from', 'faq.md', 'Frequently asked.');
    assert.equal((await blobKeys('move-from__')).length, 1);

    const result = await service.transferItems('move-from', [doc.id], 'move-to', {
      mode: 'move',
      user: ADMIN
    });

    assert.deepEqual(
      result.transferred.map(entry => entry.itemId),
      [doc.id]
    );
    assert.equal((await repository.get('move-from')).items.length, 0);
    assert.deepEqual(await blobKeys('move-from__'), []);
    const target = await repository.get('move-to');
    assert.equal(target.items.length, 1);
    // The id is kept when the target has no item of that id.
    assert.equal(target.items[0].id, doc.id);
    assert.equal(await textOf('move-to', doc.id), 'Frequently asked.');
  });

  it('gives a moved item a fresh id when the target already holds that id', async () => {
    await createProject('clash-from');
    await createProject('clash-to');
    const first = await addText('clash-from', 'a.md', 'from');
    // Plant an item with the same id in the target.
    await repository.mutate('clash-to', project => {
      project.items = [{ ...first, name: 'other.md', text: undefined, storage: 'link' }];
      return project;
    });

    const result = await service.transferItems('clash-from', [first.id], 'clash-to', {
      mode: 'move',
      user: ADMIN
    });

    assert.equal(result.failed.length, 0);
    assert.notEqual(result.transferred[0].newItemId, first.id);
    assert.equal(await textOf('clash-to', result.transferred[0].newItemId), 'from');
  });

  it('reports an item that is not ready and carries on with the others', async () => {
    await createProject('part-from');
    await createProject('part-to');
    const good = await addText('part-from', 'good.md', 'good');
    const bad = await addText('part-from', 'bad.md', 'bad');
    await repository.mutate('part-from', project => {
      const entry = project.items.find(candidate => candidate.id === bad.id);
      entry.status = 'failed';
      return project;
    });

    const result = await service.transferItems(
      'part-from',
      [bad.id, 'itm_missing', good.id],
      'part-to',
      { mode: 'move', user: ADMIN }
    );

    assert.deepEqual(
      result.transferred.map(entry => entry.itemId),
      [good.id]
    );
    assert.deepEqual(
      result.failed.map(entry => [entry.itemId, entry.code]),
      [
        [bad.id, 'ITEM_NOT_READY'],
        ['itm_missing', 'ITEM_NOT_FOUND']
      ]
    );
    assert.deepEqual(
      (await repository.get('part-from')).items.map(entry => entry.id),
      [bad.id]
    );
  });

  it("refuses an item over the target's file quota and leaves no blob behind", async () => {
    await createProject('quota-from');
    await createProject('quota-to');
    const one = await addText('quota-from', 'one.md', 'one');
    const two = await addText('quota-from', 'two.md', 'two');
    setLimits({ maxFiles: 1 });
    try {
      const result = await service.transferItems('quota-from', [one.id, two.id], 'quota-to', {
        mode: 'move',
        user: ADMIN
      });
      assert.equal(result.transferred.length, 1);
      assert.equal(result.failed[0].code, 'QUOTA_FILES');
      // The refused item stays in the source, and no orphan blob was written.
      assert.equal((await repository.get('quota-from')).items.length, 1);
      assert.equal((await blobKeys('quota-to__')).length, 1);
      assert.equal((await blobKeys('quota-from__')).length, 1);
    } finally {
      setLimits({});
    }
  });

  it('refuses the same project, a missing project and an unknown mode', async () => {
    await createProject('guard-a');
    await assert.rejects(service.transferItems('guard-a', ['x'], 'guard-a', { user: ADMIN }), {
      code: 'PROJECT_MISMATCH'
    });
    await assert.rejects(
      service.transferItems('guard-a', ['x'], 'does-not-exist', { user: ADMIN }),
      { code: 'PROJECT_NOT_FOUND' }
    );
    await assert.rejects(
      service.transferItems('guard-a', ['x'], 'guard-a', { mode: 'swap', user: ADMIN }),
      { code: 'INVALID_REF' }
    );
  });

  it('keeps the shipped documentation syncing when moved, not when copied', async () => {
    await createProject('managed-from');
    await createProject('managed-to');
    const doc = await addText('managed-from', 'docs.md', 'docs');
    await repository.mutate('managed-from', project => {
      Object.assign(project.items[0], { managedFile: 'sources/docs.md', managedSha256: 'abc' });
      return project;
    });
    await service.transferItems('managed-from', [doc.id], 'managed-to', {
      mode: 'copy',
      user: ADMIN
    });
    const copied = (await repository.get('managed-to')).items[0];
    assert.equal(copied.managedFile, undefined);
    assert.equal(copied.managedSha256, undefined);

    await service.transferItems('managed-from', [doc.id], 'managed-to', {
      mode: 'move',
      user: ADMIN
    });
    const moved = (await repository.get('managed-to')).items.find(
      entry => entry.provenance.transferredFrom?.mode === 'move'
    );
    assert.equal(moved.managedFile, 'sources/docs.md');
  });
});

describe('relinking a list', () => {
  const from = new Set(['site-a', 'site-b']);

  it('leaves a list that names no source alone', () => {
    assert.equal(relinkList(['other'], from, 'site'), null);
    assert.equal(relinkList(['site'], from, 'site'), null);
    assert.equal(relinkList(undefined, from, 'site'), null);
  });

  it('replaces a source by the target, in place', () => {
    assert.deepEqual(relinkList(['x', 'site-a', 'y'], from, 'site'), ['x', 'site', 'y']);
  });

  it('keeps one link when several sources and the target were linked', () => {
    assert.deepEqual(relinkList(['site-a', 'x', 'site-b', 'site'], from, 'site'), ['site', 'x']);
  });

  it('keeps the mode they share and widens to auto when they differ', () => {
    assert.deepEqual(
      relinkList(
        [
          { id: 'site-a', mode: 'tools' },
          { id: 'site-b', mode: 'tools' }
        ],
        from,
        'site'
      ),
      [{ id: 'site', mode: 'tools', write: false }]
    );
    assert.deepEqual(
      relinkList(
        [
          { id: 'site-a', mode: 'tools' },
          { id: 'site-b', mode: 'context' }
        ],
        from,
        'site'
      ),
      ['site']
    );
  });

  it('writes when any merged link could write', () => {
    assert.deepEqual(
      relinkList(['site-a', { id: 'site-b', mode: 'auto', write: true }], from, 'site'),
      [{ id: 'site', mode: 'auto', write: true }]
    );
  });
});

describe('merging projects', () => {
  async function writeLinked() {
    await configStore.writeJson('apps/site-app.json', {
      id: 'site-app',
      name: { en: 'Site app' },
      projects: ['site-a', { id: 'site-b', mode: 'tools' }, 'unrelated']
    });
    await configStore.writeJson('workflows/site-flow.json', {
      id: 'site-flow',
      name: { en: 'Site flow' },
      projects: ['site-a'],
      nodes: [
        {
          id: 'loop',
          type: 'loop',
          config: {
            body: [{ id: 'inner', type: 'prompt', config: { projects: ['site-b'] } }]
          }
        },
        {
          id: 'plan',
          type: 'planner',
          config: { taskTemplate: { projects: ['site-a'] } }
        }
      ]
    });
    await configStore.writeJson('agents/profiles/site-agent.json', {
      id: 'site-agent',
      name: { en: 'Site agent' },
      projects: [{ id: 'site-a', mode: 'context' }]
    });
    configCache.setCacheEntry('config/apps.json', { data: [], etag: 'x' });
  }

  it('moves every item, re-points the links and deletes the emptied sources', async () => {
    await createProject('site');
    await createProject('site-a');
    await createProject('site-b');
    const a = await addText('site-a', 'a.md', 'page a');
    const b = await addLink('site-b', 'Page B', 'https://example.com/b');
    await writeLinked();

    const result = await service.mergeProjects(['site-a', 'site-b'], 'site', {
      user: ADMIN,
      deleteSources: true
    });

    assert.deepEqual(
      result.sources.map(entry => [entry.id, entry.moved, entry.merged, entry.deleted]),
      [
        ['site-a', 1, true, true],
        ['site-b', 1, true, true]
      ]
    );
    const target = await repository.get('site');
    assert.deepEqual(target.items.map(entry => entry.name).sort(), ['Page B', 'a.md']);
    assert.equal(await textOf('site', a.id), 'page a');
    assert.equal(target.items.find(entry => entry.id === b.id).ref.url, 'https://example.com/b');
    assert.equal(await repository.get('site-a'), null);
    assert.equal(await repository.get('site-b'), null);

    const app = await configStore.readJson('apps/site-app.json');
    assert.deepEqual(app.projects, ['site', 'unrelated']);
    const flow = await configStore.readJson('workflows/site-flow.json');
    assert.deepEqual(flow.projects, ['site']);
    assert.deepEqual(flow.nodes[0].config.body[0].config.projects, ['site']);
    assert.deepEqual(flow.nodes[1].config.taskTemplate.projects, ['site']);
    const agent = await configStore.readJson('agents/profiles/site-agent.json');
    assert.deepEqual(agent.projects, [{ id: 'site', mode: 'context', write: false }]);
    assert.deepEqual(result.sources[0].relinked.map(entry => `${entry.type}:${entry.id}`).sort(), [
      'agent:site-agent',
      'app:site-app',
      'workflow:site-flow'
    ]);
  });

  it('keeps a source whose items did not all move, with its links', async () => {
    await createProject('keep');
    await createProject('keep-src');
    const ok = await addText('keep-src', 'ok.md', 'fine');
    const stuck = await addText('keep-src', 'stuck.md', 'stuck');
    await repository.mutate('keep-src', project => {
      project.items.find(entry => entry.id === stuck.id).status = 'extracting';
      return project;
    });
    await configStore.writeJson('apps/keep-app.json', {
      id: 'keep-app',
      name: { en: 'Keep app' },
      projects: ['keep-src']
    });

    const result = await service.mergeProjects(['keep-src'], 'keep', {
      user: ADMIN,
      deleteSources: true
    });

    const [entry] = result.sources;
    assert.equal(entry.moved, 1);
    assert.equal(entry.merged, false);
    assert.equal(entry.deleted, false);
    assert.equal(entry.failed[0].code, 'ITEM_NOT_READY');
    assert.deepEqual(
      (await repository.get('keep-src')).items.map(item => item.id),
      [stuck.id]
    );
    assert.equal((await repository.get('keep')).items[0].id, ok.id);
    const app = await configStore.readJson('apps/keep-app.json');
    assert.deepEqual(app.projects, ['keep-src']);
  });

  it('merges without deleting the sources by default', async () => {
    await createProject('nodel');
    await createProject('nodel-src');
    await addText('nodel-src', 'x.md', 'x');
    const result = await service.mergeProjects(['nodel-src'], 'nodel', { user: ADMIN });
    assert.equal(result.sources[0].merged, true);
    assert.equal(result.sources[0].deleted, false);
    assert.equal((await repository.get('nodel-src')).items.length, 0);
  });

  it('reports a source that fails and still merges the others', async () => {
    await createProject('iso');
    await createProject('iso-bad');
    await createProject('iso-good');
    await addText('iso-bad', 'bad.md', 'bad');
    await addText('iso-good', 'good.md', 'good');
    const original = service.transferItems.bind(service);
    service.transferItems = (sourceId, ...rest) =>
      sourceId === 'iso-bad'
        ? Promise.reject(new Error('storage went away'))
        : original(sourceId, ...rest);
    try {
      const result = await service.mergeProjects(['iso-bad', 'iso-good'], 'iso', {
        user: ADMIN,
        deleteSources: true
      });
      const [bad, good] = result.sources;
      assert.equal(bad.id, 'iso-bad');
      assert.equal(bad.merged, false);
      assert.equal(bad.error, 'storage went away');
      assert.deepEqual(
        [good.id, good.moved, good.merged, good.deleted],
        ['iso-good', 1, true, true]
      );
      assert.equal((await repository.get('iso-bad')).items.length, 1);
      assert.deepEqual(
        (await repository.get('iso')).items.map(entry => entry.name),
        ['good.md']
      );
    } finally {
      service.transferItems = original;
    }
  });

  it('refuses the target as a source and unknown projects', async () => {
    await createProject('self');
    await assert.rejects(service.mergeProjects(['self'], 'self', { user: ADMIN }), {
      code: 'PROJECT_MISMATCH'
    });
    await assert.rejects(service.mergeProjects(['ghost'], 'self', { user: ADMIN }), {
      code: 'PROJECT_NOT_FOUND'
    });
  });
});
