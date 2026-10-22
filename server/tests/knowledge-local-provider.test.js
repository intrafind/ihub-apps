// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The knowledge layer over a local project (#1036, spec 2): the corpus
 * index, the local provider, the planner, the tools and the mapping onto the
 * answer `Source` model. Item text comes from a stub text reader, the way
 * the ingest pipeline will register one; link items are not fetched here.
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
import { buildCorpusIndex, collectHits, searchCorpus } from '../sources/documentRetrieval.js';
import { ProjectRepository } from '../services/projects/ProjectRepository.js';
import { setTextReader, evictItemText } from '../services/knowledge/ItemTextService.js';
import {
  LocalKnowledgeProvider,
  evictProjectIndex
} from '../services/knowledge/LocalKnowledgeProvider.js';
import { providerFor } from '../services/knowledge/registry.js';
import { resolveProjectScope } from '../services/knowledge/ProjectScope.js';
import {
  loadAllBudget,
  planKnowledgeScope,
  renderProjectInstructions,
  renderProjectsBlock,
  scopeSummary
} from '../services/knowledge/KnowledgeScopePlanner.js';
import { knowledgeToolsFor } from '../services/knowledge/knowledgeTools.js';
import { list, read, search } from '../tools/knowledge.js';
import { projectSource, projectSourceProducer } from '../services/sources/producers/project.js';
import { extractToolSources } from '../services/sources/index.js';
import { normalizeSource, mergeSources, emptySourceSet } from '../../shared/sources/index.js';
import { classifyKnowledgeSource } from '../services/loop/seams/knowledgeSourceSeam.js';
import { toolKind, searchScope } from '../../shared/run/toolActivity.js';
import {
  content as providerContent,
  metadata as providerMetadata
} from '../services/sources/providers/project.js';
import PromptService from '../services/PromptService.js';
import { chatPostSchema } from '../validators/index.js';

const ADA = { id: 'user-ada', name: 'Ada', groups: ['authenticated'] };
const GRACE = { id: 'user-grace', name: 'Grace', groups: ['authenticated'] };

let scratch;
let repo;
let project;
let textProject;

const TEXTS = {};

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

const CONTRACT = `# Lease contract

## § 1 Parties
The landlord Example Housing GmbH rents the flat at Main Street 1 to the tenant.

## § 12 Termination
The tenant may terminate the lease with three months notice. The landlord needs a legitimate interest.

## § 13 Deposit
The deposit is three monthly rents and is returned within six months after the end of the lease.
`;

const POLICY = `# Information security policy

## Passwords
Passwords have at least 14 characters and are rotated when a compromise is suspected.

## Backups
Backups run nightly and are tested every quarter. Restore tests are documented.
`;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-knowledge-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = {
    [ADA.id]: { ...ADA, username: 'ada', active: true },
    [GRACE.id]: { ...GRACE, username: 'grace', active: true }
  };
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
  configCache.setCacheEntry('config/models.json', [
    { id: 'small', name: 'Small', contextWindow: 8000 }
  ]);
  configCache.setCacheEntry('config/tools.json', []);
  configCache.setCacheEntry('config/projects.json', []);

  setTextReader(async (_project, item) => {
    const text = TEXTS[item.id];
    if (text === undefined) throw new Error('no text');
    return text;
  });

  const provider = getStorage();
  repo = new ProjectRepository({
    documents: provider.documents,
    blobs: provider.blobs,
    locks: provider.locks
  });
  project = await repo.createUser({
    owner: ADA,
    content: { name: 'Case 2026-114', instructions: 'Answer as a lawyer' }
  });
  project = await repo.mutate(project.id, p => ({
    ...p,
    items: [
      textItem('itm_contract', 'Lease.md', CONTRACT),
      textItem('itm_policy', 'Policy.md', POLICY, { pinned: true })
    ]
  }));
  await repo.setMembers(project.id, [{ type: 'user', id: GRACE.id, role: 'user' }], { actor: ADA });
  textProject = project;
});

after(async () => {
  setTextReader(null);
  evictItemText();
  evictProjectIndex();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('corpus index', () => {
  it('ranks parts across documents and knows which document each came from', () => {
    const index = buildCorpusIndex([
      { id: 'a', name: 'Lease', text: CONTRACT },
      { id: 'b', name: 'Policy', text: POLICY }
    ]);
    assert.equal(index.docs.length, 2);
    assert.ok(index.sections.every(section => section.docId === 'a' || section.docId === 'b'));
    const ranked = searchCorpus(index, 'termination notice');
    assert.equal(ranked[0].docId, 'a');
    const hits = collectHits(index, 'backups restore');
    assert.equal(hits[0].docId, 'b');
    assert.equal(hits[0].title, 'Backups');
    assert.deepEqual(hits[0].path, ['Information security policy', 'Backups']);
    assert.equal(searchCorpus(index, 'deposit', { docIds: ['b'] }).length, 0);
  });

  it('expands a short hit within its own document only', () => {
    const index = buildCorpusIndex([
      { id: 'a', name: 'Alpha', text: '# Alpha\n\nA tiny intro about alpha.' },
      { id: 'b', name: 'Beta', text: '## Beta\n\nBeta is all about widgets and gadgets.' }
    ]);
    const hits = collectHits(index, 'tiny intro alpha');
    assert.equal(hits[0].docId, 'a');
    assert.ok(!hits[0].text.includes('widgets'), 'the next document is not a subsection');
    const restricted = collectHits(index, 'tiny intro alpha', { docIds: ['a'] });
    assert.ok(restricted.every(hit => hit.docId === 'a' && !hit.text.includes('widgets')));
  });
});

describe('local provider', () => {
  it('serves the ihub tier', () => {
    assert.ok(providerFor({ tier: 'ihub' }) instanceof LocalKnowledgeProvider);
    assert.throws(
      () => providerFor({ tier: 'ifinder' }),
      error => error.code === 'NOT_SUPPORTED'
    );
  });

  it('lists, searches, reads and loads a project', async () => {
    const provider = providerFor(textProject);
    const ctx = { user: ADA, chatId: 'c1', language: 'en' };
    const listed = await provider.list(textProject, ctx);
    assert.deepEqual(listed.items.map(doc => doc.id).sort(), ['itm_contract', 'itm_policy']);
    assert.equal(listed.items.find(doc => doc.id === 'itm_policy').pinned, true);

    const found = await provider.search(textProject, ctx, { query: 'deposit returned' });
    assert.equal(found.hits[0].docId, 'itm_contract');
    assert.equal(found.hits[0].projectId, textProject.id);
    assert.equal(found.hits[0].name, 'Lease.md');
    assert.ok(found.hits[0].sectionId.startsWith('13-deposit'));
    assert.equal(found.retrieval.documents, 2);

    const whole = await provider.read(textProject, ctx, { itemId: 'itm_policy' });
    assert.equal(whole.retrieval.mode, 'full');
    assert.ok(whole.text.includes('Backups run nightly'));

    const loaded = await provider.loadAll(textProject, ctx);
    assert.equal(loaded.docs.length, 2);
    assert.ok(loaded.tokens > 0);
    const pinnedOnly = await provider.loadAll(textProject, ctx, { itemIds: ['itm_policy'] });
    assert.equal(pinnedOnly.docs.length, 1);
  });

  it('reports items that are not usable instead of failing the call', async () => {
    const withFailed = {
      ...textProject,
      items: [
        ...textProject.items,
        textItem('itm_broken', 'Broken.pdf', '', {
          status: 'failed',
          error: { code: 'NO_TEXT', message: 'scan' }
        })
      ]
    };
    const provider = providerFor(withFailed);
    const result = await provider.search(withFailed, { user: ADA }, { query: 'deposit' });
    assert.deepEqual(
      result.unavailable.map(u => u.document),
      ['itm_broken']
    );
    assert.equal(result.unavailable[0].code, 'NO_TEXT');
    assert.ok(result.hits.length > 0);
  });
});

describe('scope and planner', () => {
  it('resolves the container, the app links and the attachments the user may use', async () => {
    const scope = await resolveProjectScope({
      appConfig: { id: 'chat', _projectId: textProject.id, _attachedProjectIds: ['prj_missing'] },
      user: ADA
    });
    assert.equal(scope.length, 1);
    assert.equal(scope[0].origin, 'container');
    assert.equal(scope[0].mode, 'auto');
    const stranger = await resolveProjectScope({
      appConfig: { id: 'chat', _projectId: textProject.id },
      user: { id: 'u-x', name: 'x', groups: ['authenticated'] }
    });
    assert.equal(stranger.length, 0, 'a project the user may not use is not in scope');
    const member = await resolveProjectScope({
      appConfig: { id: 'chat', _attachedProjectIds: [textProject.id] },
      user: GRACE
    });
    assert.equal(member.length, 1);
    assert.equal(member[0].instructions, false, 'attachments contribute knowledge only');
  });

  it('loads in full when the text fits and searches when it does not', async () => {
    assert.equal(loadAllBudget({ contextWindow: 100000 }, { loadAllMaxTokens: 50000 }), 40000);
    assert.equal(loadAllBudget({ contextWindow: 8000 }, { loadAllMaxTokens: 50000 }), 3200);
    assert.equal(loadAllBudget(null, {}), 50000);
    const scope = await resolveProjectScope({
      appConfig: { id: 'chat', _projectId: textProject.id },
      user: ADA
    });
    const ctx = { user: ADA, chatId: 'c1', language: 'en' };
    const fits = await planKnowledgeScope(scope, {
      model: { contextWindow: 100000 },
      settings: { loadAllMaxTokens: 50000 },
      ctx
    });
    assert.equal(fits.projects[0].mode, 'loaded');
    assert.equal(fits.projects[0].injected.length, 2);
    assert.equal(fits.tools, false);
    const block = renderProjectsBlock(fits);
    assert.ok(
      block.includes(`<project id="${textProject.id}" name="Case 2026-114" mode="loaded">`)
    );
    assert.ok(block.includes('origin="uploaded"'));
    assert.ok(block.includes('pinned="true"'));
    assert.ok(renderProjectInstructions(fits).includes('Answer as a lawyer'));

    const tight = await planKnowledgeScope(scope, {
      model: { contextWindow: 200 },
      settings: { loadAllMaxTokens: 50 },
      ctx
    });
    assert.equal(tight.projects[0].mode, 'searched');
    assert.deepEqual(
      tight.projects[0].injected.map(doc => doc.doc.id),
      ['itm_policy'],
      'pinned items stay in context'
    );
    assert.equal(tight.projects[0].overBudget, true);
    assert.equal(tight.tools, true);
    assert.ok(renderProjectsBlock(tight).includes('mode="searched"'));
    const summary = scopeSummary(tight);
    assert.equal(summary.projects[0].mode, 'searched');
    assert.equal(summary.projects[0].pinned, 1);

    // The hard limit: pinned text is cut at 75 % of the context window.
    const cramped = await planKnowledgeScope(scope, {
      model: { contextWindow: 40 },
      settings: { loadAllMaxTokens: 50 },
      ctx
    });
    assert.equal(cramped.limitTokens, 30);
    assert.deepEqual(cramped.projects[0].cut, ['itm_policy']);
    assert.equal(cramped.projects[0].injected.length, 1);
    assert.equal(cramped.projects[0].injected[0].doc.id, 'itm_policy');
    assert.equal(cramped.projects[0].injected[0].truncated, true);
    assert.ok(cramped.projects[0].injected[0].text.length < POLICY.length);
    assert.ok(cramped.projects[0].tokens <= 30);
    assert.ok(renderProjectsBlock(cramped).includes('truncated="true"'));
    assert.equal(scopeSummary(cramped).projects[0].cut, 1);
    assert.equal(cramped.tools, true, 'what was cut stays reachable through the tools');
    // A context project that lost text to the hard limit is not loaded in
    // full: the plan says so, and the block carries the tool hint.
    const cappedContext = await planKnowledgeScope(
      scope.map(entry => ({ ...entry, mode: 'context' })),
      { model: { contextWindow: 40 }, settings: { loadAllMaxTokens: 50 }, ctx }
    );
    assert.equal(cappedContext.projects[0].mode, 'searched');
    assert.ok(cappedContext.projects[0].cut.length > 0);
    assert.ok(renderProjectsBlock(cappedContext).includes('tool="knowledge_search"'));

    // The hard limit is one limit for the whole scope, not one per project.
    const twice = [
      { ...scope[0], mode: 'context' },
      { ...scope[0], mode: 'context', project: { ...scope[0].project, id: 'prj_twin' } }
    ];
    const shared = await planKnowledgeScope(twice, {
      model: { contextWindow: 200 },
      settings: { loadAllMaxTokens: 50000 },
      ctx
    });
    assert.equal(shared.limitTokens, 150);
    const total = shared.projects.reduce((sum, project) => sum + project.tokens, 0);
    assert.ok(total <= 150, `injected ${total} tokens past the limit`);
    assert.equal(shared.projects[0].cut.length, 0);
    // What is left goes to the pinned policy first (truncated, so listed as
    // cut as well); the contract, first in item order, is dropped whole.
    assert.deepEqual(shared.projects[1].cut, ['itm_policy', 'itm_contract']);
    assert.equal(shared.projects[1].injected.length, 1);
    assert.equal(shared.projects[1].injected[0].doc.id, 'itm_policy');
    assert.equal(shared.projects[1].injected[0].truncated, true);
    assert.equal(shared.tools, true);
    evictProjectIndex('prj_twin');

    const forced = await planKnowledgeScope(
      scope.map(entry => ({ ...entry, mode: 'tools' })),
      { model: null, settings: {}, ctx }
    );
    assert.equal(forced.projects[0].mode, 'searched');
    const context = await planKnowledgeScope(
      scope.map(entry => ({ ...entry, mode: 'context' })),
      { model: { contextWindow: 200 }, settings: { loadAllMaxTokens: 10 }, ctx }
    );
    assert.equal(context.projects[0].mode, 'loaded');
  });
});

describe('tools', () => {
  const params = (extra = {}) => ({
    user: ADA,
    chatId: 'c1',
    language: 'en',
    appConfig: { id: 'chat', _projectId: textProject.id },
    ...extra
  });

  const installed = ['knowledge_search', 'knowledge_read', 'knowledge_list'].map(id => ({
    id,
    name: id,
    description: `The ${id} tool`,
    script: 'knowledge.js',
    method: id.slice('knowledge_'.length),
    enabled: true
  }));

  it('are offered with the scope in their description', async () => {
    const tools = await knowledgeToolsFor({
      app: { id: 'chat', _projectId: textProject.id },
      user: ADA,
      language: 'en',
      allTools: installed
    });
    assert.deepEqual(
      tools.map(tool => tool.id),
      ['knowledge_search', 'knowledge_read', 'knowledge_list']
    );
    assert.ok(
      tools[0].description.includes(`${textProject.id} ("Case 2026-114", 2 documents, search it)`)
    );
    assert.equal(tools[0].script, 'knowledge.js');
    assert.equal(tools[0].method, 'search');
    // A project loaded in full by configuration still offers the tools: the
    // planner may have to cut it at the hard limit, and the description says
    // it is already in context.
    const loaded = await knowledgeToolsFor({
      app: { id: 'chat', projects: [{ id: textProject.id, mode: 'context' }] },
      user: ADA,
      allTools: installed
    });
    assert.equal(loaded.length, 3);
    assert.ok(loaded[0].description.includes('loaded in full'));
    assert.deepEqual(await knowledgeToolsFor({ app: { id: 'chat' }, user: ADA }), []);
    // Only the installation's enabled definitions are advertised: what the
    // admin disabled or removed cannot run, so it is not offered either.
    const disabled = installed.map(tool =>
      tool.id === 'knowledge_read' ? { ...tool, enabled: false } : tool
    );
    assert.deepEqual(
      await knowledgeToolsFor({
        app: { id: 'chat', _projectId: textProject.id },
        user: ADA,
        allTools: disabled
      }),
      []
    );
    assert.deepEqual(
      await knowledgeToolsFor({ app: { id: 'chat', _projectId: textProject.id }, user: ADA }),
      []
    );
  });

  it('search returns numbered hits with a sources envelope', async () => {
    const result = await search(params({ query: 'deposit returned' }));
    assert.ok(result.hits.length > 0, JSON.stringify(result));
    assert.equal(result.hits[0].n, 1);
    assert.equal(result.hits[0].document, 'itm_contract');
    assert.equal(result.sources[0].provider, 'project');
    assert.deepEqual(result.sources[0].ref, { id: 'itm_contract', scope: textProject.id });
    assert.equal(result.sources[0].provenance.origin, 'uploaded');
    assert.equal(result.sources[0].passages[0].marker, 's:1');
    const scoped = await search(params({ query: 'deposit', project: 'prj_other' }));
    assert.equal(scoped.code, 'PROJECT_NOT_FOUND');
    const nothing = await search({ ...params({ query: 'x' }), appConfig: { id: 'chat' } });
    assert.deepEqual(nothing.hits, []);
  });

  it('read and list work by document id', async () => {
    const doc = await read(params({ document: 'itm_policy' }));
    assert.equal(doc.name, 'Policy.md');
    assert.ok(doc.content.includes('Passwords'));
    assert.equal(doc.sources[0].read.ok, true);
    const section = await read(params({ document: 'itm_contract', section: '12-termination' }));
    assert.ok(section.content.includes('three months notice'));
    const missing = await read(params({ document: 'itm_nope' }));
    assert.equal(missing.code, 'ITEM_NOT_FOUND');
    const listed = await list(params());
    assert.equal(listed.projects[0].id, textProject.id);
    assert.equal(listed.projects[0].documents.length, 2);
    assert.equal(listed.projects[0].documents.find(d => d.id === 'itm_policy').origin, 'uploaded');
  });

  it('is classified as project knowledge, never as web search', () => {
    assert.equal(classifyKnowledgeSource('knowledge_search'), 'sources');
    assert.equal(toolKind('knowledge_search'), 'search');
    assert.equal(toolKind('knowledge_read'), 'fetch');
    assert.equal(searchScope('knowledge_search'), 'documents');
  });
});

describe('sources', () => {
  it('maps a hit onto the Source model with its provenance', () => {
    const item = textProject.items[0];
    const input = projectSource(textProject, item, { snippet: 'x' });
    const source = normalizeSource(input);
    assert.equal(source.id, 'project:itm_contract');
    assert.equal(source.kind, 'document');
    assert.equal(source.private, true);
    assert.equal(source.site, 'Case 2026-114');
    assert.equal(source.type, 'Markdown');
    assert.deepEqual(source.provenance, { origin: 'uploaded', kind: 'upload' });
    const picked = normalizeSource({
      ...input,
      provenance: { origin: 'picked', kind: 'office365', at: '2026-10-12T00:00:00Z' }
    });
    assert.equal(picked.provenance.at, '2026-10-12T00:00:00.000Z');
    const merged = mergeSources(emptySourceSet(), {
      items: [input, { ...input, provenance: undefined }]
    });
    assert.equal(merged.items[0].provenance.origin, 'uploaded', 'provenance survives a merge');
    assert.equal(
      normalizeSource({ ...input, provenance: { origin: 'stolen' } }).provenance,
      undefined
    );
  });

  it('is extracted from a tool result through the producer', () => {
    assert.equal(projectSourceProducer.matches({ toolId: 'knowledge_search' }), true);
    assert.equal(projectSourceProducer.matches({ toolId: 'iFinder_search' }), false);
    const item = textProject.items[0];
    const frame = extractToolSources({
      toolId: 'knowledge_search',
      args: { query: 'deposit' },
      result: { hits: [], sources: [projectSource(textProject, item)] }
    });
    assert.equal(frame.items.length, 1);
    assert.deepEqual(frame.queries, ['deposit']);
    assert.ok(frame.items[0].ref, 'the ref survives because the project provider is registered');
    assert.equal(frame.items[0].private, true);
  });

  it("serves text and details through the provider with the reader's access", async () => {
    const ref = { id: 'itm_policy', scope: textProject.id };
    const text = await providerContent({ ref, user: GRACE, format: 'text' });
    assert.equal(text.contentType, 'text/plain; charset=utf-8');
    assert.equal(text.fileName, 'Policy.txt');
    assert.ok(text.body.includes('Backups'));
    await assert.rejects(
      providerContent({ ref, user: GRACE, format: 'pdf' }),
      error => error.status === 410 && error.code === 'ORIGINAL_DISCARDED'
    );
    await assert.rejects(
      providerContent({ ref, user: { id: 'u-x', groups: ['authenticated'] }, format: 'text' }),
      error => error.status === 404
    );
    const details = await providerMetadata({ ref, user: ADA });
    assert.equal(details.project.id, textProject.id);
    assert.equal(details.provenance.origin, 'uploaded');
  });

  it('sends the reader of a link item to its source, and goes dark with the feature', async () => {
    const linked = await repo.createUser({ owner: ADA, content: { name: 'Links' } });
    await repo.mutate(linked.id, p => ({
      ...p,
      items: [
        {
          id: 'itm_page',
          kind: 'page',
          name: 'FAQ page',
          ref: { pageId: 'faq', language: 'de' },
          storage: 'link',
          pinned: false,
          status: 'ready',
          error: null,
          provenance: { origin: 'linked', by: { id: ADA.id, name: ADA.name }, at: '2026-10-20' }
        }
      ]
    }));
    const ref = { id: 'itm_page', scope: linked.id };
    // A page has no file: preview and download get the text fallback (410),
    // the card's URL opens the page itself. Never a redirect, which the
    // XHR clients would follow and show as a broken PDF.
    for (const format of ['original', 'pdf']) {
      await assert.rejects(
        providerContent({ ref, user: ADA, format }),
        error => error.status === 410 && error.code === 'ORIGINAL_DISCARDED' && !error.redirect
      );
    }
    // The page's own policy applies to the reader of the item: a project is
    // not a way round `allowedGroups`.
    configCache.setCacheEntry('config/ui.json', {
      pages: { faq: { filePath: { en: 'faq.md' }, allowedGroups: ['legal'] } }
    });
    try {
      await assert.rejects(
        providerContent({ ref, user: ADA, format: 'text' }),
        error => error.status === 403
      );
      // Past the policy, the page itself decides (it may not exist in this
      // test's content directory): anything but a refusal.
      const allowed = await providerContent({
        ref,
        user: { ...ADA, groups: ['legal'] },
        format: 'text'
      }).catch(error => error);
      assert.notEqual(allowed?.status, 403, 'a reader in an allowed group gets past the policy');
    } finally {
      configCache.setCacheEntry('config/ui.json', { pages: {} });
    }
    configCache.setCacheEntry('config/features.json', { projects: true, userProjects: false });
    try {
      await assert.rejects(
        providerContent({ ref, user: ADA, format: 'text' }),
        error => error.status === 404
      );
      const dark = await resolveProjectScope({
        appConfig: { id: 'chat', _projectId: textProject.id },
        user: ADA
      });
      assert.equal(dark.length, 0, 'a user project is out of scope while the feature is off');
    } finally {
      configCache.setCacheEntry('config/features.json', { projects: true, userProjects: true });
    }
    const perApp = await resolveProjectScope({
      appConfig: { id: 'chat', _projectId: textProject.id, features: { userProjects: false } },
      user: ADA
    });
    assert.equal(perApp.length, 0, 'an app may switch user projects off for itself');
  });
});

describe('chat request schema', () => {
  it('keeps the project fields of a chat turn', () => {
    const parsed = chatPostSchema.body.parse({
      messages: [],
      projectId: 'prj_abc',
      projects: ['faq', 'prj_other']
    });
    assert.equal(parsed.projectId, 'prj_abc');
    assert.deepEqual(parsed.projects, ['faq', 'prj_other']);
    assert.equal(chatPostSchema.body.parse({ messages: [], projectId: null }).projectId, null);
  });
});

describe('prompt injection', () => {
  it('puts the projects block and the instructions into the system prompt', async () => {
    const app = {
      id: 'chat',
      system: { en: 'You are helpful.\n\n<knowledge>{{projects}}</knowledge>' },
      _projectId: textProject.id
    };
    const messages = await PromptService.processMessageTemplates(
      [{ role: 'user', content: 'What is the notice period?' }],
      app,
      null,
      null,
      'en',
      null,
      ADA,
      'chat-k1',
      { en: 'Small', de: 'Klein' },
      null,
      null,
      'small'
    );
    const system = messages[0].content;
    assert.ok(
      system.includes('<project-instructions project='),
      'instructions of the container apply'
    );
    assert.ok(system.includes('Answer as a lawyer'));
    assert.ok(system.includes('<knowledge><projects>'), 'the placeholder is replaced in place');
    assert.ok(
      system.includes('three months notice'),
      "the text fits the small model's budget and is loaded"
    );
    const scope = PromptService.takeKnowledgeScope('chat-k1');
    assert.equal(scope.projects[0].mode, 'loaded');
    assert.equal(PromptService.takeKnowledgeScope('chat-k1'), null, 'taken once');
    assert.deepEqual(PromptService.getPromptSources('chat-k1'), ['sources']);
    PromptService.resetPromptSources('chat-k1');
  });

  it('strips the placeholder when nothing is in scope and appends the block when there is none', async () => {
    const empty = await PromptService.processMessageTemplates(
      [{ role: 'user', content: 'hi' }],
      { id: 'chat', system: { en: 'Prompt {{projects}} end' } },
      null,
      null,
      'en',
      null,
      ADA,
      'chat-k2',
      'small'
    );
    assert.equal(empty[0].content.trim(), 'Prompt  end'.trim());
    const appended = await PromptService.processMessageTemplates(
      [{ role: 'user', content: 'hi' }],
      { id: 'chat', system: { en: 'Prompt' }, _attachedProjectIds: [textProject.id] },
      null,
      null,
      'en',
      null,
      GRACE,
      'chat-k3',
      'small'
    );
    assert.ok(appended[0].content.includes('Projects:\n<projects>'));
    assert.ok(
      !appended[0].content.includes('project-instructions'),
      'an attachment brings no instructions'
    );
    PromptService.takeKnowledgeScope('chat-k3');
    PromptService.resetPromptSources('chat-k3');
  });
});
