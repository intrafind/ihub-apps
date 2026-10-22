// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V174 — sources become admin projects (#1036, spec 1 §10.1).
 *
 * Every source type maps to one item of its kind, every `sources` list on
 * apps, workflows (top level, nodes, planner task templates) and agent
 * profiles becomes `projects` links that keep the old behaviour, the
 * placeholders and tool lists are rewritten, the flag and the admin page
 * carry over, a colliding `prj_` id is remapped everywhere, and nothing is
 * done twice.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  description,
  itemIdForSource,
  precondition,
  projectIdForSource,
  projectIdsForSources,
  up,
  version
} from '../migrations/V174__sources_to_projects.js';

let baseDir;

function makeCtx(dir) {
  const logs = [];
  const full = rel => path.join(dir, rel);
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(full(rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel => JSON.parse(await fs.readFile(full(rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(full(rel)), { recursive: true });
      await fs.writeFile(full(rel), JSON.stringify(data, null, 2), 'utf8');
    },
    deleteFile: async rel => fs.unlink(full(rel)),
    moveFile: async (from, to) => fs.rename(full(from), full(to)),
    listFiles: async (directory, pattern) => {
      let entries;
      try {
        entries = await fs.readdir(full(directory));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      if (!pattern) return entries;
      const regex = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
      return entries.filter(entry => regex.test(entry));
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));

const SOURCES = [
  {
    id: 'faq',
    name: { en: 'FAQ' },
    description: { en: 'Questions' },
    type: 'filesystem',
    enabled: true,
    exposeAs: 'prompt',
    tags: ['help'],
    created: '2025-01-01T00:00:00.000Z',
    config: { path: 'sources/faq.md', encoding: 'utf-8' }
  },
  {
    id: 'ihub-documentation',
    name: { en: 'Docs' },
    type: 'filesystem',
    exposeAs: 'tool',
    category: 'documentation',
    config: { path: 'sources/ihub-documentation.md' }
  },
  {
    id: 'site',
    name: { en: 'Site' },
    type: 'url',
    exposeAs: 'prompt',
    config: { url: 'https://example.com/a', maxContentLength: 20000 },
    caching: { ttl: 600 }
  },
  { id: 'faq-page', name: { en: 'Page' }, type: 'page', config: { pageId: 'faq', language: 'de' } },
  {
    id: 'kb-doc',
    name: { en: 'KB doc' },
    type: 'ifinder',
    exposeAs: 'tool',
    config: { documentId: 'doc-1', searchProfile: 'default', maxLength: 5000 }
  },
  {
    id: 'kb',
    name: { en: 'KB' },
    type: 'ifinder',
    exposeAs: 'tool',
    config: { query: '', maxResults: 5 }
  },
  {
    id: 'prj_bad',
    name: { en: 'Collides' },
    type: 'url',
    config: { url: 'https://example.com/b' }
  },
  {
    id: 'disabled',
    name: { en: 'Off' },
    type: 'url',
    enabled: false,
    config: { url: 'https://example.com/c' }
  }
];

async function seed(dir, { withSources = true } = {}) {
  const write = async (rel, data) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
  };
  if (withSources) await write('config/sources.json', SOURCES);
  await write('apps/support.json', {
    id: 'support',
    name: { en: 'Support' },
    system: { en: 'Answer from <sources>{{sources}}</sources>', de: 'Nutze {{source}}' },
    sources: ['faq', 'ihub-documentation', 'missing', 'prj_bad'],
    tools: ['source_ihub-documentation', 'web_search'],
    sourceSupplements: [{ id: 'x' }]
  });
  await write('apps/plain.json', { id: 'plain', name: { en: 'Plain' }, tools: ['web_search'] });
  await write('apps/already.json', {
    id: 'already',
    name: { en: 'Already' },
    projects: [{ id: 'faq', mode: 'context', write: false }],
    sources: ['faq', 'site']
  });
  await write('workflows/kq.json', {
    id: 'kq',
    sources: ['faq'],
    nodes: [
      { id: 'start', type: 'start', config: {} },
      {
        id: 'agent',
        type: 'prompt',
        config: {
          sources: ['site'],
          system: 'Use {{sources}}',
          prompt: { en: 'Q: {{sources}}' },
          tools: ['source_site']
        }
      },
      {
        id: 'planner',
        type: 'planner',
        config: { taskTemplate: { sources: ['kb'], tools: ['source_kb', 'ask_user'] } }
      },
      { id: 'end', type: 'end', config: {} }
    ],
    edges: []
  });
  await write('agents/profiles/helper.json', {
    id: 'helper',
    system: { en: 'Agent {{sources}}' },
    sources: ['kb-doc'],
    tools: ['source_kb-doc']
  });
  await write('config/features.json', { sources: false, chatPersistence: true });
  await write('config/platform.json', { admin: { pages: { sources: false, apps: true } } });
  await write('projects/faq-page.json', {
    id: 'faq-page',
    ownership: 'admin',
    name: { en: 'Kept' },
    items: []
  });
}

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v174-'));
});

after(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('V174 sources_to_projects', () => {
  it('declares its version', () => {
    assert.equal(version, '174');
    assert.equal(description, 'sources_to_projects');
    assert.match(itemIdForSource('faq'), /^itm_[0-9a-f]{12}$/);
    assert.equal(itemIdForSource('faq'), itemIdForSource('faq'));
    assert.equal(projectIdForSource('prj_bad'), 'legacy-prj_bad');
    const long = `prj_${'x'.repeat(60)}`;
    assert.match(projectIdForSource(long), /^legacy-[0-9a-f]{12}$/);
    assert.ok(projectIdForSource('y'.repeat(60)).length <= 50);
    // Decided for the whole set: a remap that another source occupies falls back to a hash.
    const ids = projectIdsForSources([
      { id: 'prj_case' },
      { id: 'legacy-prj_case' },
      { id: 'faq' }
    ]);
    assert.equal(ids.get('faq'), 'faq');
    assert.equal(ids.get('legacy-prj_case'), 'legacy-prj_case');
    assert.match(ids.get('prj_case'), /^legacy-[0-9a-f]{12}$/);
    assert.equal(new Set(ids.values()).size, 3);
    assert.equal(projectIdForSource('faq'), 'faq');
  });

  it('runs when sources.json or a sources list exists, and not otherwise', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'pre-'));
    assert.equal(await precondition(makeCtx(dir)), false);
    await seed(dir, { withSources: false });
    assert.equal(await precondition(makeCtx(dir)), true, 'an app with sources is enough');
    const dir2 = await fs.mkdtemp(path.join(baseDir, 'pre2-'));
    await fs.mkdir(path.join(dir2, 'config'), { recursive: true });
    await fs.writeFile(path.join(dir2, 'config/sources.json'), '[]', 'utf8');
    assert.equal(await precondition(makeCtx(dir2)), true);
  });

  it('turns every source into an admin project with one item of its kind', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'up-'));
    await seed(dir);
    const ctx = makeCtx(dir);
    await up(ctx);

    const faq = await read(dir, 'projects/faq.json');
    assert.equal(faq.ownership, 'admin');
    assert.equal(faq.enabled, true);
    assert.deepEqual(faq.tags, ['help']);
    assert.equal(faq.createdAt, '2025-01-01T00:00:00.000Z');
    assert.equal(faq.items.length, 1);
    const upload = faq.items[0];
    assert.equal(upload.id, itemIdForSource('faq'));
    assert.equal(upload.kind, 'upload');
    assert.equal(upload.storage, 'text');
    assert.equal(upload.status, 'pending');
    assert.deepEqual(upload.import, { file: 'sources/faq.md', encoding: 'utf-8' });
    assert.equal(upload.provenance.origin, 'migrated');
    assert.equal(upload.name, 'faq.md');

    const docs = await read(dir, 'projects/ihub-documentation.json');
    assert.equal(docs.items[0].managedFile, 'sources/ihub-documentation.md');
    assert.equal(docs.items[0].import, undefined);
    assert.equal(docs.category, 'documentation');

    const site = await read(dir, 'projects/site.json');
    assert.equal(site.items[0].kind, 'url');
    assert.equal(site.items[0].storage, 'link');
    assert.equal(site.items[0].status, 'ready');
    assert.deepEqual(site.items[0].ref, { url: 'https://example.com/a', maxContentLength: 20000 });
    assert.deepEqual(site.items[0].cache, { ttlSeconds: 600 });
    assert.equal(site.items[0].provenance.source.site, 'example.com');

    const page = await read(dir, 'projects/faq-page.json');
    assert.equal(page.name.en, 'Kept', 'an existing project file is not overwritten');

    const kbDoc = await read(dir, 'projects/kb-doc.json');
    assert.equal(kbDoc.items[0].kind, 'ifinder-document');
    assert.deepEqual(kbDoc.items[0].ref, {
      documentId: 'doc-1',
      searchProfile: 'default',
      maxLength: 5000
    });
    const kb = await read(dir, 'projects/kb.json');
    assert.equal(kb.items[0].kind, 'ifinder-query');
    assert.deepEqual(kb.items[0].ref, { query: '', maxResults: 5 });

    const legacy = await read(dir, 'projects/legacy-prj_bad.json');
    assert.equal(legacy.id, 'legacy-prj_bad');
    assert.equal(await ctx.fileExists('projects/prj_bad.json'), false);
    assert.ok(ctx.logs.some(([, m]) => /prj_bad.*legacy-prj_bad/.test(m)));

    const disabled = await read(dir, 'projects/disabled.json');
    assert.equal(disabled.enabled, false);

    assert.equal(await ctx.fileExists('config/sources.json'), false);
    assert.equal(await ctx.fileExists('config/sources.json.migrated'), true);
  });

  it('rewrites links, placeholders and tool lists on apps, workflows and profiles', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'links-'));
    await seed(dir);
    const ctx = makeCtx(dir);
    await up(ctx);

    const support = await read(dir, 'apps/support.json');
    assert.equal(support.sources, undefined);
    assert.equal(support.sourceSupplements, undefined);
    assert.deepEqual(support.projects, [
      { id: 'faq', mode: 'context', write: false },
      { id: 'ihub-documentation', mode: 'tools', write: false },
      { id: 'missing', mode: 'auto', write: false },
      { id: 'legacy-prj_bad', mode: 'context', write: false }
    ]);
    assert.equal(support.system.en, 'Answer from <sources>{{projects}}</sources>');
    assert.equal(support.system.de, 'Nutze {{projects}}');
    assert.deepEqual(support.tools, ['web_search']);
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && /"missing"/.test(m)));
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && /sourceSupplements/.test(m)));

    const plain = await read(dir, 'apps/plain.json');
    assert.equal(plain.projects, undefined, 'an app without sources is left alone');

    const already = await read(dir, 'apps/already.json');
    assert.deepEqual(already.projects, [
      { id: 'faq', mode: 'context', write: false },
      { id: 'site', mode: 'context', write: false }
    ]);
    assert.equal(already.sources, undefined);

    const kq = await read(dir, 'workflows/kq.json');
    assert.deepEqual(kq.projects, [{ id: 'faq', mode: 'context', write: false }]);
    assert.equal(kq.sources, undefined);
    const agent = kq.nodes.find(node => node.id === 'agent');
    assert.deepEqual(agent.config.projects, [{ id: 'site', mode: 'context', write: false }]);
    assert.equal(agent.config.sources, undefined);
    assert.equal(agent.config.system, 'Use {{projects}}');
    assert.deepEqual(agent.config.prompt, { en: 'Q: {{projects}}' });
    assert.deepEqual(agent.config.tools, []);
    const planner = kq.nodes.find(node => node.id === 'planner');
    assert.deepEqual(planner.config.taskTemplate.projects, [
      { id: 'kb', mode: 'tools', write: false }
    ]);
    assert.deepEqual(planner.config.taskTemplate.tools, ['ask_user']);

    const helper = await read(dir, 'agents/profiles/helper.json');
    assert.deepEqual(helper.projects, [{ id: 'kb-doc', mode: 'tools', write: false }]);
    assert.equal(helper.system.en, 'Agent {{projects}}');
    assert.deepEqual(helper.tools, []);

    const features = await read(dir, 'config/features.json');
    assert.deepEqual(features, { chatPersistence: true, projects: false });
    const platform = await read(dir, 'config/platform.json');
    assert.deepEqual(platform.admin.pages, { apps: true, projects: false });
  });

  it('replaces a project file that is only the shipped default seeded on this start', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'seeded-'));
    await seed(dir);
    const shipped = { id: 'faq', name: { en: 'FAQ (shipped)' }, enabled: true, items: [] };
    const custom = { id: 'ihub-documentation', name: { en: 'Kept by an admin' }, items: [] };
    await fs.mkdir(path.join(dir, 'projects'), { recursive: true });
    await fs.writeFile(path.join(dir, 'projects/faq.json'), JSON.stringify(shipped, null, 2));
    await fs.writeFile(
      path.join(dir, 'projects/ihub-documentation.json'),
      JSON.stringify(custom, null, 2)
    );
    const ctx = makeCtx(dir);
    ctx.readDefaultJson = async rel => {
      if (rel === 'projects/faq.json') return shipped;
      if (rel === 'projects/ihub-documentation.json') return { id: 'ihub-documentation' };
      throw new Error('no default');
    };
    await up(ctx);
    // The default copy wrote faq.json moments before the migration; the
    // admin's source of that id is what the project must hold.
    const faq = await read(dir, 'projects/faq.json');
    assert.equal(faq.name.en, 'FAQ');
    assert.equal(faq.items.length, 1);
    assert.equal(faq.items[0].provenance.origin, 'migrated');
    // A project file that differs from the shipped default is an admin's.
    assert.deepEqual(await read(dir, 'projects/ihub-documentation.json'), custom);
  });

  it('is idempotent', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'twice-'));
    await seed(dir);
    await up(makeCtx(dir));
    const first = await read(dir, 'apps/support.json');
    assert.equal(await precondition(makeCtx(dir)), false, 'nothing left to migrate');
    await up(makeCtx(dir));
    assert.deepEqual(await read(dir, 'apps/support.json'), first);
    assert.equal(await fs.readdir(path.join(dir, 'projects')).then(list => list.length), 8);
  });
});
