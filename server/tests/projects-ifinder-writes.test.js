// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder tier of projects, iteration 2 (#3024): manage the membership of the
 * user's smart collections from iHub (create, rename, add documents, remove
 * documents), driven through the real route chains against a fake iFinder whose
 * writes are the utilities service's: an unversioned read-modify-write that loses
 * an update when two writes overlap.
 *
 * What is pinned here:
 *
 *  - create sends no owner, the caller owns the result, and the list shows it;
 *  - rename sends `name` and `description` only (the PATCH writes every non-null
 *    field: an `owner` or `documents` would hand the collection away or overwrite
 *    the list);
 *  - add checks that the user can read each document, refuses an overflow of the
 *    200-document cap with a clear error, and sends nothing in either case;
 *  - remove takes the membership and never the document;
 *  - writes to one collection are serialized by the storage layer's lock, across
 *    instances: two concurrent adds both survive with the lock and one is lost
 *    without it; where no lock reaches every instance, writes are off and
 *    `_config` says why;
 *  - a write evicts the caller's cached list, collection and titles;
 *  - iFinder failing after some documents were added is reported, document by
 *    document, and a retry is safe.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectionId as ID, createHarness } from './helpers/ifinderTierHarness.js';
import { FilesystemLockManager } from '../storage/providers/filesystem/FilesystemLockManager.js';

const GROUP = ['authenticated'];
const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com', groups: GROUP };
/** The same person as ADA for iFinder (same email), another iHub account. */
const ADA_TWIN = { id: 'user-ada-2', name: 'Ada (2)', email: 'ada@example.com', groups: GROUP };
const GRACE = { id: 'user-grace', name: 'Grace Hopper', email: 'grace@example.com', groups: GROUP };
const LOCAL = { id: 'user-local', name: 'Local Without Email', groups: GROUP };
const NOCREATE = {
  id: 'user-nocreate',
  name: 'No Create',
  email: 'nocreate@example.com',
  groups: ['nocreate']
};
const ROOT = {
  id: 'user-root',
  name: 'Root',
  email: 'root@example.com',
  groups: ['admins'],
  permissions: { adminAccess: true }
};

const h = await createHarness({ users: [ADA, ADA_TWIN, GRACE, LOCAL, NOCREATE, ROOT] });
const { ifinder, drive } = h;
const { pid } = await (async () => {
  const { ifinderProjectIdOf } = await import('../services/projects/projectConstants.js');
  return { pid: n => ifinderProjectIdOf(ID(n)) };
})();
const { itemIdOf, resetIFinderTier, TTL } =
  await import('../services/projects/ifinder/IFinderTier.js');
const { setStorageResolver } = await import('../services/projects/ifinder/collectionLock.js');
const { getStorage } = await import('../storage/bootstrap.js');
const { default: smartCollections } =
  await import('../services/integrations/SmartCollectionsService.js');
const { MAX_DOCUMENTS } = await import('../services/projects/ifinder/IFinderCollectionWriter.js');

const route = {
  config: h.handlersFor('get', '/api/projects/_config'),
  list: h.handlersFor('get', '/api/projects/_collections'),
  get: h.handlersFor('get', '/api/projects/:projectId'),
  create: h.handlersFor('post', '/api/projects'),
  rename: h.handlersFor('patch', '/api/projects/:projectId'),
  add: h.handlersFor('post', '/api/projects/:projectId/items'),
  remove: h.handlersFor('delete', '/api/projects/:projectId/items/:itemId')
};

const create = (user, body) => drive(route.create, { user, method: 'POST', body });
const rename = (user, n, body) =>
  drive(route.rename, { user, method: 'PATCH', params: { projectId: pid(n) }, body });
const add = (user, n, body) =>
  drive(route.add, { user, method: 'POST', params: { projectId: pid(n) }, body });
const addOne = (user, n, documentId) =>
  add(user, n, { kind: 'ifinder-document', ref: { documentId } });
const remove = (user, n, documentId) =>
  drive(route.remove, {
    user,
    method: 'DELETE',
    params: { projectId: pid(n), itemId: itemIdOf(ID(n), documentId) }
  });
const open = (user, n) => drive(route.get, { user, params: { projectId: pid(n) } });
/** The user's collections as `GET /api/projects/_collections` lists them, by project id. */
const list = async user => {
  const res = await drive(route.list, { user });
  res.body.items = (res.body.items || []).map(item => ({
    ...item,
    id: `ifc_${item.collectionId}`,
    usage: { items: item.documentCount }
  }));
  return res;
};
const documentsOf = n => ifinder.documentIdsOf(ID(n));
const writes = () =>
  ifinder.requests.filter(
    request => request.method !== 'GET' && request.path.includes('smart-collections')
  );
const doc = (id, extra = {}) => ifinder.addDocument(id, { title: `Title ${id}`, ...extra });

before(() => {});
after(() => h.close());
beforeEach(() => h.reset());

describe('creating a collection', () => {
  it('creates it for the caller, sends no owner and answers with the project', async () => {
    ifinder.state.nextIds.push(ID(5));
    const res = await create(ADA, {
      name: 'Contracts',
      description: 'All of them',
      tier: 'ifinder'
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.match(res.body.id, /^prj_/, 'the project is the stored stub of the collection');
    assert.deepEqual(res.body.source, { type: 'smart-collection', collectionId: ID(5) });
    assert.equal(res.body.collection.state, 'ok');
    assert.equal(res.body.tier, 'ifinder');
    assert.equal(res.body.name, 'Contracts');
    assert.equal(res.body.description, 'All of them');
    assert.equal(res.body.permissions.canEdit, true);
    assert.equal(res.body.permissions.canShare, false);
    assert.equal(res.body.permissions.canDelete, true, 'the owner deletes the stub');
    assert.equal(res.body.permissions.canHoldChats, true, 'chats run inside it');
    const [request] = writes();
    assert.equal(request.method, 'POST');
    assert.equal(request.scope, 'fi_smartcollections');
    assert.deepEqual(request.body, { name: 'Contracts', description: 'All of them' });
    assert.equal('owner' in request.body, false, 'iFinder fills the owner from the token');
    assert.equal(ifinder.state.collections.get(ID(5)).owner, ADA.email, 'owned by the JWT sub');
  });

  it('shows the new collection in the list again, also while iFinder indexes it', async () => {
    ifinder.lagList();
    ifinder.state.nextIds.push(ID(5));
    await create(ADA, { name: 'Contracts', tier: 'ifinder' });
    assert.deepEqual(
      (await list(ADA)).body.items.map(item => item.id),
      [pid(5)]
    );
    ifinder.refreshIndex();
    resetIFinderTier();
    assert.deepEqual(
      (await list(ADA)).body.items.map(item => item.id),
      [pid(5)],
      'and after the refresh'
    );
    assert.deepEqual((await list(GRACE)).body.items, [], 'nobody else sees it');
  });

  it('puts the overlay away once the index has caught up', async () => {
    ifinder.lagList();
    ifinder.state.nextIds.push(ID(5));
    await create(ADA, { name: 'Contracts', tier: 'ifinder' });
    ifinder.refreshIndex();
    await rename(ADA, 5, { name: 'Contracts 2' });
    const overlaid = (await list(ADA)).body.items;
    assert.equal(overlaid[0].name, 'Contracts 2', 'the list lags, the overlay wins');
    const { default: mockTimers } = await import('node:test');
    mockTimers.mock.timers.enable({
      apis: ['Date'],
      now: Date.now() + TTL.overlay + TTL.list + 1000
    });
    try {
      ifinder.refreshIndex();
      assert.equal((await list(ADA)).body.items[0].name, 'Contracts 2');
    } finally {
      mockTimers.mock.timers.reset();
    }
  });

  it('still creates local projects, with or without a tier', async () => {
    const plain = await create(ADA, { name: 'Local one' });
    assert.equal(plain.statusCode, 201, JSON.stringify(plain.body));
    assert.equal(plain.body.tier, 'ihub');
    const explicit = await create(ADA, { name: 'Local two', tier: 'ihub' });
    assert.equal(explicit.statusCode, 201);
    assert.equal(explicit.body.tier, 'ihub');
    assert.equal(writes().length, 0, 'iFinder was not asked');
  });

  it('keeps the default app and the instructions on its project, never in iFinder', async () => {
    ifinder.state.nextIds.push(ID(6));
    const res = await create(ADA, {
      name: 'X',
      tier: 'ifinder',
      instructions: 'Be brief',
      defaultAppId: 'chat'
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.instructions, 'Be brief');
    assert.equal(res.body.defaultAppId, 'chat');
    const [request] = writes();
    assert.deepEqual(request.body, { name: 'X', description: '' });
  });

  it('refuses what a collection does not have, and who may not create', async () => {
    assert.equal((await create(ADA, { name: '', tier: 'ifinder' })).statusCode, 400);
    assert.equal((await create(ADA, { name: 'X', tier: 'other' })).statusCode, 400);
    assert.equal((await create(NOCREATE, { name: 'X', tier: 'ifinder' })).statusCode, 403);
    const noPrincipal = await create(LOCAL, { name: 'X', tier: 'ifinder' });
    assert.equal(noPrincipal.statusCode, 403);
    assert.equal(noPrincipal.body.details.code, 'TIER_NOT_AVAILABLE');
    h.setPlatform({ tierPolicy: 'ihub' });
    const policy = await create(ADA, { name: 'X', tier: 'ifinder' });
    assert.equal(policy.statusCode, 403);
    assert.equal(policy.body.details.code, 'TIER_NOT_AVAILABLE');
    assert.equal(ifinder.requests.length, 0, 'none of these reached iFinder');
  });

  it('is refused for an iFinder without the API, for a missing role, and while iFinder is down', async () => {
    ifinder.state.collectionsStatus = 404;
    const old = await create(ADA, { name: 'X', tier: 'ifinder' });
    assert.equal(old.statusCode, 403);
    assert.equal(old.body.details.code, 'TIER_NOT_AVAILABLE');
    assert.equal(old.body.details.reason, 'UNSUPPORTED');
    h.reset();
    ifinder.state.collectionsStatus = 500;
    const down = await create(ADA, { name: 'X', tier: 'ifinder' });
    assert.equal(down.statusCode, 503);
    assert.equal(down.body.details.code, 'IFINDER_UNAVAILABLE');
  });

  it('says it is not known whether the collection was created when the answer is lost', async () => {
    ifinder.state.dropAnswer = true;
    const res = await create(ADA, { name: 'Maybe', tier: 'ifinder' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.details.code, 'IFINDER_WRITE_FAILED');
    assert.equal(res.body.details.outcome, 'unknown');
  });
});

describe('renaming a collection', () => {
  it('sends the name and the description only, never the owner or the documents', async () => {
    h.collection(1, ADA.email, {
      name: 'Old',
      description: 'Old text',
      documents: ['doc-a', 'doc-b']
    });
    const res = await rename(ADA, 1, { name: 'New', description: 'New text' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'New');
    assert.equal(res.body.description, 'New text');
    const patch = ifinder.requests.find(request => request.method === 'PATCH');
    assert.equal(patch.path.endsWith(`/${ID(1)}`), true);
    assert.equal(patch.scope, 'fi_smartcollections');
    assert.deepEqual(Object.keys(patch.body).sort(), ['description', 'name']);
    const stored = ifinder.state.collections.get(ID(1));
    assert.equal(stored.owner, ADA.email, 'the owner is untouched');
    assert.deepEqual(documentsOf(1), ['doc-a', 'doc-b'], 'the documents are untouched');
    assert.equal(res.body.items.length, 2, 'and the project still lists both');
  });

  it('sends the name alone when only the name changes', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    await rename(ADA, 1, { name: 'Only the name' });
    const patch = ifinder.requests.find(request => request.method === 'PATCH');
    assert.deepEqual(Object.keys(patch.body), ['name']);
  });

  it('refuses a body that names anything else, before iFinder is asked to write', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    for (const body of [
      { owner: GRACE.email },
      { name: 'X', owner: GRACE.email },
      { documents: [] },
      { viewers: ['everyone'] },
      { instructions: 'x' },
      { defaultAppId: 'chat' },
      {},
      { name: '' }
    ]) {
      const res = await rename(ADA, 1, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal(writes().length, 0);
    assert.equal(ifinder.state.collections.get(ID(1)).owner, ADA.email);
  });

  it('answers 404 for the collection of someone else and for a missing one', async () => {
    h.collection(1, GRACE.email, { documents: ['doc-a'] });
    const foreign = await rename(ADA, 1, { name: 'Mine now' });
    assert.equal(foreign.statusCode, 404);
    assert.equal((await rename(ADA, 9, { name: 'Nothing' })).statusCode, 404);
    assert.equal(ifinder.state.collections.get(ID(1)).name, 'Collection 1');
    assert.equal(writes().length, 0);
  });

  it('shows the new name at once, from the list and the page, not after the cache expires', async () => {
    h.collection(1, ADA.email, { name: 'Old', documents: ['doc-a'] });
    assert.equal((await list(ADA)).body.items[0].name, 'Old');
    assert.equal((await open(ADA, 1)).body.name, 'Old');
    await rename(ADA, 1, { name: 'New' });
    assert.equal((await list(ADA)).body.items[0].name, 'New');
    assert.equal((await open(ADA, 1)).body.name, 'New');
  });

  it('shows the new name in the list while iFinder has not indexed it yet', async () => {
    h.collection(1, ADA.email, { name: 'Old' });
    ifinder.lagList();
    await rename(ADA, 1, { name: 'New' });
    assert.equal((await list(ADA)).body.items[0].name, 'New');
  });
});

describe('adding documents', () => {
  beforeEach(() => {
    doc('doc-a');
    doc('doc-b');
    doc('doc-c');
    doc('doc-hidden', { hiddenFrom: [ADA.email] });
  });

  it('adds a document the user can read, and answers with the item', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const res = await addOne(ADA, 1, 'doc-b');
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.item.kind, 'ifinder-document');
    assert.equal(res.body.item.ref.documentId, 'doc-b');
    assert.equal(res.body.item.name, 'Title doc-b');
    assert.equal(res.body.item.id, itemIdOf(ID(1), 'doc-b'));
    assert.deepEqual(documentsOf(1), ['doc-a', 'doc-b']);
    const [post] = writes();
    assert.equal(post.scope, 'fi_smartcollections');
    assert.deepEqual(post.body, [{ id: 'doc-b' }]);
    const page = await open(ADA, 1);
    assert.deepEqual(
      page.body.items.map(item => item.ref.documentId),
      ['doc-a', 'doc-b']
    );
    assert.equal(page.body.usage.items, 2);
  });

  it('checks readability with the user token before it writes, and sends nothing when one fails', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const res = await addOne(ADA, 1, 'doc-hidden');
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.details.code, 'DOCUMENT_NOT_READABLE');
    assert.deepEqual(res.body.details.documentIds, ['doc-hidden']);
    const missing = await addOne(ADA, 1, 'doc-nowhere');
    assert.equal(
      missing.body.details.code,
      'DOCUMENT_NOT_READABLE',
      'iFinder checks no id: iHub does'
    );
    assert.equal(writes().length, 0);
    assert.deepEqual(documentsOf(1), ['doc-a']);
    const search = ifinder.calls('search').at(-1);
    assert.equal(search.sub, ADA.email, 'asked with the user own token');
    // Another user can read it, and may add it to their own collection.
    h.collection(2, GRACE.email);
    assert.equal((await addOne(GRACE, 2, 'doc-hidden')).statusCode, 201);
  });

  it('refuses the whole call when one of several documents is not readable', async () => {
    h.collection(1, ADA.email);
    const res = await add(ADA, 1, {
      items: [
        { kind: 'ifinder-document', ref: { documentId: 'doc-a' } },
        { kind: 'ifinder-document', ref: { documentId: 'doc-hidden' } },
        { kind: 'ifinder-document', ref: { documentId: 'doc-b' } }
      ]
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body.details.documentIds, ['doc-hidden']);
    assert.deepEqual(documentsOf(1), [], 'none was added');
    assert.equal(writes().length, 0);
  });

  it('adds several at once, skips members and says which were new', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const res = await add(ADA, 1, {
      items: ['doc-a', 'doc-b', 'doc-c', 'doc-b'].map(documentId => ({
        kind: 'ifinder-document',
        ref: { documentId }
      }))
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.added, ['doc-b', 'doc-c']);
    assert.deepEqual(res.body.alreadyMember, ['doc-a']);
    assert.deepEqual(documentsOf(1), ['doc-a', 'doc-b', 'doc-c']);
    assert.deepEqual(
      writes().map(request => request.body),
      [[{ id: 'doc-b' }, { id: 'doc-c' }]]
    );
  });

  it('answers 200 and writes nothing for a document that is a member already', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const res = await addOne(ADA, 1, 'doc-a');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.alreadyMember, true);
    assert.equal(writes().length, 0);
  });

  it('refuses an overflow of the 200-document cap with a clear error, and sends nothing', async () => {
    const full = Array.from({ length: MAX_DOCUMENTS - 1 }, (_, index) => `old-${index}`);
    h.collection(1, ADA.email, { documents: full });
    assert.equal((await addOne(ADA, 1, 'doc-a')).statusCode, 201, 'the 200th fits');
    assert.equal(documentsOf(1).length, MAX_DOCUMENTS);
    const over = await addOne(ADA, 1, 'doc-b');
    assert.equal(over.statusCode, 413);
    assert.equal(over.body.details.code, 'QUOTA_COLLECTION_DOCUMENTS');
    assert.equal(over.body.details.limit, MAX_DOCUMENTS);
    assert.equal(over.body.details.used, MAX_DOCUMENTS);
    assert.equal(over.body.details.requested, 1);
    assert.equal(writes().length, 1, 'only the first add was sent');
    assert.equal(documentsOf(1).length, MAX_DOCUMENTS);
    // A batch that would cross the cap is refused as a whole.
    h.collection(2, ADA.email, { documents: full.slice(0, MAX_DOCUMENTS - 2) });
    const batch = await add(ADA, 2, {
      items: ['doc-a', 'doc-b', 'doc-c'].map(documentId => ({
        kind: 'ifinder-document',
        ref: { documentId }
      }))
    });
    assert.equal(batch.statusCode, 413);
    assert.equal(documentsOf(2).length, MAX_DOCUMENTS - 2);
  });

  it('takes iFinder documents only', async () => {
    h.collection(1, ADA.email);
    for (const body of [
      { kind: 'url', ref: { url: 'https://example.com' } },
      { kind: 'ifinder-query', ref: { query: 'x' } },
      { kind: 'page', ref: { pageId: 'home' } },
      { kind: 'upload', ref: {} },
      { kind: 'nonsense', ref: {} }
    ]) {
      const res = await add(ADA, 1, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.body.details.code, 'KIND_NOT_ALLOWED', body.kind);
    }
    const multipart = await drive(route.add, {
      user: ADA,
      method: 'POST',
      params: { projectId: pid(1) },
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: {}
    });
    assert.equal(multipart.statusCode, 400);
    assert.equal(multipart.body.details.code, 'KIND_NOT_ALLOWED');
    const bad = await add(ADA, 1, { kind: 'ifinder-document', ref: { documentId: '', extra: 1 } });
    assert.equal(bad.statusCode, 400);
    assert.equal(writes().length, 0);
    assert.equal(ifinder.calls('search').length, 0, 'no document was looked up either');
  });

  it('answers 404 for the collection of someone else, and writes nothing', async () => {
    h.collection(1, GRACE.email, { documents: ['doc-a'] });
    const res = await addOne(ADA, 1, 'doc-b');
    assert.equal(res.statusCode, 404);
    assert.equal(writes().length, 0);
    assert.deepEqual(documentsOf(1), ['doc-a']);
  });

  it('evicts the caches: the page, the list and the title of a document that was not visible', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    assert.equal((await list(ADA)).body.items[0].usage.items, 1);
    assert.equal((await open(ADA, 1)).body.items.length, 1);
    // A "not visible" title entry for a document that becomes visible: it was asked
    // about while hidden, and must not hide it after it was added.
    ifinder.addDocument('doc-late', { title: 'Late', hiddenFrom: [ADA.email] });
    h.collection(2, ADA.email, { documents: ['doc-late'] });
    assert.equal((await open(ADA, 2)).body.items[0].name, 'doc-late', 'named by its id');
    ifinder.state.documents.get('doc-late').hiddenFrom.clear();
    assert.equal(
      (await open(ADA, 2)).body.items[0].name,
      'doc-late',
      'the negative title is cached for the user'
    );
    h.collection(3, ADA.email);
    assert.equal((await addOne(ADA, 3, 'doc-late')).statusCode, 201);
    assert.equal((await open(ADA, 3)).body.items[0].name, 'Late');
    assert.equal(
      (await open(ADA, 2)).body.items[0].name,
      'Late',
      'the stale entry is gone for good'
    );
    await addOne(ADA, 1, 'doc-b');
    assert.equal((await list(ADA)).body.items.find(item => item.id === pid(1)).usage.items, 2);
    assert.equal((await open(ADA, 1)).body.items.length, 2);
  });

  it('does not keep the answer of a read that was out while the write finished', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    ifinder.state.delays.set(ID(1), 150);
    const slowRead = open(ADA, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    ifinder.state.delays.delete(ID(1));
    await addOne(ADA, 1, 'doc-b');
    assert.equal((await slowRead).body.items.length, 1, 'it answered what it read');
    assert.equal(
      (await open(ADA, 1)).body.items.length,
      2,
      'and did not put that back in the cache'
    );
  });
});

describe('removing documents', () => {
  it('removes the membership and leaves the document alone', async () => {
    doc('doc-a');
    doc('doc-b');
    h.collection(1, ADA.email, { documents: ['doc-a', 'doc-b'] });
    const res = await remove(ADA, 1, 'doc-a');
    assert.equal(res.statusCode, 204, JSON.stringify(res.body));
    assert.deepEqual(documentsOf(1), ['doc-b']);
    assert.equal(ifinder.state.documents.has('doc-a'), true, 'the document is untouched');
    assert.equal(ifinder.state.documents.get('doc-a').content, '');
    const request = ifinder.requests.find(entry => entry.method === 'DELETE');
    assert.equal(request.path.endsWith(`/${ID(1)}/documents`), true);
    assert.equal(request.scope, 'fi_smartcollections');
    assert.deepEqual(request.body, [{ id: 'doc-a' }]);
    assert.equal(
      ifinder.requests.filter(entry => entry.path.includes('/docs/')).length,
      0,
      'the document was not even read'
    );
    const page = await open(ADA, 1);
    assert.deepEqual(
      page.body.items.map(item => item.ref.documentId),
      ['doc-b']
    );
    assert.equal((await list(ADA)).body.items[0].usage.items, 1);
  });

  it('answers 404 for an item that is not in the collection, and for the collection of someone else', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const unknown = await drive(route.remove, {
      user: ADA,
      method: 'DELETE',
      params: { projectId: pid(1), itemId: 'itm_unknown' }
    });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.body.details.code, 'ITEM_NOT_FOUND');
    h.collection(2, GRACE.email, { documents: ['doc-a'] });
    assert.equal((await remove(ADA, 2, 'doc-a')).statusCode, 404);
    assert.equal(writes().length, 0);
    assert.deepEqual(documentsOf(1), ['doc-a']);
    assert.deepEqual(documentsOf(2), ['doc-a']);
  });
});

describe('who may write', () => {
  it('lets only the owner write: an admin gains nothing, the collection of another is 404', async () => {
    doc('doc-a');
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    for (const user of [GRACE, ROOT]) {
      assert.equal((await rename(user, 1, { name: 'Taken' })).statusCode, 404, user.id);
      assert.equal((await addOne(user, 1, 'doc-a')).statusCode, 404, user.id);
      assert.equal((await remove(user, 1, 'doc-a')).statusCode, 404, user.id);
    }
    assert.equal(writes().length, 0);
    assert.equal(ifinder.state.collections.get(ID(1)).name, 'Collection 1');
    // The same on the page: the owner may edit, nobody else sees it.
    assert.equal((await open(ADA, 1)).body.permissions.canEdit, true);
    assert.equal((await open(ROOT, 1)).statusCode, 404);
  });

  it('refuses a user who cannot hold projects, and writes while projects are off', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    const agent = { ...ADA, id: 'agent-1', isAgent: true };
    assert.notEqual((await rename(agent, 1, { name: 'x' })).statusCode, 200);
    h.configCache.setCacheEntry('config/features.json', {
      projects: true,
      userProjects: false,
      chatPersistence: true
    });
    try {
      assert.equal((await rename(ADA, 1, { name: 'x' })).statusCode, 403);
    } finally {
      h.configCache.setCacheEntry('config/features.json', {
        projects: true,
        userProjects: true,
        chatPersistence: true
      });
    }
    assert.equal(writes().length, 0);
  });
});

describe('writes to one collection are serialized', () => {
  /** Two lock managers over one directory: two instances sharing a lock store. */
  function twoInstances() {
    const a = new FilesystemLockManager({ baseDir: h.baseDir, pollMs: 5 });
    const b = new FilesystemLockManager({ baseDir: h.baseDir, pollMs: 5 });
    let turn = 0;
    setStorageResolver(() => ({
      locks: turn++ % 2 === 0 ? a : b,
      getCapabilities: () => ({ locking: 'distributed', multiInstance: true })
    }));
  }

  /** A lock that excludes nothing: what the writes would have without one. */
  function noExclusion() {
    setStorageResolver(() => ({
      locks: { withLock: (_name, fn) => fn() },
      getCapabilities: () => ({ locking: 'distributed', multiInstance: true })
    }));
  }

  beforeEach(() => {
    doc('doc-a');
    doc('doc-b');
    doc('doc-c');
    ifinder.state.rmwDelayMs = 80;
  });

  it('keeps both of two concurrent adds from two instances', async () => {
    twoInstances();
    h.collection(1, ADA.email);
    const [first, second] = await Promise.all([addOne(ADA, 1, 'doc-a'), addOne(ADA, 1, 'doc-b')]);
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    assert.equal(second.statusCode, 201, JSON.stringify(second.body));
    assert.deepEqual(documentsOf(1).sort(), ['doc-a', 'doc-b']);
  });

  it('loses one of them without the lock: the fake is a real lossy read-modify-write', async () => {
    noExclusion();
    h.collection(1, ADA.email);
    await Promise.all([addOne(ADA, 1, 'doc-a'), addOne(ADA, 1, 'doc-b')]);
    assert.equal(documentsOf(1).length, 1, 'one of the two adds was overwritten');
  });

  it('serializes an add, a remove and a rename of one collection', async () => {
    twoInstances();
    h.collection(1, ADA.email, { documents: ['doc-c'] });
    const results = await Promise.all([
      addOne(ADA, 1, 'doc-a'),
      addOne(ADA, 1, 'doc-b'),
      rename(ADA, 1, { name: 'Renamed' }),
      remove(ADA, 1, 'doc-c')
    ]);
    assert.deepEqual(
      results.map(res => res.statusCode),
      [201, 201, 200, 204]
    );
    assert.deepEqual(documentsOf(1).sort(), ['doc-a', 'doc-b']);
    assert.equal(ifinder.state.collections.get(ID(1)).name, 'Renamed');
  });

  it('does not make writes to different collections wait for each other', async () => {
    twoInstances();
    h.collection(1, ADA.email);
    h.collection(2, ADA.email);
    const started = Date.now();
    const [first, second] = await Promise.all([addOne(ADA, 1, 'doc-a'), addOne(ADA, 2, 'doc-b')]);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    const writeRequests = writes();
    assert.equal(writeRequests.length, 2);
    // Both writes were in flight together: each started before the other finished.
    assert.ok(Math.abs(writeRequests[0].at - writeRequests[1].at) < 70, 'they overlapped');
    assert.ok(Date.now() - started < 1500);
  });

  it('takes the lock by collection and by installation, never by user', async () => {
    const names = [];
    setStorageResolver(() => ({
      locks: {
        withLock: (name, fn, options) => {
          names.push({ name, options });
          return fn();
        }
      },
      getCapabilities: () => ({ locking: 'distributed', multiInstance: true })
    }));
    h.collection(1, ADA.email);
    await addOne(ADA, 1, 'doc-a');
    await addOne(ADA_TWIN, 1, 'doc-b');
    assert.equal(names.length, 2);
    assert.equal(names[0].name, names[1].name, 'the same name for two users of one principal');
    assert.match(names[0].name, new RegExp(`^ifinder-collection:[0-9a-f]{16}:${ID(1)}$`));
    assert.ok(names[0].options.ttlMs > 0 && names[0].options.waitMs > 0);
  });

  it('tells a second writer the collection is busy when the lock stays taken', async () => {
    const { LockTimeoutError } = await import('../storage/errors.js');
    setStorageResolver(() => ({
      locks: {
        withLock: () => {
          throw new LockTimeoutError('held elsewhere');
        }
      },
      getCapabilities: () => ({ locking: 'distributed', multiInstance: true })
    }));
    h.collection(1, ADA.email);
    const res = await addOne(ADA, 1, 'doc-a');
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.details.code, 'COLLECTION_BUSY');
    assert.equal(writes().length, 0);
  });

  it('serializes two iHub users that are one principal in iFinder, and shares their caches', async () => {
    twoInstances();
    h.collection(1, ADA.email);
    assert.equal((await list(ADA_TWIN)).body.items.length, 1, 'the twin has the list cached');
    const [first, second] = await Promise.all([
      addOne(ADA, 1, 'doc-a'),
      addOne(ADA_TWIN, 1, 'doc-b')
    ]);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.deepEqual(documentsOf(1).sort(), ['doc-a', 'doc-b']);
    // The caches are keyed by the principal as signed: one user's write evicts the
    // entry the other reads, so the twin sees both documents at once.
    assert.equal((await list(ADA_TWIN)).body.items[0].usage.items, 2);
    assert.equal((await open(ADA_TWIN, 1)).body.items.length, 2);
  });

  it('says so when a writer outside iHub (the iFinder UI) overwrites an add before it is read back', async () => {
    twoInstances();
    doc('doc-a');
    h.collection(1, ADA.email, { documents: ['doc-c'] });
    // The lock only holds iHub's writers back: a write from the iFinder UI lands
    // between iHub's write and the read that verifies it, and drops the new document.
    ifinder.state.afterWrite = collection => {
      collection.documents = [{ id: 'doc-c' }];
    };
    const res = await addOne(ADA, 1, 'doc-a');
    assert.equal(res.statusCode, 502, JSON.stringify(res.body));
    assert.equal(res.body.details.code, 'IFINDER_WRITE_FAILED');
    assert.equal(res.body.details.outcome, 'partial');
    assert.deepEqual(res.body.details.not, ['doc-a']);
    assert.deepEqual(documentsOf(1), ['doc-c']);
  });
});

describe('where no lock reaches every instance', () => {
  const providers = {
    'no storage': [() => null, 'NO_LOCK'],
    'a provider without locks': [
      () => ({ getCapabilities: () => ({ locking: 'distributed', multiInstance: true }) }),
      'NO_LOCK'
    ],
    'a lock that excludes nothing': [
      () => ({
        locks: { withLock: (_n, fn) => fn() },
        getCapabilities: () => ({ locking: 'none', multiInstance: false })
      }),
      'NO_LOCK'
    ],
    'several instances and an advisory single-machine lock': [
      () => ({
        locks: { withLock: (_n, fn) => fn() },
        getCapabilities: () => ({ locking: 'advisory-single-machine', multiInstance: true })
      }),
      'MULTI_INSTANCE'
    ]
  };

  for (const [label, [provider, reason]] of Object.entries(providers)) {
    it(`keeps writes off with ${label}, says why, and still reads`, async () => {
      doc('doc-a');
      h.collection(1, ADA.email, { documents: ['doc-a'] });
      setStorageResolver(provider);
      const config = await drive(route.config, { user: ADA });
      assert.equal(config.body.ifinder.available, true);
      assert.equal(config.body.ifinder.writable, false);
      assert.equal(config.body.ifinder.writeDisabledReason, reason);
      assert.equal(config.body.ifinder.maxDocuments, 200);
      // Reads keep working, the permission block says nobody changes it here.
      const page = await open(ADA, 1);
      assert.equal(page.statusCode, 200);
      assert.equal(page.body.items.length, 1);
      assert.equal(page.body.permissions.canEdit, false);
      assert.equal(page.body.permissions.readOnly, true);
      assert.equal(page.body.permissions.canUse, true);
      ifinder.reset();
      resetIFinderTier();
      for (const res of [
        await rename(ADA, 1, { name: 'x' }),
        await addOne(ADA, 1, 'doc-a'),
        await remove(ADA, 1, 'doc-a'),
        await create(ADA, { name: 'x', tier: 'ifinder' })
      ]) {
        assert.equal(res.statusCode, 403, JSON.stringify(res.body));
        assert.equal(res.body.details.code, 'IFINDER_WRITES_DISABLED');
        assert.equal(res.body.details.reason, reason);
      }
      assert.equal(writes().length, 0, 'iFinder never saw a write');
      assert.deepEqual(documentsOf(1), ['doc-a']);
    });
  }

  it('turns writes on where the lock is distributed, or the storage is one machine', async () => {
    const config = async () => (await drive(route.config, { user: ADA })).body.ifinder;
    // The bootstrapped storage: the filesystem provider, workers of one machine.
    assert.equal(getStorage().getCapabilities().multiInstance, false);
    assert.equal((await config()).writable, true);
    assert.equal('writeDisabledReason' in (await config()), false);
    setStorageResolver(() => ({
      locks: { withLock: (_n, fn) => fn() },
      getCapabilities: () => ({ locking: 'distributed', multiInstance: true })
    }));
    assert.equal((await config()).writable, true);
  });

  it('reports no writes for a user the tier is not offered to', async () => {
    const config = await drive(route.config, { user: LOCAL });
    assert.equal(config.body.ifinder.available, false);
    assert.equal(config.body.ifinder.writable, false);
    assert.equal('writeDisabledReason' in config.body.ifinder, false);
  });
});

describe('iFinder failing in the middle of a write', () => {
  beforeEach(() => {
    for (const id of ['doc-a', 'doc-b', 'doc-c']) doc(id);
  });
  const batch = ids => ({
    items: ids.map(documentId => ({ kind: 'ifinder-document', ref: { documentId } }))
  });

  it('says which documents were added when iFinder answers an error after some', async () => {
    h.collection(1, ADA.email);
    assert.equal((await open(ADA, 1)).body.items.length, 0);
    ifinder.state.failAfter = 2;
    const res = await add(ADA, 1, batch(['doc-a', 'doc-b', 'doc-c']));
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.details.code, 'IFINDER_WRITE_FAILED');
    assert.equal(res.body.details.outcome, 'partial');
    assert.deepEqual(res.body.details.added, ['doc-a', 'doc-b']);
    assert.deepEqual(res.body.details.not, ['doc-c']);
    assert.deepEqual(documentsOf(1), ['doc-a', 'doc-b']);
    // The caches were evicted although the call failed: the page shows what is there.
    assert.deepEqual(
      (await open(ADA, 1)).body.items.map(item => item.ref.documentId),
      ['doc-a', 'doc-b']
    );
    // A retry of the same call is safe: members are skipped, the rest is added.
    const retry = await add(ADA, 1, batch(['doc-a', 'doc-b', 'doc-c']));
    assert.equal(retry.statusCode, 201, JSON.stringify(retry.body));
    assert.deepEqual(retry.body.added, ['doc-c']);
    assert.deepEqual(retry.body.alreadyMember, ['doc-a', 'doc-b']);
    assert.deepEqual(documentsOf(1), ['doc-a', 'doc-b', 'doc-c']);
  });

  it('says that nothing was added when iFinder refuses the write', async () => {
    h.collection(1, ADA.email);
    ifinder.state.writeStatus = 500;
    const res = await addOne(ADA, 1, 'doc-a');
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.details.outcome, 'none');
    assert.deepEqual(res.body.details.not, ['doc-a']);
    ifinder.state.writeStatus = 422;
    const rejected = await addOne(ADA, 1, 'doc-b');
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.body.details.code, 'IFINDER_REJECTED');
    assert.deepEqual(documentsOf(1), []);
  });

  it('counts a write whose answer was lost as done when it was applied', async () => {
    h.collection(1, ADA.email);
    ifinder.state.dropAnswer = true;
    const res = await addOne(ADA, 1, 'doc-a');
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(documentsOf(1), ['doc-a']);
    ifinder.state.dropAnswer = true;
    const removed = await remove(ADA, 1, 'doc-a');
    assert.equal(removed.statusCode, 204);
    assert.deepEqual(documentsOf(1), []);
  });

  it('says which documents were removed when iFinder fails after some', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a', 'doc-b'] });
    ifinder.state.failAfter = 1;
    const { default: unused } = { default: null };
    void unused;
    const items = ['doc-a', 'doc-b'].map(id => itemIdOf(ID(1), id));
    const { removeDocuments } =
      await import('../services/projects/ifinder/IFinderCollectionWriter.js');
    await assert.rejects(
      () => removeDocuments(ADA, pid(1), items),
      error =>
        error.code === 'IFINDER_WRITE_FAILED' &&
        error.details.outcome === 'partial' &&
        error.details.removed.join() === 'doc-a' &&
        error.details.not.join() === 'doc-b'
    );
    assert.deepEqual(documentsOf(1), ['doc-b']);
  });

  it('says it is unknown when iFinder cannot be asked afterwards either', async () => {
    h.collection(1, ADA.email);
    // The write fails, and so does the read that follows it.
    ifinder.state.writeStatus = 500;
    const original = smartCollections.get.bind(smartCollections);
    smartCollections.get = async () => {
      throw new Error('down');
    };
    try {
      const res = await addOne(ADA, 1, 'doc-a');
      assert.equal(res.statusCode, 503, 'the first read under the lock already fails');
    } finally {
      smartCollections.get = original;
    }
  });
});

describe('a caller that aborts does not fail the others', () => {
  it('does not pass a caller signal into the shared collection request', async () => {
    h.collection(1, ADA.email, { documents: ['doc-a'] });
    doc('doc-a');
    const { loadCollectionProject, listCollectionProjects, availabilityFor } =
      await import('../services/projects/ifinder/IFinderTier.js');
    ifinder.state.delays.set(ID(1), 60);
    const aborted = AbortSignal.abort();
    const [one, two] = await Promise.all([
      loadCollectionProject(ADA, pid(1), { signal: aborted }),
      loadCollectionProject(ADA, pid(1))
    ]);
    assert.equal(one.status, 'ok');
    assert.equal(two.status, 'ok');
    assert.equal(ifinder.calls('collections').filter(r => r.path.endsWith(ID(1))).length, 1);
    // The tier is not marked unavailable by an abort.
    assert.equal((await availabilityFor(ADA)).offered, true);
    assert.equal((await listCollectionProjects(ADA)).warnings.length, 0);
  });
});
