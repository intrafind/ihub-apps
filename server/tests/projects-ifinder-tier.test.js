// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder tier of projects, iteration 1 (#3024): the user's smart
 * collections as read-only projects, driven through the real route chains
 * against a fake iFinder.
 *
 * What is pinned here:
 *
 *  - the tier is offered only when the policy says so, iFinder is configured,
 *    the user has a stable principal and the Smart Collections API answers
 *    (the capability call); an older iFinder never shows it;
 *  - `GET /api/projects` merges the local list with the user's collections,
 *    built for the requesting user on every call, cached per tenant and
 *    principal and never shared; a slow or failed iFinder costs a warning, not
 *    the local list;
 *  - a collection opens as a project whose documents are `ifinder-document`
 *    items, with titles fetched in batches and cached per user;
 *  - the read-only guarantee: no write route is reachable for an `ifc_` id;
 *  - a chat can attach a collection, never be held inside one, and the
 *    collection is searched, never loaded in full.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionDocument,
  generatePrivateKeyPem,
  startMockIFinder
} from './helpers/mockIFinder.js';

// The iFinder JWT is signed with the key from the environment; it has to be
// there before `config.js` is first read.
process.env.IFINDER_PRIVATE_KEY = await generatePrivateKeyPem();
delete process.env.IFINDER_API_URL;

const { default: configCache } = await import('../configCache.js');
const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { resolveGroupInheritance } = await import('../utils/authorization.js');
const { locateConfigFile } = await import('../utils/configFileLocation.js');
const { default: registerProjectRoutes } = await import('../routes/projectRoutes.js');
const { default: registerChatRoutes } = await import('../routes/chats.js');
const { default: iFinderService } = await import('../services/integrations/iFinderService.js');
const { getProjectRepository, isAdminProjectId } =
  await import('../services/projects/ProjectRepository.js');
const { resetIFinderTier, TTL, TITLE_BATCH, itemIdOf } =
  await import('../services/projects/ifinder/IFinderTier.js');
const { isIFinderProjectId, ifinderProjectIdOf } =
  await import('../services/projects/projectConstants.js');
const { adminProjectCreateSchema } = await import('../validators/projectSchema.js');
const { resolveChatProjects } = await import('../services/knowledge/chatProjects.js');
const { resolveProjectScope } = await import('../services/knowledge/ProjectScope.js');
const { planKnowledgeScope, renderProjectsBlock, scopeSummary } =
  await import('../services/knowledge/KnowledgeScopePlanner.js');
const { default: promptService } = await import('../services/PromptService.js');
const { providerFor } = await import('../services/knowledge/registry.js');
const { content: projectSourceContent } = await import('../services/sources/providers/project.js');
const { projectsClientConfig } = await import('../services/projects/projectSettings.js');

const group = ['authenticated'];
const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com', groups: group };
/** The same person as ADA for iFinder (same email), another iHub account. */
const ADA_TWIN = {
  id: 'user-ada-2',
  name: 'Ada (second account)',
  email: 'ada@example.com',
  groups: group
};
const GRACE = { id: 'user-grace', name: 'Grace Hopper', email: 'grace@example.com', groups: group };
const MIXED = {
  id: 'user-mixed',
  name: 'Mixed Case',
  email: 'Mixed.Case@Example.com',
  groups: group
};
const LOCAL = { id: 'user-local', name: 'Local Without Email', groups: group };
const AGENT = { ...ADA, id: 'agent-1', isAgent: true };
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pid = n => ifinderProjectIdOf(ID(n));

let scratch;
let platform;
let ifinder;

function captureRoutes(register) {
  const routes = [];
  const guards = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: (routePath, ...handlers) => guards.push({ routePath, handlers })
  });
  return { routes, guards };
}

const projects = captureRoutes(registerProjectRoutes);
const chats = captureRoutes(registerChatRoutes);

function handlersFor({ routes }, method, suffix) {
  const found = routes.find(entry => entry.method === method && entry.routePath.endsWith(suffix));
  assert.ok(found, `${method.toUpperCase()} ${suffix} must be registered`);
  return found.handlers;
}

function makeResponse() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.end = () => res;
  res.send = value => {
    res.body = value;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  return res;
}

/** Run a route the way express would: the path guards first, then its handlers. */
async function drive(handlers, { params = {}, query = {}, body = {}, user, method = 'GET' } = {}) {
  const req = {
    params,
    query,
    body,
    headers: {},
    user: user ? { ...user, groups: [...(user.groups || [])] } : undefined,
    ip: '127.0.0.1',
    method,
    url: '/'
  };
  const res = makeResponse();
  // The path guards of `/api/projects/:projectId` run before the route's own handlers.
  const guards =
    params.projectId === undefined ? [] : projects.guards.flatMap(guard => guard.handlers);
  const chain = [...guards, ...handlers];
  for (const handler of chain) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

const route = {
  config: handlersFor(projects, 'get', '/api/projects/_config'),
  list: handlersFor(projects, 'get', '/api/projects'),
  get: handlersFor(projects, 'get', '/api/projects/:projectId'),
  items: handlersFor(projects, 'get', '/api/projects/:projectId/items'),
  chats: handlersFor(projects, 'get', '/api/projects/:projectId/chats'),
  chatPatch: handlersFor(chats, 'patch', '/api/chats/:chatId')
};

function setPlatform({ tierPolicy = 'both', iFinder = { baseUrl: ifinder.url } } = {}) {
  platform.projects = { tierPolicy, limits: { maxProjectsPerUser: 0 } };
  platform.iFinder = { ...iFinder, ...(iFinder.baseUrl ? { jwtSubjectField: 'email' } : {}) };
  configCache.setCacheEntry('config/platform.json', platform);
  iFinderService.resetConfig();
}

function collection(n, owner, { name = `Collection ${n}`, documents = [], modified } = {}) {
  ifinder.addCollection(collectionDocument({ id: ID(n), owner, name, documents, modified }));
}

before(async () => {
  ifinder = await startMockIFinder();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-projects-ifinder-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, 'data'), flushIntervalMs: 25 }
    }
  });
  const users = {};
  for (const user of [ADA, ADA_TWIN, GRACE, MIXED, LOCAL]) {
    users[user.id] = { ...user, username: user.id.replace('user-', ''), active: true };
  }
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  platform = {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    chats: { enabled: true },
    proxy: { enabled: false }
  };
  configCache.setCacheEntry('config/features.json', {
    projects: true,
    userProjects: true,
    chatPersistence: true
  });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: { apps: ['chat'], projects: true, projectSharing: true }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: ['chat'] } }
      }
    })
  );
  configCache.setCacheEntry('config/apps.json', [
    { id: 'chat', name: { en: 'Chat' }, enabled: true }
  ]);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/projects.json', []);
  setPlatform();
});

after(async () => {
  await ifinder.close();
  await shutdownStorageBootstrap();
  await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  mock.timers.reset();
  ifinder.state.collections.clear();
  ifinder.state.documents.clear();
  ifinder.reset();
  resetIFinderTier();
  setPlatform();
});

const listIds = res => res.body.items.map(project => project.id);
const listOf = async user => drive(route.list, { user });

describe('the tier policy and the capability call', () => {
  it('offers collections under both and ifinder, never under ihub', async () => {
    collection(1, ADA.email);
    setPlatform({ tierPolicy: 'ihub' });
    assert.deepEqual(listIds(await listOf(ADA)), []);
    assert.equal(ifinder.requests.length, 0, 'the policy is read before iFinder is asked');

    for (const tierPolicy of ['both', 'ifinder']) {
      resetIFinderTier();
      setPlatform({ tierPolicy });
      assert.deepEqual(listIds(await listOf(ADA)), [pid(1)], tierPolicy);
    }
  });

  it('offers nothing without an iFinder configuration', async () => {
    collection(1, ADA.email);
    setPlatform({ tierPolicy: 'both', iFinder: {} });
    assert.deepEqual(listIds(await listOf(ADA)), []);
    assert.equal(ifinder.requests.length, 0);
  });

  it('tells the client which tiers are configured, and which are available to this user', async () => {
    collection(1, ADA.email);
    assert.deepEqual(projectsClientConfig({}, { projects: { tierPolicy: 'ihub' } }).tiers, [
      'ihub'
    ]);
    const configured = projectsClientConfig(
      {},
      { projects: { tierPolicy: 'both' }, iFinder: { baseUrl: ifinder.url } }
    );
    assert.deepEqual(configured.tiers, ['ihub', 'ifinder']);

    const available = await drive(route.config, { user: ADA });
    assert.deepEqual(available.body.ifinder, { available: true, readOnly: true });

    setPlatform({ tierPolicy: 'ihub' });
    const off = await drive(route.config, { user: ADA });
    assert.deepEqual(off.body.ifinder, { available: false, readOnly: true });
  });

  it('never shows the tier of an iFinder without the API, and remembers it', async () => {
    collection(1, ADA.email);
    ifinder.state.collectionsStatus = 404;
    assert.deepEqual(listIds(await listOf(ADA)), []);
    assert.equal((await listOf(ADA)).body.warnings.length, 0, 'an older iFinder is no failure');
    assert.equal(ifinder.calls('collections').length, 1, 'the answer is remembered');
    const config = await drive(route.config, { user: GRACE });
    assert.deepEqual(config.body.ifinder, {
      available: false,
      readOnly: true,
      reason: 'UNSUPPORTED'
    });
    assert.equal(ifinder.calls('collections').length, 1, 'for every user of the installation');

    // It is asked again once the remembered answer expires (an iFinder upgrade).
    mock.timers.enable({ apis: ['Date'], now: Date.now() + TTL.unsupported + 1000 });
    ifinder.state.collectionsStatus = null;
    assert.deepEqual(listIds(await listOf(ADA)), [pid(1)]);
  });

  it('hides the tier from a user whose token lacks the role, and only from them', async () => {
    collection(1, ADA.email);
    collection(2, GRACE.email);
    ifinder.state.collectionsStatus = 403;
    assert.deepEqual(listIds(await listOf(ADA)), []);
    assert.equal(ifinder.calls('collections').length, 1);
    ifinder.state.collectionsStatus = null;
    assert.deepEqual(
      listIds(await listOf(GRACE)),
      [pid(2)],
      'the role is the user, not the installation'
    );
    assert.deepEqual(listIds(await listOf(ADA)), [], 'and what iFinder said stays remembered');
    const config = await drive(route.config, { user: ADA });
    assert.equal(config.body.ifinder.available, false);
    assert.equal(config.body.ifinder.reason, 'FORBIDDEN');
  });

  it('gives nothing to anonymous callers, delegated principals and users without a subject', async () => {
    collection(1, ADA.email);
    for (const user of [
      LOCAL,
      AGENT,
      { id: 'anonymous', name: 'Anonymous', groups: ['anonymous'] }
    ]) {
      const res = await listOf(user);
      assert.deepEqual(res.body?.items?.filter(project => project.tier === 'ifinder') ?? [], []);
    }
    assert.equal(ifinder.requests.length, 0, 'no request is sent for them');
    const opened = await drive(route.get, { user: LOCAL, params: { projectId: pid(1) } });
    assert.equal(opened.statusCode, 404);
    assert.equal(ifinder.requests.length, 0);
  });
});

describe('the project list', () => {
  it('merges the collections of the caller as read-only projects, with counts only', async () => {
    collection(1, ADA.email, {
      name: 'Contracts',
      documents: ['doc-a', 'doc-b'],
      modified: '2026-10-21T10:00:00Z'
    });
    collection(2, ADA.email, {
      name: 'Policies',
      documents: ['doc-c'],
      modified: '2026-10-25T10:00:00Z'
    });
    collection(3, GRACE.email, { name: 'Graces', documents: ['doc-g'] });
    const res = await listOf(ADA);
    assert.equal(res.statusCode, 200);
    const mine = res.body.items.filter(project => project.tier === 'ifinder');
    assert.deepEqual(
      mine.map(project => project.id),
      [pid(2), pid(1)],
      'newest activity first, like the rest of the list'
    );
    const [policies] = mine;
    assert.equal(policies.name, 'Policies');
    assert.equal(policies.readOnly, true);
    assert.equal(policies.usage.items, 1);
    assert.equal(policies.items, undefined, 'the list sends no documents');
    assert.deepEqual(policies.source, { type: 'smart-collection', collectionId: ID(2) });
    assert.equal(policies.role, 'owner');
    assert.equal(policies.permissions.canUse, true);
    for (const flag of ['canEdit', 'canShare', 'canDelete', 'canTransfer', 'canHoldChats']) {
      assert.equal(policies.permissions[flag], false, flag);
    }
    assert.equal(policies.permissions.readOnly, true);
    assert.equal(JSON.stringify(res.body).includes('doc-'), false, 'no document id is listed');
    assert.deepEqual(res.body.warnings, []);
  });

  it('gives the namespaced id a form no stored project can have', () => {
    assert.equal(pid(1), `ifc_${ID(1)}`);
    assert.equal(isIFinderProjectId(pid(1)), true);
    for (const bad of [
      'ifc_',
      'ifc_x',
      'ifc_ABCDEF00-0000-4000-8000-00000000000A',
      `ifc_${ID(1)}/..`,
      `prj_${ID(1)}`
    ]) {
      assert.equal(isIFinderProjectId(bad), false, bad);
    }
    assert.equal(isAdminProjectId(pid(1)), false, 'an admin project may not take it');
    assert.equal(isAdminProjectId('ifc_anything'), false);
    assert.equal(
      adminProjectCreateSchema.safeParse({ id: 'ifc_docs', name: { en: 'Docs' } }).success,
      false
    );
    assert.equal(
      adminProjectCreateSchema.safeParse({ id: 'docs', name: { en: 'Docs' } }).success,
      true
    );
  });

  it('caches per principal and builds the answer for the caller on every call', async () => {
    collection(1, ADA.email, { name: 'Adas notes' });
    collection(2, GRACE.email, { name: 'Graces notes' });

    const first = await listOf(ADA);
    assert.deepEqual(listIds(first), [pid(1)]);
    assert.equal(ifinder.calls('collections').length, 1);

    // The cache holds iFinder's data, not a response: changing what was sent
    // must not change what comes next.
    first.body.items[0].name = 'tampered';
    const again = await listOf(ADA);
    assert.equal(ifinder.calls('collections').length, 1, 'a cache hit sends nothing');
    assert.equal(again.body.items[0].name, 'Adas notes');

    // Another principal never reads that entry.
    const grace = await listOf(GRACE);
    assert.deepEqual(listIds(grace), [pid(2)]);
    assert.equal(ifinder.calls('collections').length, 2);
    assert.equal(ifinder.calls('collections')[1].sub, GRACE.email);
    assert.equal(JSON.stringify(grace.body).includes('Adas notes'), false);
    assert.equal(JSON.stringify(grace.body).includes(ID(1)), false);

    // The same iFinder identity from another iHub account: the data is shared
    // by principal, the response is still built for the caller.
    const twin = await listOf(ADA_TWIN);
    assert.equal(ifinder.calls('collections').length, 2, 'same principal, same entry');
    assert.equal(twin.body.items[0].owner.id, ADA_TWIN.id);
    assert.equal(twin.body.items[0].owner.name, ADA_TWIN.name);
    assert.equal(again.body.items[0].owner.id, ADA.id);
  });

  it('keys the cache by the principal exactly as signed, case included', async () => {
    // iFinder's list matches the owner exactly (owner.keyword has no normalizer).
    collection(1, 'mixed.case@example.com', { name: 'Stored lowercase' });
    collection(2, MIXED.email, { name: 'Stored as signed' });
    const res = await listOf(MIXED);
    assert.deepEqual(listIds(res), [pid(2)], 'the lowercase owner is missing from the list');
    assert.equal(ifinder.calls('collections')[0].sub, 'Mixed.Case@Example.com');

    // The per-collection check ignores case, so that collection still opens by id.
    const opened = await drive(route.get, { user: MIXED, params: { projectId: pid(1) } });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.body.name, 'Stored lowercase');
  });

  it('answers with the local list and a warning while iFinder is down, and does not ask again at once', async () => {
    collection(1, ADA.email);
    ifinder.state.collectionsStatus = 503;
    const res = await listOf(ADA);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.warnings, [{ code: 'IFINDER_UNAVAILABLE', tier: 'ifinder' }]);
    assert.deepEqual(listIds(res), []);
    assert.equal(ifinder.calls('collections').length, 1);

    const second = await listOf(GRACE);
    assert.equal(second.body.warnings.length, 1, 'still told, for any user');
    assert.equal(
      ifinder.calls('collections').length,
      1,
      'a down iFinder is not asked on every request'
    );

    mock.timers.enable({ apis: ['Date'], now: Date.now() + TTL.unavailable + 1000 });
    ifinder.state.collectionsStatus = null;
    const recovered = await listOf(ADA);
    assert.deepEqual(listIds(recovered), [pid(1)]);
    assert.deepEqual(recovered.body.warnings, []);
  });

  it('answers with the local list and a warning when iFinder is too slow', async () => {
    ifinder.state.hang = true;
    const started = Date.now();
    const res = await listOf(ADA);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.warnings[0].code, 'IFINDER_UNAVAILABLE');
    assert.ok(Date.now() - started < 8000, 'the short timeout bounds the wait');
  });

  it('keeps a cached list while another call finds iFinder down', async () => {
    collection(1, ADA.email);
    collection(2, GRACE.email);
    assert.deepEqual(listIds(await listOf(ADA)), [pid(1)]);
    ifinder.state.collectionsStatus = 503;
    assert.equal((await listOf(GRACE)).body.warnings.length, 1);
    const cached = await listOf(ADA);
    assert.deepEqual(listIds(cached), [pid(1)]);
    assert.deepEqual(
      cached.body.warnings,
      [],
      'current data is not taken away by a failure elsewhere'
    );
  });
});

describe('opening a collection', () => {
  it('shows its documents as ifinder-document items, named by the titles the user may see', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a', 'doc-b', 'doc-hidden'] });
    ifinder.addDocument('doc-a', { title: 'Lease 2026', content: 'lease text' });
    ifinder.addDocument('doc-b', { title: 'NDA', content: 'nda text' });
    ifinder.addDocument('doc-hidden', { title: 'Secret', hiddenFrom: [ADA.email] });
    const res = await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.tier, 'ifinder');
    assert.equal(res.body.readOnly, true);
    assert.equal(res.body.permissions.canEdit, false);
    assert.deepEqual(
      res.body.items.map(item => [
        item.kind,
        item.ref.documentId,
        item.name,
        item.storage,
        item.status
      ]),
      [
        ['ifinder-document', 'doc-a', 'Lease 2026', 'link', 'ready'],
        ['ifinder-document', 'doc-b', 'NDA', 'link', 'ready'],
        ['ifinder-document', 'doc-hidden', 'doc-hidden', 'link', 'ready']
      ],
      'a document the user may not see is named by its id and answers unavailable when read'
    );
    assert.equal(res.body.items[0].id, itemIdOf(ID(1), 'doc-a'));
    assert.equal(
      (await drive(route.items, { user: ADA, params: { projectId: pid(1) } })).body.items.length,
      3
    );
    const search = ifinder.calls('search')[0];
    assert.equal(search.sub, ADA.email, "titles are fetched with the reader's own rights");
    assert.equal(search.scope, 'fi_index_read', 'a document search needs no collections role');
    assert.equal(search.query.query_logging, undefined, 'the lookup stays out of the query log');
  });

  it('answers 404 for a collection that is someone elses, missing, or opened without a subject', async () => {
    collection(2, GRACE.email);
    for (const [user, id] of [
      [ADA, pid(2)],
      [ADA, pid(9)],
      [LOCAL, pid(2)]
    ]) {
      const res = await drive(route.get, { user, params: { projectId: id } });
      assert.equal(res.statusCode, 404, `${user.id} ${id}`);
    }
  });

  it('answers 503 while iFinder cannot be reached', async () => {
    collection(1, ADA.email);
    ifinder.state.collectionsStatus = 503;
    const res = await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.details.code, 'IFINDER_UNAVAILABLE');
  });

  it('stays dark while user projects are off, and under the ihub policy', async () => {
    collection(1, ADA.email);
    configCache.setCacheEntry('config/features.json', { projects: true, userProjects: false });
    const off = await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(off.statusCode, 403);
    assert.equal(off.body.details.code, 'USER_PROJECTS_DISABLED');
    configCache.setCacheEntry('config/features.json', {
      projects: true,
      userProjects: true,
      chatPersistence: true
    });
    setPlatform({ tierPolicy: 'ihub' });
    assert.equal(
      (await drive(route.get, { user: ADA, params: { projectId: pid(1) } })).statusCode,
      404
    );
  });

  it('asks for titles in batches of at most 100 and caches them per user', async () => {
    const documents = Array.from({ length: 200 }, (_, index) => `doc-${index}`);
    collection(1, ADA.email, { documents });
    collection(2, GRACE.email, { documents: ['doc-0', 'doc-1'] });
    for (const id of documents) ifinder.addDocument(id, { title: `Title ${id}` });

    const res = await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(res.body.items.length, 200);
    assert.equal(res.body.items[199].name, 'Title doc-199');
    const searches = ifinder.calls('search');
    assert.equal(searches.length, 2);
    assert.deepEqual(
      searches.map(request => request.ids.length),
      [TITLE_BATCH, 100]
    );
    assert.ok(searches.every(request => request.query.size === '100'));
    assert.ok(searches.every(request => request.query.query_logging === undefined));

    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(ifinder.calls('search').length, 2, 'the titles are cached for this user');

    // Another user has their own entries, even for a document with the same id.
    await drive(route.get, { user: GRACE, params: { projectId: pid(2) } });
    assert.equal(ifinder.calls('search').length, 3);
    assert.equal(ifinder.calls('search')[2].sub, GRACE.email);
  });

  it('keeps the collection cached for a moment, so a request does not ask twice', async () => {
    collection(1, ADA.email, { documents: ['doc-a'] });
    ifinder.addDocument('doc-a', { title: 'A' });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(ifinder.calls('collections').length, 1);
    mock.timers.enable({ apis: ['Date'], now: Date.now() + TTL.collection + 1000 });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(ifinder.calls('collections').length, 2);
  });
});

describe('the read-only guarantee', () => {
  it('refuses every write route for an iFinder project, before anything is looked up', async () => {
    collection(1, ADA.email, { documents: ['doc-a'] });
    const writes = projects.routes.filter(
      entry => entry.method !== 'get' && entry.routePath.includes(':projectId')
    );
    assert.ok(writes.length >= 10, 'the project routes with a write are found');
    const repository = getProjectRepository();
    const before = (await repository.listOwned(ADA.id)).length;
    ifinder.reset();
    for (const entry of writes) {
      const res = await drive(entry.handlers, {
        user: ADA,
        method: entry.method.toUpperCase(),
        params: { projectId: pid(1), itemId: 'itm_x' },
        body: {
          name: 'changed',
          kind: 'url',
          ref: { url: 'https://example.com' },
          published: true,
          members: []
        }
      });
      assert.equal(
        res.statusCode,
        403,
        `${entry.method} ${entry.routePath}: ${JSON.stringify(res.body)}`
      );
      assert.equal(res.body.details?.code, 'PROJECT_READ_ONLY', entry.routePath);
    }
    assert.equal(ifinder.requests.length, 0, 'the refusal comes before any lookup');
    assert.equal((await repository.listOwned(ADA.id)).length, before);
    assert.equal(await repository.get(pid(1)), null, 'nothing was stored under the id');
  });

  it('gives the same answer for an id that does not exist, so a write reveals nothing', async () => {
    const entry = projects.routes.find(
      route => route.method === 'patch' && route.routePath.endsWith('/api/projects/:projectId')
    );
    const res = await drive(entry.handlers, {
      user: GRACE,
      method: 'PATCH',
      params: { projectId: pid(77) },
      body: { name: 'x' }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details.code, 'PROJECT_READ_ONLY');
  });

  it('keeps the permission block fixed whoever asks, an admin included', async () => {
    const { projectPermissions } = await import('../services/projects/projectAccess.js');
    const project = { id: pid(1), ownership: 'user', tier: 'ifinder', owner: { id: ADA.id } };
    const admin = {
      ...ADA,
      id: 'user-root',
      groups: ['admins'],
      permissions: { adminAccess: true }
    };
    for (const user of [ADA, GRACE, admin]) {
      const permissions = projectPermissions(project, user, {
        isAdmin: true,
        isContentAdmin: true
      });
      assert.equal(permissions.canEdit, false);
      assert.equal(permissions.canShare, false);
      assert.equal(permissions.canDelete, false);
      assert.equal(permissions.canTransfer, false);
      assert.equal(permissions.readOnly, true);
    }
    assert.equal(projectPermissions(project, { id: 'anonymous' }, {}).canView, false);
    // The id decides, not a stored tier: a stored project cannot opt in or out.
    assert.equal(
      projectPermissions(
        { id: 'prj_x', ownership: 'user', tier: 'ifinder', owner: { id: ADA.id } },
        ADA,
        {}
      ).canEdit,
      true
    );
  });

  it('does not let a chat move into a collection, but lets it attach one', async () => {
    collection(1, ADA.email, { documents: ['doc-a'] });
    const req = { user: { ...ADA, groups: [...group] } };
    const app = { id: 'chat', name: { en: 'Chat' } };
    const asContainer = await resolveChatProjects({
      req,
      chat: null,
      app,
      projectId: pid(1),
      projects: undefined
    });
    assert.equal(asContainer.ok, false);
    assert.equal(asContainer.code, 'PROJECT_NOT_FOUND');

    const attached = await resolveChatProjects({
      req: { user: { ...ADA, groups: [...group] } },
      chat: null,
      app,
      projectId: undefined,
      projects: [pid(1)]
    });
    assert.equal(attached.ok, true);
    assert.deepEqual(attached.attachedIds, [pid(1)]);

    // Someone elses collection, or a stranger: nothing is attached.
    const stranger = await resolveChatProjects({
      req: { user: { ...GRACE, groups: [...group] } },
      chat: null,
      app,
      projectId: undefined,
      projects: [pid(1)]
    });
    assert.deepEqual(stranger.attachedIds, []);
  });
});

describe('a chat that uses a collection as knowledge', () => {
  const CTX = user => ({ user, chatId: 'chat-1', language: 'en' });

  async function scopeOf(user, ids) {
    return resolveProjectScope({
      appConfig: { id: 'chat', _attachedProjectIds: ids },
      user: { ...user, groups: [...group], permissions: { projects: true } }
    });
  }

  it('puts the collection in the scope of its owner and of nobody else', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    ifinder.addDocument('doc-a', {
      title: 'Lease',
      content: 'The deposit is returned in 30 days.'
    });
    const mine = await scopeOf(ADA, [pid(1)]);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].project.tier, 'ifinder');
    assert.equal(mine[0].write, false);
    assert.equal(mine[0].project.items[0].kind, 'ifinder-document');
    assert.deepEqual(await scopeOf(GRACE, [pid(1)]), []);
  });

  it('loads the attached projects at once and keeps the order they were asked in', async () => {
    collection(1, ADA.email, { documents: ['doc-a'] });
    collection(2, ADA.email, { documents: ['doc-b'] });
    ifinder.state.delays.set(ID(1), 300);
    ifinder.state.delays.set(ID(2), 300);
    const scope = await scopeOf(ADA, [pid(1), pid(2)]);
    assert.deepEqual(
      scope.map(entry => entry.project.id),
      [pid(1), pid(2)]
    );
    const reads = ifinder
      .calls('collections')
      .filter(request => request.path.endsWith(ID(1)) || request.path.endsWith(ID(2)));
    assert.equal(reads.length, 2);
    // The second read was sent long before the first one answered (one after the other it would wait 300 ms).
    assert.ok(Math.abs(reads[1].at - reads[0].at) < 150, 'both reads are on their way together');
  });

  it('searches the collection and never loads it in full', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a', 'doc-b'] });
    ifinder.addDocument('doc-a', {
      title: 'Lease',
      content: 'The deposit is returned in 30 days.'
    });
    ifinder.addDocument('doc-b', {
      title: 'NDA',
      content: 'Confidential information stays secret.'
    });
    const scope = await scopeOf(ADA, [pid(1)]);
    const plan = await planKnowledgeScope(scope, {
      model: { contextWindow: 200000 },
      settings: { loadAllMaxTokens: 50000 },
      ctx: CTX(ADA)
    });
    assert.equal(plan.projects[0].mode, 'searched');
    assert.equal(plan.projects[0].documents, 2);
    assert.equal(ifinder.calls('docs').length, 0, 'planning reads no document');

    const provider = providerFor(scope[0].project);
    const found = await provider.search(scope[0].project, CTX(ADA), { query: 'deposit returned' });
    assert.equal(found.hits[0].docId, itemIdOf(ID(1), 'doc-a'));
    assert.equal(found.hits[0].name, 'Lease');
    assert.ok(found.hits[0].text.includes('deposit'));
    assert.ok(
      ifinder.calls('docs').every(request => request.sub === ADA.email),
      "the reader's rights"
    );
  });

  it('names a document the reader may not open as unavailable', async () => {
    collection(1, ADA.email, { documents: ['doc-a', 'doc-hidden'] });
    ifinder.addDocument('doc-a', { title: 'Lease', content: 'The deposit is returned.' });
    ifinder.addDocument('doc-hidden', {
      title: 'Secret',
      content: 'secret deposit',
      hiddenFrom: [ADA.email]
    });
    const scope = await scopeOf(ADA, [pid(1)]);
    const found = await providerFor(scope[0].project).search(scope[0].project, CTX(ADA), {
      query: 'deposit'
    });
    assert.deepEqual(
      found.hits.map(hit => hit.docId),
      [itemIdOf(ID(1), 'doc-a')]
    );
    assert.equal(found.unavailable.length, 1);
    assert.equal(found.unavailable[0].document, itemIdOf(ID(1), 'doc-hidden'));
  });

  it('reads documents one at a time through the knowledge provider, with the same ids as the view', async () => {
    collection(1, ADA.email, { documents: ['doc-a'] });
    ifinder.addDocument('doc-a', {
      title: 'Lease',
      content: 'The deposit is returned in 30 days.'
    });
    const scope = await scopeOf(ADA, [pid(1)]);
    const { project } = scope[0];
    const read = await providerFor(project).read(project, CTX(ADA), {
      itemId: itemIdOf(ID(1), 'doc-a')
    });
    assert.ok(read.text.includes('30 days'));
    const view = await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    assert.equal(view.body.items[0].id, itemIdOf(ID(1), 'doc-a'));
  });

  it("opens a citation of a collection document with the reader's own rights", async () => {
    collection(1, ADA.email, { documents: ['doc-a'] });
    ifinder.addDocument('doc-a', {
      title: 'Lease',
      content: 'The deposit is returned in 30 days.'
    });
    const ref = { id: itemIdOf(ID(1), 'doc-a'), scope: pid(1) };
    const user = { ...ADA, groups: [...group] };
    const text = await projectSourceContent({ ref, user, format: 'text' });
    assert.match(String(text.body), /30 days/);
    await assert.rejects(
      projectSourceContent({ ref, user: { ...GRACE, groups: [...group] }, format: 'text' }),
      error => error.status === 404 || /not found/i.test(error.message)
    );
  });
});

describe('an attached collection iFinder cannot deliver', () => {
  const asUser = user => ({ ...user, groups: [...group], permissions: { projects: true } });
  const appOf = ids => ({ id: 'chat', _attachedProjectIds: ids });

  /** Load a collection once, so its name is known, then let every cache expire and take iFinder down. */
  async function takeIFinderDown() {
    mock.timers.enable({ apis: ['Date'], now: Date.now() + TTL.collection + TTL.list + 1000 });
    ifinder.state.collectionsStatus = 503;
  }

  it('leaves it out of the scope the tools and workflow nodes see', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    ifinder.addDocument('doc-a', { title: 'Lease', content: 'x' });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    await takeIFinderDown();
    const scope = await resolveProjectScope({ appConfig: appOf([pid(1)]), user: asUser(ADA) });
    assert.deepEqual(scope, []);
  });

  it('keeps a stand-in for the chat prompt, named as the user last saw the collection', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    ifinder.addDocument('doc-a', { title: 'Lease', content: 'x' });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    await takeIFinderDown();
    const scope = await resolveProjectScope({
      appConfig: appOf([pid(1)]),
      user: asUser(ADA),
      includeUnavailable: true
    });
    assert.equal(scope.length, 1);
    assert.equal(scope[0].unavailable, 'IFINDER_UNAVAILABLE');
    assert.equal(scope[0].project.id, pid(1));
    assert.equal(scope[0].project.name, 'Contracts');
    assert.deepEqual(scope[0].project.items, []);
    assert.equal(scope[0].write, false);
    assert.equal(scope[0].instructions, false);
  });

  it("names nobody else's collection: the stand-in carries only what this user saw", async () => {
    collection(1, GRACE.email, { name: 'Graces private notes', documents: ['doc-g'] });
    await drive(route.get, { user: GRACE, params: { projectId: pid(1) } });
    await takeIFinderDown();
    const scope = await resolveProjectScope({
      appConfig: appOf([pid(1)]),
      user: asUser(ADA),
      includeUnavailable: true
    });
    assert.equal(scope.length, 1);
    assert.equal(scope[0].project.name, '', 'a name only another principal saw is not used');
    assert.equal(JSON.stringify(scope).includes('Graces'), false);
  });

  it('is dark while user projects are off, like every collection', async () => {
    collection(1, ADA.email);
    await takeIFinderDown();
    configCache.setCacheEntry('config/features.json', { projects: true, userProjects: false });
    try {
      const scope = await resolveProjectScope({
        appConfig: appOf([pid(1)]),
        user: asUser(ADA),
        includeUnavailable: true
      });
      assert.deepEqual(scope, []);
    } finally {
      configCache.setCacheEntry('config/features.json', {
        projects: true,
        userProjects: true,
        chatPersistence: true
      });
    }
  });

  it('is planned as unavailable, said to the model and reported to the chat', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    ifinder.addDocument('doc-a', { title: 'Lease', content: 'x' });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    await takeIFinderDown();
    const user = asUser(ADA);
    const scope = await resolveProjectScope({
      appConfig: appOf([pid(1)]),
      user,
      includeUnavailable: true
    });
    const plan = await planKnowledgeScope(scope, {
      model: { contextWindow: 200000 },
      settings: { loadAllMaxTokens: 50000 },
      ctx: { user, chatId: 'chat-1', language: 'en' }
    });
    assert.equal(plan.projects[0].mode, 'unavailable');
    assert.equal(plan.projects[0].reason, 'IFINDER_UNAVAILABLE');
    assert.equal(ifinder.calls('docs').length, 0, 'no document is read for it');

    const block = renderProjectsBlock(plan);
    assert.match(block, /<project id="ifc_[^"]+" name="Contracts" mode="unavailable"/);
    assert.match(block, /iFinder could not be reached/);
    assert.match(block, /say so to the user/);

    const summary = scopeSummary(plan).projects[0];
    assert.equal(summary.mode, 'unavailable');
    assert.equal(summary.reason, 'IFINDER_UNAVAILABLE');
    assert.equal(summary.name, 'Contracts');
  });

  it('reaches the chat through the prompt: the block names it and the turn reports it', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    ifinder.addDocument('doc-a', { title: 'Lease', content: 'x' });
    await drive(route.get, { user: ADA, params: { projectId: pid(1) } });
    await takeIFinderDown();
    const out = await promptService._applyProjects(
      'You are helpful. {{projects}}',
      appOf([pid(1)]),
      {
        user: asUser(ADA),
        chatId: 'chat-unavailable',
        lang: 'en',
        modelName: null,
        scopeKey: 'prep-unavailable'
      }
    );
    assert.match(out, /mode="unavailable"/);
    assert.match(out, /iFinder could not be reached/);
    const reported = promptService.takeKnowledgeScope('prep-unavailable');
    assert.equal(reported.projects.length, 1);
    assert.equal(reported.projects[0].mode, 'unavailable');
    assert.equal(reported.projects[0].name, 'Contracts');
  });

  it('does not touch a collection that loads', async () => {
    collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    ifinder.addDocument('doc-a', { title: 'Lease', content: 'x' });
    const scope = await resolveProjectScope({
      appConfig: appOf([pid(1)]),
      user: asUser(ADA),
      includeUnavailable: true
    });
    assert.equal(scope.length, 1);
    assert.equal(scope[0].unavailable, undefined);
    assert.equal(scope[0].project.items.length, 1);
  });
});
