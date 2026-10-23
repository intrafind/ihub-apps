// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V178 — the six IntraFind website projects become one.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MERGED_PROJECT_IDS,
  description,
  precondition,
  relinkList,
  up,
  version
} from '../migrations/V178__merge_intrafind_website_projects.js';

const SHIPPED = JSON.parse(
  await fs.readFile(new URL('../defaults/projects/intrafind-website.json', import.meta.url), 'utf8')
);

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
    listFiles: async (directory, pattern) => {
      let entries;
      try {
        entries = await fs.readdir(full(directory));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      if (!pattern) return entries;
      // Only `*.json` style patterns are used here.
      const suffix = pattern.replace(/^\*/, '');
      return entries.filter(entry => entry.endsWith(suffix));
    },
    readDefaultJson: async rel => {
      if (rel !== 'projects/intrafind-website.json') throw new Error('ENOENT');
      return structuredClone(SHIPPED);
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

const read = async (dir, rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
const exists = (dir, rel) =>
  fs
    .stat(path.join(dir, rel))
    .then(() => true)
    .catch(() => false);

const URLS = {
  'intrafind-website-home': 'https://www.intrafind.com',
  'intrafind-website-ifinder': 'https://intrafind.com/en/ifinder',
  'intrafind-website-ifinder-features': 'https://intrafind.com/en/ifinder/features',
  'intrafind-website-ifinder-connectors': 'https://intrafind.com/en/ifinder/connectors',
  'intrafind-website-iassistant': 'https://intrafind.com/en/iassistant',
  'intrafind-website-ihub': 'https://intrafind.com/en/ihub'
};

function oldProject(id, overrides = {}) {
  return {
    version: 1,
    id,
    ownership: 'admin',
    name: { en: id },
    instructions: '',
    enabled: true,
    items: [
      {
        id: `itm_${id}`,
        kind: 'url',
        name: URLS[id],
        ref: { url: URLS[id], maxContentLength: 1048576 },
        storage: 'link',
        status: 'ready',
        cache: { ttlSeconds: 7200 }
      }
    ],
    ...overrides
  };
}

async function seed(dir, { ids = MERGED_PROJECT_IDS, projects = {}, extra = {} } = {}) {
  for (const id of ids) {
    const ctx = makeCtx(dir);
    await ctx.writeJson(`projects/${id}.json`, projects[id] || oldProject(id));
  }
  const ctx = makeCtx(dir);
  for (const [rel, doc] of Object.entries(extra)) await ctx.writeJson(rel, doc);
}

describe('V178 — one IntraFind website project', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v178-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('exports its identity', () => {
    assert.equal(version, '178');
    assert.equal(description, 'merge_intrafind_website_projects');
  });

  it('the shipped project holds the six pages the old projects did', () => {
    assert.equal(SHIPPED.id, 'intrafind-website');
    assert.deepEqual(
      SHIPPED.items.map(item => item.ref.url),
      MERGED_PROJECT_IDS.map(id => URLS[id])
    );
  });

  it('applies only where one of the six projects exists', async () => {
    const dir = path.join(baseDir, 'none');
    await fs.mkdir(path.join(dir, 'projects'), { recursive: true });
    assert.equal(await precondition(makeCtx(dir)), false);
    await seed(dir, { ids: ['intrafind-website-ihub'] });
    assert.equal(await precondition(makeCtx(dir)), true);
  });

  it('merges the projects, keeps admin settings, re-links apps, workflows and profiles', async () => {
    const dir = path.join(baseDir, 'merge');
    const customised = oldProject('intrafind-website-ifinder');
    customised.items[0].cache = { ttlSeconds: 60 };
    await seed(dir, {
      projects: { 'intrafind-website-ifinder': customised },
      extra: {
        // The default copy seeds the merged project before the migrations run.
        'projects/intrafind-website.json': SHIPPED,
        'apps/bot.json': {
          id: 'bot',
          projects: MERGED_PROJECT_IDS.map(id => ({ id, mode: 'context' }))
        },
        'apps/mixed.json': {
          id: 'mixed',
          projects: [
            'faq',
            { id: 'intrafind-website-home', mode: 'context' },
            { id: 'intrafind-website-ihub', mode: 'tools' }
          ]
        },
        'apps/other.json': { id: 'other', projects: ['faq'] },
        'workflows/w.json': {
          id: 'w',
          projects: ['intrafind-website-iassistant'],
          nodes: [
            {
              id: 'n1',
              type: 'prompt',
              config: { projects: [{ id: 'intrafind-website-home', mode: 'tools', write: true }] }
            },
            {
              id: 'loop',
              type: 'loop',
              config: {
                body: [
                  {
                    id: 'inner',
                    type: 'planner',
                    config: {
                      taskTemplate: {
                        projects: ['intrafind-website-ihub', 'intrafind-website-home']
                      }
                    }
                  }
                ]
              }
            }
          ]
        },
        'agents/profiles/p.json': { id: 'p', projects: ['intrafind-website-ifinder'] }
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const merged = await read(dir, 'projects/intrafind-website.json');
    assert.deepEqual(
      merged.items.map(item => item.ref.url),
      MERGED_PROJECT_IDS.map(id => URLS[id]),
      'one item per page, in order, none twice'
    );
    assert.equal(
      merged.items.find(item => item.ref.url === URLS['intrafind-website-ifinder']).cache
        .ttlSeconds,
      60,
      'the admin setting wins over the shipped item'
    );
    for (const id of MERGED_PROJECT_IDS) {
      assert.equal(await exists(dir, `projects/${id}.json`), false, `${id} is gone`);
    }

    assert.deepEqual((await read(dir, 'apps/bot.json')).projects, [
      { id: 'intrafind-website', mode: 'context', write: false }
    ]);
    // Different modes become `auto`, which is the bare id.
    assert.deepEqual((await read(dir, 'apps/mixed.json')).projects, ['faq', 'intrafind-website']);
    assert.deepEqual((await read(dir, 'apps/other.json')).projects, ['faq']);
    const workflow = await read(dir, 'workflows/w.json');
    assert.deepEqual(workflow.projects, ['intrafind-website']);
    assert.deepEqual(workflow.nodes[0].config.projects, [
      { id: 'intrafind-website', mode: 'tools', write: true }
    ]);
    assert.deepEqual(workflow.nodes[1].config.body[0].config.taskTemplate.projects, [
      'intrafind-website'
    ]);
    assert.deepEqual((await read(dir, 'agents/profiles/p.json')).projects, ['intrafind-website']);
  });

  it('creates the merged project from the shipped default when it is missing', async () => {
    const dir = path.join(baseDir, 'create');
    await seed(dir, { ids: ['intrafind-website-home', 'intrafind-website-ihub'] });
    await up(makeCtx(dir));
    const merged = await read(dir, 'projects/intrafind-website.json');
    assert.equal(merged.id, 'intrafind-website');
    assert.equal(merged.items.length, 6, 'the shipped pages that were not there are kept');
  });

  it('leaves a project that an admin changed beyond the shipped shape', async () => {
    const dir = path.join(baseDir, 'custom');
    await seed(dir, {
      projects: {
        'intrafind-website-ihub': oldProject('intrafind-website-ihub', {
          instructions: 'Answer in the voice of the marketing team.'
        })
      },
      extra: {
        'apps/bot.json': {
          id: 'bot',
          projects: ['intrafind-website-home', 'intrafind-website-ihub']
        }
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);
    assert.equal(await exists(dir, 'projects/intrafind-website-ihub.json'), true);
    assert.equal(await exists(dir, 'projects/intrafind-website-home.json'), false);
    assert.deepEqual((await read(dir, 'apps/bot.json')).projects, [
      'intrafind-website',
      'intrafind-website-ihub'
    ]);
    assert.ok(ctx.logs.some(([, message]) => message.includes('not merged')));
  });

  it('leaves a project whose page was replaced or that gained an item', async () => {
    const dir = path.join(baseDir, 'replaced');
    const replaced = oldProject('intrafind-website-ihub');
    replaced.items[0].ref.url = 'https://example.com/our-own-page';
    const extra = oldProject('intrafind-website-iassistant');
    extra.items.push({
      ...extra.items[0],
      id: 'itm_more',
      ref: { url: 'https://example.com/more' }
    });
    await seed(dir, {
      projects: { 'intrafind-website-ihub': replaced, 'intrafind-website-iassistant': extra }
    });
    await up(makeCtx(dir));
    assert.equal(await exists(dir, 'projects/intrafind-website-ihub.json'), true);
    assert.equal(await exists(dir, 'projects/intrafind-website-iassistant.json'), true);
    assert.equal(await exists(dir, 'projects/intrafind-website-home.json'), false);
  });

  it('accepts the shipped page with a trailing slash and stops when a directory cannot be listed', async () => {
    const dir = path.join(baseDir, 'slash');
    const slash = oldProject('intrafind-website-home');
    slash.items[0].ref.url = 'https://www.intrafind.com/';
    await seed(dir, {
      ids: ['intrafind-website-home'],
      projects: { 'intrafind-website-home': slash }
    });
    const ctx = makeCtx(dir);
    const failing = {
      ...ctx,
      listFiles: async directory => {
        if (directory === 'workflows') throw new Error('EACCES');
        return ctx.listFiles(directory, '*.json');
      }
    };
    await assert.rejects(up(failing), /EACCES/);
    // Nothing was deleted: the links could not be checked.
    assert.equal(await exists(dir, 'projects/intrafind-website-home.json'), true);
    await up(makeCtx(dir));
    assert.equal(await exists(dir, 'projects/intrafind-website-home.json'), false);
  });

  it('leaves a project an admin gave a category or tags', async () => {
    const dir = path.join(baseDir, 'organised');
    await seed(dir, {
      projects: {
        'intrafind-website-ihub': oldProject('intrafind-website-ihub', { category: 'marketing' }),
        'intrafind-website-iassistant': oldProject('intrafind-website-iassistant', {
          tags: ['product']
        })
      }
    });
    await up(makeCtx(dir));
    assert.equal(await exists(dir, 'projects/intrafind-website-ihub.json'), true);
    assert.equal(await exists(dir, 'projects/intrafind-website-iassistant.json'), true);
    assert.equal(await exists(dir, 'projects/intrafind-website-home.json'), false);
  });

  it('is disabled only when every merged project was, and enabled otherwise', async () => {
    const off = path.join(baseDir, 'all-off');
    const disabled = {};
    for (const id of MERGED_PROJECT_IDS) disabled[id] = oldProject(id, { enabled: false });
    await seed(off, { projects: disabled });
    await up(makeCtx(off));
    assert.equal((await read(off, 'projects/intrafind-website.json')).enabled, false);

    const some = path.join(baseDir, 'some-off');
    await seed(some, {
      projects: {
        'intrafind-website-home': oldProject('intrafind-website-home', { enabled: false })
      }
    });
    await up(makeCtx(some));
    assert.equal((await read(some, 'projects/intrafind-website.json')).enabled, true);
  });

  it('does nothing twice', async () => {
    const dir = path.join(baseDir, 'twice');
    await seed(dir, {
      extra: { 'apps/bot.json': { id: 'bot', projects: ['intrafind-website-home'] } }
    });
    await up(makeCtx(dir));
    const first = await read(dir, 'projects/intrafind-website.json');
    assert.equal(await precondition(makeCtx(dir)), false);
    await up(makeCtx(dir));
    const second = await read(dir, 'projects/intrafind-website.json');
    assert.deepEqual(second.items, first.items);
  });

  it('relinkList mirrors the admin merge: position, mode and write', () => {
    const from = new Set(['a', 'b']);
    assert.equal(relinkList(['x'], from, 't'), null);
    assert.equal(relinkList('nope', from, 't'), null);
    assert.deepEqual(relinkList(['x', 'a', 'y', 'b'], from, 't'), ['x', 't', 'y']);
    assert.deepEqual(
      relinkList(
        [
          { id: 'a', mode: 'tools' },
          { id: 'b', mode: 'tools', write: true }
        ],
        from,
        't'
      ),
      [{ id: 't', mode: 'tools', write: true }]
    );
  });
});
