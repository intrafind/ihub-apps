// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The stubs of iFinder smart collections: a user adds one of their collections
 * to their projects (`POST /api/projects/_collections`) and gets a stored
 * project that keeps the default app, the instructions and the chats, while the
 * documents stay in the collection. Driven through the real route chains
 * against a fake iFinder.
 *
 * What is pinned here:
 *
 *  - a collection is listed as a project only once it is added, and is offered
 *    to add (with whether it was) by `GET /api/projects/_collections`;
 *  - the stub reads the collection's documents with the owner's rights, holds
 *    chats, and its instructions apply to a chat that runs inside it;
 *  - renaming renames both; a collection deleted in iFinder shows as deleted;
 *  - deleting removes the stub, and the collection too when asked;
 *  - the stub is never shared, published or transferred, and takes no item
 *    other than an iFinder document.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectionId as ID, createHarness } from './helpers/ifinderTierHarness.js';

const GROUP = ['authenticated'];
const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com', groups: GROUP };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', email: 'grace@example.com', groups: GROUP };

const h = await createHarness({ users: [ADA, GRACE] });
const { ifinder, drive } = h;
const { resetIFinderTier, itemIdOf } = await import('../services/projects/ifinder/IFinderTier.js');
const { resolveChatProjects } = await import('../services/knowledge/chatProjects.js');
const { resolveProjectScope } = await import('../services/knowledge/ProjectScope.js');
const { getProjectRepository } = await import('../services/projects/ProjectRepository.js');
const { getProjectService } = await import('../services/projects/ProjectService.js');

const route = {
  collections: h.handlersFor('get', '/api/projects/_collections'),
  addCollection: h.handlersFor('post', '/api/projects/_collections'),
  list: h.handlersFor('get', '/api/projects'),
  get: h.handlersFor('get', '/api/projects/:projectId'),
  patch: h.handlersFor('patch', '/api/projects/:projectId'),
  remove: h.handlersFor('delete', '/api/projects/:projectId'),
  addItem: h.handlersFor('post', '/api/projects/:projectId/items'),
  removeItem: h.handlersFor('delete', '/api/projects/:projectId/items/:itemId'),
  members: h.handlersFor('put', '/api/projects/:projectId/members'),
  catalog: h.handlersFor('put', '/api/projects/:projectId/catalog')
};

const addCollection = (user, body) => drive(route.addCollection, { user, method: 'POST', body });
const open = (user, projectId) => drive(route.get, { user, params: { projectId } });
const stubsOf = async user =>
  (await drive(route.list, { user })).body.items.filter(
    project => project.source?.type === 'smart-collection'
  );
const doc = (id, extra = {}) => ifinder.addDocument(id, { title: `Title ${id}`, ...extra });

/** Drop every stored project between tests: stubs are per owner and collection. */
async function clearProjects() {
  const repository = getProjectRepository();
  for (const user of [ADA, GRACE]) {
    for (const project of await repository.listOwned(user.id)) {
      await getProjectService().deleteProject(project.id);
    }
  }
  assert.deepEqual(await repository.listOwned(ADA.id), []);
}

after(() => h.close());
beforeEach(async () => {
  h.reset();
  await clearProjects();
});

describe('adding a collection to the projects', () => {
  it('lists collections to add, and a collection is a project only once added', async () => {
    h.collection(1, ADA.email, { name: 'Contracts', documents: ['doc-a'] });
    h.collection(2, ADA.email, { name: 'Policies' });
    const offered = await drive(route.collections, { user: ADA });
    assert.equal(offered.statusCode, 200);
    assert.deepEqual(offered.body.items.map(entry => [entry.collectionId, entry.added]).sort(), [
      [ID(1), false],
      [ID(2), false]
    ]);
    assert.deepEqual(await stubsOf(ADA), []);

    const res = await addCollection(ADA, {
      collectionId: ID(1),
      instructions: 'Cite the clause',
      defaultAppId: 'chat'
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.match(res.body.id, /^prj_/);
    assert.equal(res.body.tier, 'ifinder');
    assert.equal(res.body.name, 'Contracts');
    assert.equal(res.body.instructions, 'Cite the clause');
    assert.equal(res.body.defaultAppId, 'chat');
    assert.deepEqual(res.body.source, { type: 'smart-collection', collectionId: ID(1) });
    assert.equal(res.body.collection.state, 'ok');

    const listed = await stubsOf(ADA);
    assert.deepEqual(
      listed.map(project => project.id),
      [res.body.id]
    );
    assert.equal(listed[0].usage.items, 1, 'the count is the collection’s');
    const again = await drive(route.collections, { user: ADA });
    const added = again.body.items.find(entry => entry.collectionId === ID(1));
    assert.equal(added.added, true);
    assert.equal(added.projectId, res.body.id);
  });

  it('adds a collection once, and only one of the caller’s', async () => {
    h.collection(1, ADA.email);
    h.collection(2, GRACE.email);
    assert.equal((await addCollection(ADA, { collectionId: ID(1) })).statusCode, 201);
    const twice = await addCollection(ADA, { collectionId: ID(1) });
    assert.equal(twice.statusCode, 409);
    assert.equal(twice.body.details.code, 'COLLECTION_ALREADY_ADDED');
    const foreign = await addCollection(ADA, { collectionId: ID(2) });
    assert.equal(foreign.statusCode, 404, 'iFinder answers 404 for a collection of someone else');
    assert.equal((await addCollection(ADA, { collectionId: 'nope' })).statusCode, 400);
  });

  it('reads the documents with the owner’s rights; nobody else sees them', async () => {
    doc('doc-a');
    doc('doc-b');
    h.collection(1, ADA.email, { documents: ['doc-a', 'doc-b'] });
    const { body: stub } = await addCollection(ADA, { collectionId: ID(1) });
    const page = await open(ADA, stub.id);
    assert.equal(page.statusCode, 200);
    assert.deepEqual(
      page.body.items.map(item => item.name),
      ['Title doc-a', 'Title doc-b']
    );
    assert.equal((await open(GRACE, stub.id)).statusCode, 404, 'a stub is never shared');
  });
});

describe('a stub in a chat', () => {
  it('holds chats, and its instructions and documents apply to a chat inside it', async () => {
    doc('doc-a');
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const { body: stub } = await addCollection(ADA, {
      collectionId: ID(1),
      instructions: 'Answer in one sentence'
    });
    assert.equal(stub.permissions.canHoldChats, true);
    const resolved = await resolveChatProjects({
      req: { user: { ...ADA } },
      chat: null,
      app: { id: 'chat' },
      projectId: stub.id
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    assert.equal(resolved.containerId, stub.id);

    const scope = await resolveProjectScope({
      appConfig: { id: 'chat', _projectId: stub.id },
      user: { ...ADA }
    });
    assert.equal(scope.length, 1);
    assert.equal(scope[0].origin, 'container');
    assert.equal(scope[0].instructions, true, 'the instructions of the project a chat runs in');
    assert.equal(scope[0].project.instructions, 'Answer in one sentence');
    assert.deepEqual(
      scope[0].project.items.map(item => item.ref.documentId),
      ['doc-a']
    );
  });
});

describe('changing a stub', () => {
  it('renames the collection and the stub together, and keeps app and instructions here', async () => {
    h.collection(1, ADA.email, { name: 'Old', description: 'Old text' });
    const { body: stub } = await addCollection(ADA, { collectionId: ID(1) });
    const res = await drive(route.patch, {
      user: ADA,
      method: 'PATCH',
      params: { projectId: stub.id },
      body: { name: 'New', instructions: 'Be brief', defaultAppId: 'chat' }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'New');
    assert.equal(res.body.instructions, 'Be brief');
    assert.equal(res.body.defaultAppId, 'chat');
    assert.equal(ifinder.state.collections.get(ID(1)).name, 'New', 'renamed in iFinder');
    const patch = ifinder.requests.find(request => request.method === 'PATCH');
    assert.deepEqual(Object.keys(patch.body), ['name'], 'nothing but the name goes to iFinder');
    const stored = await getProjectRepository().get(stub.id);
    assert.equal(stored.name, 'New', 'and the stub keeps the name');
  });

  it('sends nothing to iFinder for the default app and the instructions alone', async () => {
    h.collection(1, ADA.email);
    const { body: stub } = await addCollection(ADA, { collectionId: ID(1) });
    ifinder.reset();
    const res = await drive(route.patch, {
      user: ADA,
      method: 'PATCH',
      params: { projectId: stub.id },
      body: { instructions: 'x', defaultAppId: null }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(
      ifinder.requests.filter(request => request.method !== 'GET').length,
      0,
      'no write reached iFinder'
    );
  });

  it('adds and removes documents in the collection', async () => {
    doc('doc-a');
    h.collection(1, ADA.email);
    const { body: stub } = await addCollection(ADA, { collectionId: ID(1) });
    const added = await drive(route.addItem, {
      user: ADA,
      method: 'POST',
      params: { projectId: stub.id },
      body: { kind: 'ifinder-document', ref: { documentId: 'doc-a' } }
    });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    assert.deepEqual(ifinder.documentIdsOf(ID(1)), ['doc-a']);
    const removed = await drive(route.removeItem, {
      user: ADA,
      method: 'DELETE',
      params: { projectId: stub.id, itemId: itemIdOf(ID(1), 'doc-a') }
    });
    assert.equal(removed.statusCode, 204, JSON.stringify(removed.body));
    assert.deepEqual(ifinder.documentIdsOf(ID(1)), []);
  });

  it('is never shared or published, and takes no other kind of item', async () => {
    h.collection(1, ADA.email);
    const { body: stub } = await addCollection(ADA, { collectionId: ID(1) });
    assert.equal(stub.permissions.canShare, false);
    assert.equal(stub.permissions.canTransfer, false);
    for (const [handlers, method, body] of [
      [route.members, 'PUT', { members: [] }],
      [route.catalog, 'PUT', { published: true }],
      [route.addItem, 'POST', { kind: 'url', ref: { url: 'https://example.com' } }]
    ]) {
      const res = await drive(handlers, {
        user: ADA,
        method,
        params: { projectId: stub.id },
        body
      });
      assert.equal(res.statusCode >= 400, true, `${method} ${JSON.stringify(body)}`);
    }
    assert.deepEqual(ifinder.documentIdsOf(ID(1)), []);
  });
});

describe('a deleted collection', () => {
  it('shows the stub as deleted in the list and on its page', async () => {
    h.collection(1, ADA.email, { name: 'Gone soon' });
    const { body: stub } = await addCollection(ADA, { collectionId: ID(1) });
    ifinder.state.collections.delete(ID(1));
    resetIFinderTier();
    const [listed] = await stubsOf(ADA);
    assert.equal(listed.collection.state, 'deleted');
    assert.equal(listed.name, 'Gone soon', 'named as it was');
    const page = await open(ADA, stub.id);
    assert.equal(page.statusCode, 200);
    assert.equal(page.body.collection.state, 'deleted');
    assert.deepEqual(page.body.items, []);
  });

  it('deletes the stub alone, or the collection too when asked', async () => {
    h.collection(1, ADA.email);
    h.collection(2, ADA.email);
    const { body: first } = await addCollection(ADA, { collectionId: ID(1) });
    const { body: second } = await addCollection(ADA, { collectionId: ID(2) });

    const alone = await drive(route.remove, {
      user: ADA,
      method: 'DELETE',
      params: { projectId: first.id }
    });
    assert.equal(alone.statusCode, 204, JSON.stringify(alone.body));
    assert.equal(ifinder.state.collections.has(ID(1)), true, 'the collection stays');

    const both = await drive(route.remove, {
      user: ADA,
      method: 'DELETE',
      params: { projectId: second.id },
      query: { deleteCollection: 'true' }
    });
    assert.equal(both.statusCode, 204, JSON.stringify(both.body));
    assert.equal(ifinder.state.collections.has(ID(2)), false, 'deleted in iFinder');
    assert.deepEqual(await stubsOf(ADA), []);
    const offered = await drive(route.collections, { user: ADA });
    assert.deepEqual(
      offered.body.items.map(entry => [entry.collectionId, entry.added]),
      [[ID(1), false]],
      'the collection kept in iFinder can be added again'
    );
  });
});

describe('the iFinder picker of a project', () => {
  const profiles = h.handlersFor('get', '/api/projects/pickers/ifinder/profiles');
  const search = h.handlersFor('get', '/api/projects/pickers/ifinder/search');

  it('offers the search profiles of the chat input and refuses one outside the allow-list', async () => {
    h.platform.iFinder = {
      ...h.platform.iFinder,
      defaultSearchProfile: 'standard',
      allowedSearchProfiles: ['standard', 'legal']
    };
    h.configCache.setCacheEntry('config/platform.json', h.platform);
    const listed = await drive(profiles, { user: ADA });
    assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
    const ids = listed.body.profiles.map(profile => profile.id);
    assert.ok(ids.includes('standard'), JSON.stringify(ids));
    assert.equal(listed.body.defaultProfile, 'standard');

    const refused = await drive(search, { user: ADA, query: { q: 'lease', profile: 'secret' } });
    assert.equal(refused.statusCode, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.details.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
  });
});
