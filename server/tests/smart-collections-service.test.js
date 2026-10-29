// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Smart Collections client (`SmartCollectionsService`) against a fake
 * iFinder: the v1 paths, the explicitly requested `fi_smartcollections` scope,
 * paging, what an error answer means (the capability call), and the SSL
 * whitelist — a self-signed iFinder is reachable only when its host is on
 * `ssl.domainWhitelist`.
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
