// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The knowledge modes of a project (#3538): `auto`, `context`, `relevant`,
 * `tools` and `pinned`, chosen per link or per project; what each
 * injects, whether the knowledge tools are offered, the platform's allow-list,
 * the fallback for a model that cannot call tools, and the items marked "Not for AI".
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import { bootstrapStorage, getStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { resolveGroupInheritance } from '../utils/authorization.js';
import { locateConfigFile } from '../utils/configFileLocation.js';
import { ProjectRepository } from '../services/projects/ProjectRepository.js';
import { setTextReader, evictItemText } from '../services/knowledge/ItemTextService.js';
import { evictProjectIndex } from '../services/knowledge/LocalKnowledgeProvider.js';
import { resolveProjectScope } from '../services/knowledge/ProjectScope.js';
import {
  planKnowledgeScope,
  renderProjectsBlock,
  scopeSummary
} from '../services/knowledge/KnowledgeScopePlanner.js';
import { knowledgeToolsFor } from '../services/knowledge/knowledgeTools.js';
import { list, read, search } from '../tools/knowledge.js';
import { withoutExcludedItems } from '../services/projects/aiAccess.js';
import { providerFor } from '../services/knowledge/registry.js';
import { normalizeProjectLink, projectLinkSchema } from '../validators/projectSchema.js';
import { relinkList } from '../services/projects/projectRelink.js';
import { projectSettings } from '../services/projects/projectSettings.js';
import {
  KNOWLEDGE_MODES,
  allowedKnowledgeModes,
  resolveKnowledgeMode
} from '../../shared/knowledgeModes.js';

const ADA = { id: 'user-ada', name: 'Ada', groups: ['authenticated'] };
const TEXTS = {};
let scratch;
let repo;
let big;

function textItem(id, name, text, extra = {}) {
  TEXTS[id] = text;
  return {
    id,
    kind: 'upload',
    name,
    ref: { contentType: 'text/markdown' },
    storage: 'text',
    pinned: false,
    status: 'ready',
    error: null,
    text: {
      blobKey: `${id}__v1`,
      bytes: text.length,
      chars: text.length,
      tokens: Math.ceil(text.length / 4),
      sha256: id,
      format: 'test',
      key: { provider: 'test', keyId: 'k', wrapped: 'x' },
      extractedAt: '2026-10-20T10:00:00Z',
      original: { contentType: 'text/markdown', bytes: text.length }
    },
    provenance: {
      origin: 'uploaded',
      by: { id: ADA.id, name: ADA.name },
      at: '2026-10-20T10:00:00Z'
    },
    snapshotAt: null,
    createdAt: '2026-10-20T10:00:00Z',
    updatedAt: '2026-10-20T10:00:00Z',
    ...extra
  };
}

const POLICY = '# Policy\n\n## Passwords\nPasswords have at least 14 characters.\n';
const SECRET = '# Salaries\n\n## Bands\nThe salary band of level 7 is confidential.\n';
const FILLER = 'The handbook describes many routine office matters in considerable detail. '.repeat(
  12
);
const HANDBOOK = `# Handbook\n\n${Array.from(
  { length: 14 },
  (_, index) => `## Chapter ${index + 1}\n${FILLER}\n`
).join(
  '\n'
)}\n## Vacation carry-over\nUnused vacation days expire on the zebra deadline of 31 March.\n`;

const ASK = 'What is the zebra deadline for unused vacation days?';
const CTX = { user: ADA, chatId: 'c-modes', language: 'en' };
const TOOLS_MODEL = { id: 'm', contextWindow: 100000, supportsTools: 'auto' };
const NO_TOOLS_MODEL = { id: 'n', contextWindow: 100000, supportsTools: 'none' };

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-knowledge-modes-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = { [ADA.id]: { ...ADA, username: 'ada', active: true } };
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  configCache.setCacheEntry('config/platform.json', {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: false },
    projects: { loadAllMaxTokens: 50000 }
  });
  configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          permissions: { apps: ['*'], projects: true, projectSharing: true }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: [] } }
      }
    })
  );
  configCache.setCacheEntry('config/apps.json', [
    { id: 'chat', name: { en: 'Chat' }, enabled: true }
  ]);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/models.json', []);
  configCache.setCacheEntry('config/projects.json', []);
  setTextReader(async (_project, item) => {
    if (TEXTS[item.id] === undefined) throw new Error('no text');
    return TEXTS[item.id];
  });

  const provider = getStorage();
  repo = new ProjectRepository({
    documents: provider.documents,
    blobs: provider.blobs,
    locks: provider.locks
  });
  big = await repo.createUser({ owner: ADA, content: { name: 'Office knowledge' } });
  big = await repo.mutate(big.id, project => ({
    ...project,
    items: [
      textItem('itm_policy', 'Policy.md', POLICY, { pinned: true }),
      textItem('itm_handbook', 'Handbook.md', HANDBOOK),
      textItem('itm_salaries', 'Salaries.md', SECRET, { excludedFromAi: true })
    ]
  }));
});

after(async () => {
  setTextReader(null);
  evictItemText();
  evictProjectIndex();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

/** The scope of a chat in `big`, with the mode of the project, or a link's. */
async function scopeOf(appConfig) {
  return resolveProjectScope({ appConfig: { id: 'chat', ...appConfig }, user: ADA });
}

/** The plan of one project in one mode. */
async function planIn(mode, { settings = { loadAllMaxTokens: 50000 }, model = TOOLS_MODEL } = {}) {
  const scope = await scopeOf({ projects: [{ id: big.id, mode }] });
  return planKnowledgeScope(scope, { model, settings, ctx: CTX, question: ASK });
}

describe('the knowledge modes', () => {
  it('names the five modes and keeps the stored ones', () => {
    assert.deepEqual([...KNOWLEDGE_MODES], ['auto', 'context', 'relevant', 'tools', 'pinned']);
    for (const stored of ['auto', 'context', 'tools']) assert.ok(KNOWLEDGE_MODES.includes(stored));
  });

  it('lets an administrator switch modes off, but never `auto`', () => {
    assert.deepEqual(allowedKnowledgeModes(undefined), [...KNOWLEDGE_MODES]);
    assert.deepEqual(allowedKnowledgeModes(['tools', 'pinned']), ['auto', 'tools', 'pinned']);
    assert.deepEqual(allowedKnowledgeModes(['bogus']), [...KNOWLEDGE_MODES]);
    assert.deepEqual(
      projectSettings({ projects: { knowledgeModes: ['auto', 'relevant'] } }).knowledgeModes,
      ['auto', 'relevant']
    );
  });

  it("does not narrow an admin project's own mode with the user allow-list", () => {
    const allowed = ['auto', 'tools'];
    assert.deepEqual(
      resolveKnowledgeMode({ project: 'context', allowed, allowedForProject: false }),
      { mode: 'context', source: 'project' }
    );
    assert.deepEqual(resolveKnowledgeMode({ project: 'context', allowed }), {
      mode: 'auto',
      source: 'default'
    });
  });

  it('resolves link → project default → auto', () => {
    assert.deepEqual(resolveKnowledgeMode({}), { mode: 'auto', source: 'default' });
    assert.deepEqual(resolveKnowledgeMode({ project: 'context' }), {
      mode: 'context',
      source: 'project'
    });
    assert.deepEqual(resolveKnowledgeMode({ link: 'tools', project: 'context' }), {
      mode: 'tools',
      source: 'link'
    });
    // A chat has no say: a `chat` level is not read.
    assert.deepEqual(resolveKnowledgeMode({ chat: 'pinned', link: 'tools', project: 'context' }), {
      mode: 'tools',
      source: 'link'
    });
    // A mode the platform no longer offers is passed over for a user's project, not for a link.
    const allowed = ['auto', 'tools'];
    assert.deepEqual(resolveKnowledgeMode({ project: 'pinned', allowed }), {
      mode: 'auto',
      source: 'default'
    });
    assert.deepEqual(resolveKnowledgeMode({ link: 'context', allowed }), {
      mode: 'context',
      source: 'link'
    });
  });
});

describe('links', () => {
  it('tell "no mode" from an explicit `auto`', () => {
    assert.equal(normalizeProjectLink('prj_a').mode, null);
    assert.equal(normalizeProjectLink({ id: 'prj_a' }).mode, null);
    assert.equal(normalizeProjectLink({ id: 'prj_a', mode: 'auto' }).mode, 'auto');
    assert.equal(normalizeProjectLink({ id: 'prj_a', mode: 'bogus' }).mode, null);
    assert.equal(projectLinkSchema.parse({ id: 'prj_a' }).mode, undefined);
    assert.equal(projectLinkSchema.parse({ id: 'prj_a', mode: 'relevant' }).mode, 'relevant');
    assert.equal(projectLinkSchema.parse({ id: 'prj_a', mode: 'pinned' }).mode, 'pinned');
    assert.throws(() => projectLinkSchema.parse({ id: 'prj_a', mode: 'everything' }));
  });

  it('keep the mode two merged links share, and leave it open when they differ', () => {
    assert.deepEqual(
      relinkList(
        [
          { id: 'a', mode: 'tools' },
          { id: 'b', mode: 'tools' }
        ],
        new Set(['a', 'b']),
        'c'
      ),
      [{ id: 'c', mode: 'tools', write: false }]
    );
    assert.deepEqual(relinkList(['a', 'b'], new Set(['a', 'b']), 'c'), ['c']);
    assert.deepEqual(relinkList([{ id: 'a', mode: 'tools' }, 'b'], new Set(['a', 'b']), 'c'), [
      'c'
    ]);
  });
});

describe('which mode a project is used in', () => {
  async function withDefault(mode, work) {
    const before = await repo.get(big.id);
    await repo.mutate(big.id, project => ({ ...project, knowledgeMode: mode }));
    try {
      return await work();
    } finally {
      await repo.mutate(big.id, project => {
        const { knowledgeMode: _gone, ...rest } = project;
        return before.knowledgeMode ? { ...rest, knowledgeMode: before.knowledgeMode } : rest;
      });
    }
  }

  it('is `auto` when nothing says otherwise', async () => {
    const [entry] = await scopeOf({ _projectId: big.id });
    assert.equal(entry.mode, 'auto');
    assert.equal(entry.modeSource, 'default');
  });

  it("takes the project's own default", async () => {
    await withDefault('context', async () => {
      const [entry] = await scopeOf({ _projectId: big.id });
      assert.equal(entry.mode, 'context');
      assert.equal(entry.modeSource, 'project');
    });
  });

  it("does not let a chat change a project's mode, for its container or its attachments", async () => {
    await withDefault('context', async () => {
      // A mode a request still carries is not read.
      const [container] = await scopeOf({ _projectId: big.id, _knowledgeMode: 'pinned' });
      assert.deepEqual([container.mode, container.modeSource], ['context', 'project']);
      const [attached] = await scopeOf({
        _attachedProjectIds: [big.id],
        _knowledgeMode: 'relevant'
      });
      assert.deepEqual([attached.mode, attached.modeSource], ['context', 'project']);
    });
  });

  it('lets a link without a mode fall to the project and a link with one beat it', async () => {
    await withDefault('context', async () => {
      const [open] = await scopeOf({ projects: [{ id: big.id }] });
      assert.deepEqual([open.mode, open.modeSource], ['context', 'project']);
      const [set] = await scopeOf({ projects: [{ id: big.id, mode: 'tools' }] });
      assert.deepEqual([set.mode, set.modeSource], ['tools', 'link']);
      const [explicit] = await scopeOf({ projects: [{ id: big.id, mode: 'auto' }] });
      assert.deepEqual([explicit.mode, explicit.modeSource], ['auto', 'link']);
    });
  });

  it('passes over a mode the platform switched off, for projects', async () => {
    const platform = configCache.getPlatform();
    configCache.setCacheEntry('config/platform.json', {
      ...platform,
      projects: { ...platform.projects, knowledgeModes: ['auto', 'tools'] }
    });
    try {
      await withDefault('context', async () => {
        const [project] = await scopeOf({ _projectId: big.id });
        assert.deepEqual([project.mode, project.modeSource], ['auto', 'default']);
        // An administrator's link keeps its mode.
        const [link] = await scopeOf({ projects: [{ id: big.id, mode: 'context' }] });
        assert.deepEqual([link.mode, link.modeSource], ['context', 'link']);
      });
    } finally {
      configCache.setCacheEntry('config/platform.json', platform);
    }
  });
});

describe('an admin project', () => {
  it('keeps the mode an administrator set when the platform switches that mode off for users', async () => {
    await repo.createAdmin(
      {
        id: 'kb-modes',
        name: { en: 'Knowledge base' },
        knowledgeMode: 'context',
        items: [textItem('itm_kb_modes', 'Kb.md', POLICY)]
      },
      { actor: ADA }
    );
    const reader = { ...ADA, permissions: { apps: new Set(['*']) } };
    const apps = configCache.getApps()?.data;
    const platform = configCache.getPlatform();
    configCache.setCacheEntry('config/apps.json', [
      { id: 'chat', name: { en: 'Chat' }, enabled: true, projects: ['kb-modes'] }
    ]);
    configCache.setCacheEntry('config/platform.json', {
      ...platform,
      projects: { ...platform.projects, knowledgeModes: ['auto', 'tools'] }
    });
    try {
      const [entry] = await resolveProjectScope({
        appConfig: { id: 'chat', projects: ['kb-modes'] },
        user: reader
      });
      assert.deepEqual([entry.mode, entry.modeSource], ['context', 'project']);
      // The same switch narrows a user's own project.
      const [own] = await scopeOf({ _projectId: big.id });
      assert.equal(own.mode, 'auto');
    } finally {
      configCache.setCacheEntry('config/apps.json', apps || []);
      configCache.setCacheEntry('config/platform.json', platform);
    }
  });
});

describe('what a model never gets of a "Not for AI" item', () => {
  it('is left out by the helper every model-facing path uses, the stored project untouched', () => {
    const stored = { id: 'p', items: [{ id: 'a' }, { id: 'b', excludedFromAi: true }] };
    const seen = withoutExcludedItems(stored);
    assert.deepEqual(
      seen.items.map(item => item.id),
      ['a']
    );
    assert.equal(stored.items.length, 2);
    const clean = { id: 'q', items: [{ id: 'a' }] };
    assert.equal(withoutExcludedItems(clean), clean, 'nothing marked: the same project');
  });

  it('keeps the item out of what the MCP project resource loads', async () => {
    // `readProjectContent` loads `withoutExcludedItems(project)` through the provider.
    const full = await repo.get(big.id);
    const loaded = await providerFor(full).loadAll(withoutExcludedItems(full), CTX);
    assert.deepEqual(loaded.docs.map(entry => entry.doc.id).sort(), ['itm_handbook', 'itm_policy']);
    const everything = await providerFor(full).loadAll(full, CTX);
    assert.ok(
      everything.docs.some(entry => entry.doc.id === 'itm_salaries'),
      'the provider itself does not filter, which is why the callers must'
    );
  });
});

describe('what each mode injects', () => {
  const documents = plan => plan.projects[0].injected.map(entry => entry.doc.id);
  const excerpted = plan => plan.projects[0].injected.filter(entry => entry.excerpt);

  it('`auto` loads everything that fits the budget, the rest as pinned + sections', async () => {
    const fits = await planIn('auto');
    assert.equal(fits.projects[0].mode, 'loaded');
    assert.deepEqual(documents(fits).sort(), ['itm_handbook', 'itm_policy']);
    assert.equal(fits.tools, false);

    const tight = await planIn('auto', { settings: { loadAllMaxTokens: 500 } });
    assert.equal(tight.projects[0].mode, 'searched');
    assert.equal(tight.projects[0].knowledgeMode, 'auto');
    assert.equal(tight.tools, true);
    assert.ok(documents(tight).includes('itm_policy'));
    assert.ok(excerpted(tight).some(entry => entry.text.includes('zebra deadline')));
  });

  it('`context` loads everything even where `auto` would not', async () => {
    const plan = await planIn('context', { settings: { loadAllMaxTokens: 500 } });
    assert.equal(plan.projects[0].mode, 'loaded');
    assert.deepEqual(documents(plan).sort(), ['itm_handbook', 'itm_policy']);
    assert.equal(excerpted(plan).length, 0);
    assert.equal(plan.projects[0].knowledgeMode, 'context');
  });

  it('`relevant` injects pinned documents and the best sections, whether or not all would fit', async () => {
    const plan = await planIn('relevant');
    const [project] = plan.projects;
    assert.equal(project.mode, 'searched');
    assert.equal(project.knowledgeMode, 'relevant');
    assert.ok(documents(plan).includes('itm_policy'));
    const sections = excerpted(plan);
    assert.ok(sections.length > 0);
    assert.ok(sections.some(entry => entry.text.includes('zebra deadline')));
    // Nothing but pinned documents goes in whole.
    assert.deepEqual(
      project.injected.filter(entry => !entry.excerpt).map(entry => entry.doc.id),
      ['itm_policy']
    );
    assert.equal(plan.tools, true, 'the knowledge tools stay on');
    assert.ok(renderProjectsBlock(plan).includes('excerpt="true"'));
    assert.ok(renderProjectsBlock(plan).includes('tool="knowledge_search"'));
  });

  it('`relevant` without a question injects the pinned documents only', async () => {
    const scope = await scopeOf({ projects: [{ id: big.id, mode: 'relevant' }] });
    const plan = await planKnowledgeScope(scope, {
      model: TOOLS_MODEL,
      settings: { loadAllMaxTokens: 50000 },
      ctx: CTX,
      question: null
    });
    assert.deepEqual(documents(plan), ['itm_policy']);
  });

  it('`tools` injects the pinned documents and leaves the rest to the tools', async () => {
    const plan = await planIn('tools');
    assert.equal(plan.projects[0].mode, 'searched');
    assert.deepEqual(documents(plan), ['itm_policy']);
    assert.equal(excerpted(plan).length, 0);
    assert.equal(plan.tools, true);
  });

  it('`pinned` injects the pinned documents and offers no tools for the rest', async () => {
    const plan = await planIn('pinned');
    const [project] = plan.projects;
    assert.equal(project.mode, 'pinned');
    assert.equal(project.knowledgeMode, 'pinned');
    assert.deepEqual(documents(plan), ['itm_policy']);
    assert.equal(plan.tools, false);
    assert.deepEqual(project.documentList ?? [], []);
    const block = renderProjectsBlock(plan);
    assert.ok(block.includes('mode="pinned"'));
    assert.ok(!block.includes('knowledge_search'));
    assert.ok(!block.includes('<document-list'));
  });

  it('tells the badge the mode the server used and the level that chose it', async () => {
    const scope = await scopeOf({ projects: [{ id: big.id, mode: 'relevant' }] });
    const plan = await planKnowledgeScope(scope, {
      model: TOOLS_MODEL,
      settings: { loadAllMaxTokens: 50000 },
      ctx: CTX,
      question: ASK
    });
    const [entry] = scopeSummary(plan).projects;
    assert.equal(entry.knowledgeMode, 'relevant');
    assert.equal(entry.modeSource, 'link');
    assert.equal(entry.mode, 'searched');
    assert.equal(entry.excerpted, true);
  });
});

describe('a model that cannot call tools', () => {
  it('reads `tools` as `relevant`: the unpinned documents are not out of reach', async () => {
    const plan = await planIn('tools', { model: NO_TOOLS_MODEL });
    const [project] = plan.projects;
    assert.equal(project.knowledgeMode, 'relevant');
    assert.equal(project.modeFallback, 'tools');
    assert.ok(
      project.injected.some(entry => entry.excerpt && entry.text.includes('zebra deadline'))
    );
    // It cannot search, so neither the tool nor a list to read from is promised.
    assert.equal(plan.toolless, true);
    assert.equal(plan.tools, false);
    const block = renderProjectsBlock(plan);
    assert.ok(!block.includes('knowledge_search'));
    assert.ok(!block.includes('knowledge_read'));
    assert.equal(scopeSummary(plan).projects[0].modeFallback, 'tools');
  });

  it('falls back to the best sections when `auto` does not fit', async () => {
    const plan = await planIn('auto', {
      model: NO_TOOLS_MODEL,
      settings: { loadAllMaxTokens: 500 }
    });
    assert.ok(plan.projects[0].injected.some(entry => entry.excerpt));
    assert.equal(plan.tools, false);
  });

  it('leaves `pinned` and `context` as they are', async () => {
    assert.equal(
      (await planIn('pinned', { model: NO_TOOLS_MODEL })).projects[0].knowledgeMode,
      'pinned'
    );
    const context = await planIn('context', { model: NO_TOOLS_MODEL });
    assert.equal(context.projects[0].knowledgeMode, 'context');
    assert.equal(context.projects[0].modeFallback, undefined);
  });
});

describe('items marked "Not for AI"', () => {
  it('are left out of the scope the model works from', async () => {
    const [entry] = await scopeOf({ projects: [{ id: big.id }] });
    assert.deepEqual(entry.project.items.map(item => item.id).sort(), [
      'itm_handbook',
      'itm_policy'
    ]);
    const [all] = await resolveProjectScope({
      appConfig: { id: 'chat', projects: [{ id: big.id }] },
      user: ADA,
      forAi: false
    });
    assert.equal(all.project.items.length, 3, 'a workflow project node works on all documents');
  });

  it('never reach the prompt, even in full context', async () => {
    const plan = await planIn('context');
    assert.ok(!plan.projects[0].injected.some(entry => entry.doc.id === 'itm_salaries'));
    assert.ok(!renderProjectsBlock(plan).includes('confidential'));
    assert.equal(plan.projects[0].documents, 2);
  });

  it('are not listed, searched or read through the knowledge tools', async () => {
    const appConfig = { id: 'chat', projects: [{ id: big.id, mode: 'tools' }] };
    const listed = await list({ appConfig, user: ADA });
    const ids = listed.projects[0].documents.map(doc => doc.id);
    assert.ok(!ids.includes('itm_salaries'));
    assert.ok(ids.includes('itm_handbook'));
    const found = await search({ appConfig, user: ADA, query: 'salary band level 7 confidential' });
    assert.ok(found.hits.every(hit => hit.document !== 'itm_salaries'));
    assert.ok(!found.hits.some(hit => hit.text.includes('confidential')));
    const asked = await read({ appConfig, user: ADA, project: big.id, document: 'itm_salaries' });
    assert.ok(asked.error, 'the document does not exist for the model');
  });
});

describe('the knowledge tools', () => {
  it('are offered when a project has them and not when every project is pinned', async () => {
    const on = await knowledgeToolsFor({
      app: { id: 'chat', projects: [{ id: big.id, mode: 'tools' }] },
      user: ADA
    });
    assert.deepEqual(
      on.map(tool => tool.id),
      ['knowledge_search', 'knowledge_read', 'knowledge_list']
    );
    const relevant = await knowledgeToolsFor({
      app: { id: 'chat', projects: [{ id: big.id, mode: 'relevant' }] },
      user: ADA
    });
    assert.equal(relevant.length, 3);
    const pinned = await knowledgeToolsFor({
      app: { id: 'chat', projects: [{ id: big.id, mode: 'pinned' }] },
      user: ADA
    });
    assert.deepEqual(pinned, []);
  });

  it('cannot reach a pinned project even when the model names it', async () => {
    const appConfig = { id: 'chat', projects: [{ id: big.id, mode: 'pinned' }] };
    const found = await search({ appConfig, user: ADA, query: 'zebra deadline', project: big.id });
    assert.deepEqual(found.hits, []);
    assert.match(found.note, /No project is available/);
    const listed = await list({ appConfig, user: ADA });
    assert.deepEqual(listed.projects ?? [], []);
  });
});
