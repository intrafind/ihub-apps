// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Smart Collections client (`SmartCollectionsService`) against a fake
 * iFinder: the v1 paths, the explicitly requested `fi_smartcollections` scope,
 * paging, what an error answer means (the capability call), the write calls
 * (create, rename, add and remove documents: their bodies and what they never
 * send), and the SSL whitelist — a self-signed iFinder is reachable only when
 * its host is on `ssl.domainWhitelist`, for reads and writes alike.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionDocument,
  generatePrivateKeyPem,
  selfSignedCertificate,
  startMockIFinder
} from './helpers/mockIFinder.js';

// The iFinder JWT is signed with the key from the environment; it has to be
// there before `config.js` is first read.
process.env.IFINDER_PRIVATE_KEY = await generatePrivateKeyPem();

const { default: configCache } = await import('../configCache.js');
const { default: iFinderService } = await import('../services/integrations/iFinderService.js');
const {
  default: service,
  SMART_COLLECTIONS_ERRORS,
  MAX_COLLECTIONS
} = await import('../services/integrations/SmartCollectionsService.js');

const ADA = { id: 'u-ada', name: 'Ada', email: 'ada@example.com', groups: ['authenticated'] };
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let mock;

function configure(baseUrl, extra = {}) {
  configCache.setCacheEntry('config/platform.json', {
    iFinder: { baseUrl, jwtSubjectField: 'email' },
    proxy: { enabled: false },
    ...extra
  });
  iFinderService.resetConfig();
}

before(async () => {
  mock = await startMockIFinder();
});

after(() => mock.close());

beforeEach(() => {
  mock.state.collections.clear();
  mock.reset();
  configure(mock.url);
});

describe('list and get', () => {
  it('uses the v1 paths and asks for the fi_smartcollections scope', async () => {
    mock.addCollection(
      collectionDocument({ id: ID(1), owner: ADA.email, name: 'Contracts', documents: ['a', 'b'] })
    );
    const { collections, truncated } = await service.list({ user: ADA });
    assert.equal(truncated, false);
    assert.equal(collections.length, 1);
    const [request] = mock.calls('collections');
    assert.equal(request.path, '/public-api/smart-collections/api/v1/smart-collections');
    assert.equal(request.scope, 'fi_smartcollections');
    assert.equal(request.sub, ADA.email);
    assert.equal(request.query.sort, 'modification_date:desc');
    assert.equal(request.query.size, '100');
    // Not the stale v0 paths of the 6.8 documentation.
    assert.ok(mock.requests.every(entry => !entry.path.includes('/v0/')));
  });

  it('reduces a listed collection to counts: no document ids, no notes', async () => {
    mock.addCollection({
      ...collectionDocument({ id: ID(1), owner: ADA.email, documents: ['a', 'b', 'b'] }),
      documents: [{ id: 'a', notes: [{ text: 'secret note' }] }, { id: 'b' }, { id: 'b' }]
    });
    const { collections } = await service.list({ user: ADA });
    assert.equal(collections[0].documentCount, 2);
    assert.equal('documentIds' in collections[0], false);
    assert.equal(JSON.stringify(collections).includes('secret note'), false);
  });

  it('reads every page, and stops at the cap', async () => {
    for (let n = 1; n <= 150; n += 1) {
      mock.addCollection(
        collectionDocument({
          id: ID(n),
          owner: ADA.email,
          modified: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T10:00:00Z`
        })
      );
    }
    const all = await service.list({ user: ADA });
    assert.equal(all.collections.length, 150);
    assert.deepEqual(
      mock.calls('collections').map(request => [request.query.from, request.query.size]),
      [
        ['0', '100'],
        ['100', '100']
      ]
    );

    mock.reset();
    for (let n = 151; n <= MAX_COLLECTIONS + 50; n += 1) {
      mock.addCollection(collectionDocument({ id: ID(n), owner: ADA.email }));
    }
    const capped = await service.list({ user: ADA });
    assert.equal(capped.collections.length, MAX_COLLECTIONS);
    assert.equal(capped.truncated, true);
  });

  it('lists only the collections of the principal it signs for', async () => {
    mock.addCollection(collectionDocument({ id: ID(1), owner: ADA.email }));
    mock.addCollection(collectionDocument({ id: ID(2), owner: 'grace@example.com' }));
    const { collections } = await service.list({ user: ADA });
    assert.deepEqual(
      collections.map(collection => collection.id),
      [ID(1)]
    );
  });

  it('gets one collection with its document ids', async () => {
    mock.addCollection(collectionDocument({ id: ID(1), owner: ADA.email, documents: ['x', 'y'] }));
    const collection = await service.get({ user: ADA, id: ID(1) });
    assert.deepEqual(collection.documentIds, ['x', 'y']);
    assert.equal(collection.documentCount, 2);
    assert.equal(mock.calls('collections')[0].scope, 'fi_smartcollections');
  });

  it('answers NOT_FOUND for a missing collection, for someone elses and for an id that is none', async () => {
    mock.addCollection(collectionDocument({ id: ID(2), owner: 'grace@example.com' }));
    for (const id of [ID(1), ID(2)]) {
      await assert.rejects(
        service.get({ user: ADA, id }),
        error => error.code === SMART_COLLECTIONS_ERRORS.NOT_FOUND
      );
    }
    mock.reset();
    await assert.rejects(
      service.get({ user: ADA, id: '../../admin' }),
      error => error.code === SMART_COLLECTIONS_ERRORS.NOT_FOUND
    );
    assert.equal(mock.requests.length, 0, 'an id that is no UUID is never sent');
  });
});

describe('what iFinder answers, as the capability call reads it', () => {
  it('knows the API from a 200 and asks for no collection', async () => {
    await service.probe({ user: ADA });
    const [request] = mock.calls('collections');
    assert.equal(request.query.size, '0');
  });

  it('reads 404 and 501 as an iFinder without the API', async () => {
    for (const status of [404, 501]) {
      mock.state.collectionsStatus = status;
      await assert.rejects(
        service.probe({ user: ADA }),
        error => error.code === SMART_COLLECTIONS_ERRORS.UNSUPPORTED
      );
    }
  });

  it('reads a 204 without a body as no collections, not as a failure', async () => {
    // The webapp answers 204 when the utilities service sent no body.
    mock.state.collectionsStatus = 204;
    await service.probe({ user: ADA });
    assert.deepEqual(await service.list({ user: ADA }), { collections: [], truncated: false });
  });

  it('reads 403 as a missing role and 401 as a token iFinder refuses', async () => {
    mock.state.collectionsStatus = 403;
    await assert.rejects(
      service.probe({ user: ADA }),
      error => error.code === SMART_COLLECTIONS_ERRORS.FORBIDDEN
    );
    mock.state.collectionsStatus = 401;
    await assert.rejects(
      service.probe({ user: ADA }),
      error => error.code === SMART_COLLECTIONS_ERRORS.UNAUTHORIZED
    );
  });

  it('reads a 5xx and a silent server as unavailable', async () => {
    mock.state.collectionsStatus = 503;
    await assert.rejects(
      service.probe({ user: ADA }),
      error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE
    );
    mock.state.collectionsStatus = null;
    mock.state.hang = true;
    const started = Date.now();
    await assert.rejects(
      service.probe({ user: ADA, timeoutMs: 150 }),
      error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE
    );
    assert.ok(Date.now() - started < 3000, 'the timeout ends the call');
  });

  it('does not ask for a user it cannot sign a subject for', async () => {
    await assert.rejects(
      service.probe({ user: { id: 'u-local', name: 'No Email' } }),
      error => error.code === SMART_COLLECTIONS_ERRORS.UNAUTHORIZED
    );
    assert.equal(mock.requests.length, 0);
  });
});

describe('the write calls', () => {
  const sent = () => mock.requests.filter(entry => entry.method !== 'GET');

  it('creates a collection with a name and a description and sends no owner', async () => {
    mock.state.nextIds.push(ID(7));
    const created = await service.create({ user: ADA, name: 'Contracts', description: 'All' });
    assert.deepEqual(created, { id: ID(7) });
    const [request] = sent();
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/public-api/smart-collections/api/v1/smart-collections');
    assert.equal(request.scope, 'fi_smartcollections');
    assert.deepEqual(request.body, { name: 'Contracts', description: 'All' });
    assert.equal(mock.state.collections.get(ID(7)).owner, ADA.email, 'the token decides the owner');
  });

  it('refuses an answer without the id of a new collection', async () => {
    mock.state.nextIds.push('not-a-uuid');
    await assert.rejects(
      service.create({ user: ADA, name: 'x' }),
      error => error.code === SMART_COLLECTIONS_ERRORS.INVALID_RESPONSE
    );
  });

  it('renames with the fields it was given and nothing else', async () => {
    mock.addCollection(
      collectionDocument({ id: ID(1), owner: ADA.email, name: 'Old', documents: ['a', 'b'] })
    );
    await service.rename({ user: ADA, id: ID(1), name: 'New' });
    await service.rename({ user: ADA, id: ID(1), description: 'About' });
    await service.rename({ user: ADA, id: ID(1), name: 'Both', description: 'Too' });
    // Nothing to send is nothing sent.
    await service.rename({ user: ADA, id: ID(1) });
    const bodies = sent().map(entry => entry.body);
    assert.deepEqual(bodies, [
      { name: 'New' },
      { description: 'About' },
      { name: 'Both', description: 'Too' }
    ]);
    for (const request of sent()) {
      assert.equal(request.method, 'PATCH');
      assert.equal(request.path.endsWith(`/${ID(1)}`), true);
      for (const field of ['owner', 'documents', 'viewers']) {
        assert.equal(field in request.body, false, `${field} is never sent`);
      }
    }
    const stored = mock.state.collections.get(ID(1));
    assert.equal(stored.owner, ADA.email);
    assert.deepEqual(mock.documentIdsOf(ID(1)), ['a', 'b']);
  });

  it('adds and removes documents as an array of ids, the remove with a body', async () => {
    mock.addCollection(collectionDocument({ id: ID(1), owner: ADA.email, documents: ['a'] }));
    await service.addDocuments({ user: ADA, id: ID(1), documentIds: ['b', 'c'] });
    assert.deepEqual(mock.documentIdsOf(ID(1)), ['a', 'b', 'c']);
    await service.removeDocuments({ user: ADA, id: ID(1), documentIds: ['a', 'c'] });
    assert.deepEqual(mock.documentIdsOf(ID(1)), ['b']);
    const [add, remove] = sent();
    assert.equal(add.method, 'POST');
    assert.equal(add.path.endsWith(`/${ID(1)}/documents`), true);
    assert.deepEqual(add.body, [{ id: 'b' }, { id: 'c' }]);
    assert.equal(remove.method, 'DELETE');
    assert.equal(remove.path.endsWith(`/${ID(1)}/documents`), true);
    assert.deepEqual(remove.body, [{ id: 'a' }, { id: 'c' }]);
  });

  it('reads an id that is no uuid as a missing collection, without asking', async () => {
    await assert.rejects(
      service.addDocuments({ user: ADA, id: '../x', documentIds: ['a'] }),
      error => error.code === SMART_COLLECTIONS_ERRORS.NOT_FOUND
    );
    assert.equal(mock.requests.length, 0);
  });

  it('says what a refused write was: not found, forbidden, rejected, unavailable', async () => {
    mock.addCollection(collectionDocument({ id: ID(1), owner: 'grace@example.com' }));
    const code = promise =>
      promise.then(
        () => null,
        error => error.code
      );
    assert.equal(
      await code(service.addDocuments({ user: ADA, id: ID(1), documentIds: ['a'] })),
      SMART_COLLECTIONS_ERRORS.NOT_FOUND,
      'the collection of someone else'
    );
    for (const [status, expected] of [
      [403, SMART_COLLECTIONS_ERRORS.FORBIDDEN],
      [401, SMART_COLLECTIONS_ERRORS.UNAUTHORIZED],
      [400, SMART_COLLECTIONS_ERRORS.REJECTED],
      [409, SMART_COLLECTIONS_ERRORS.REJECTED],
      [422, SMART_COLLECTIONS_ERRORS.REJECTED],
      [500, SMART_COLLECTIONS_ERRORS.UNAVAILABLE],
      [502, SMART_COLLECTIONS_ERRORS.UNAVAILABLE]
    ]) {
      mock.state.writeStatus = status;
      assert.equal(
        await code(service.create({ user: ADA, name: 'x' })),
        expected,
        `a ${status} on create`
      );
    }
  });

  it('is unavailable, not rejected, when iFinder drops the answer', async () => {
    mock.state.dropAnswer = true;
    await assert.rejects(
      service.create({ user: ADA, name: 'x' }),
      error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE
    );
  });
});

describe(
  'the SSL whitelist',
  { skip: selfSignedCertificate() ? false : 'openssl is missing' },
  () => {
    let secure;
    const certificate = selfSignedCertificate();

    before(async () => {
      secure = await startMockIFinder({ tls: certificate });
    });

    after(() => secure?.close());

    beforeEach(() => {
      secure.state.collections.clear();
      secure.reset();
      secure.addCollection(collectionDocument({ id: ID(1), owner: ADA.email }));
    });

    const ssl = (domainWhitelist, ignoreInvalidCertificates = true) => ({
      ssl: { ignoreInvalidCertificates, domainWhitelist }
    });

    it('reaches a self-signed iFinder whose host is whitelisted', async () => {
      configure(secure.url.replace('127.0.0.1', 'localhost'), ssl(['localhost']));
      const { collections } = await service.list({ user: ADA });
      assert.equal(collections.length, 1);
      assert.equal(secure.calls('collections')[0].sub, ADA.email);
    });

    it('refuses the same certificate on a host that is not whitelisted', async () => {
      // `127.0.0.1` serves the same certificate; only `localhost` is on the list.
      configure(secure.url, ssl(['localhost']));
      await assert.rejects(
        service.list({ user: ADA }),
        error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE
      );
      assert.equal(secure.requests.length, 0, 'the TLS handshake failed, nothing was sent');
    });

    it('reaches a whitelisted host with a write, and refuses a host that is not', async () => {
      configure(secure.url.replace('127.0.0.1', 'localhost'), ssl(['localhost']));
      secure.state.nextIds.push(ID(8));
      assert.deepEqual(await service.create({ user: ADA, name: 'Over TLS' }), { id: ID(8) });
      await service.addDocuments({ user: ADA, id: ID(1), documentIds: ['a'] });
      await service.removeDocuments({ user: ADA, id: ID(1), documentIds: ['a'] });
      await service.rename({ user: ADA, id: ID(1), name: 'Renamed over TLS' });
      assert.equal(secure.requests.filter(entry => entry.method !== 'GET').length, 4);
      secure.requests.length = 0;
      configure(secure.url, ssl(['localhost']));
      for (const write of [
        () => service.create({ user: ADA, name: 'x' }),
        () => service.rename({ user: ADA, id: ID(1), name: 'x' }),
        () => service.addDocuments({ user: ADA, id: ID(1), documentIds: ['a'] }),
        () => service.removeDocuments({ user: ADA, id: ID(1), documentIds: ['a'] })
      ]) {
        await assert.rejects(write(), error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE);
      }
      assert.equal(
        secure.requests.length,
        0,
        'nothing was sent to the host that is not whitelisted'
      );
    });

    it('refuses it when the bypass is off, whitelisted or not', async () => {
      configure(secure.url.replace('127.0.0.1', 'localhost'), ssl(['localhost'], false));
      await assert.rejects(
        service.list({ user: ADA }),
        error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE
      );
      configure(secure.url.replace('127.0.0.1', 'localhost'), ssl([]));
      await assert.rejects(
        service.list({ user: ADA }),
        error => error.code === SMART_COLLECTIONS_ERRORS.UNAVAILABLE
      );
    });
  }
);
