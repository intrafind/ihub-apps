// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The stand-in for iFinder and the result set it answers from. Later tests
 * build on both, so what the stand-in answers is pinned here, apart from the
 * golden that uses it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { byCodeUnit } from '../byCodeUnit.js';
import {
  answer,
  contentOf,
  readResultSet,
  recordedNames,
  startIFinderStandIn
} from './ifinderStandIn.js';

const SEARCH = '/public-api/retrieval/api/v1/search-profiles/searchprofile-standard/_search';
const DOCS = '/public-api/retrieval/api/v1/search-profiles/searchprofile-standard/docs';

const ask = (resultSet, method, pathname, { query = {}, body = null } = {}) =>
  answer(resultSet, { method, pathname, searchParams: new URLSearchParams(query), body });

const searchFor = (resultSet, text, query = {}) =>
  ask(resultSet, 'POST', SEARCH, { query, body: { query: { query: text } } });

test('the result set is whole: every hit of a query is a document, and every document is found', () => {
  const resultSet = readResultSet();
  const ids = new Set(resultSet.documents.map(document => document.id));
  assert.equal(ids.size, resultSet.documents.length, 'two documents share an id');
  for (const [query, hits] of Object.entries(resultSet.queries)) {
    for (const id of hits)
      assert.ok(ids.has(id), `query "${query}" names the unknown document ${id}`);
  }
  assert.deepEqual([...resultSet.queries['*']].sort(byCodeUnit), [...ids].sort(byCodeUnit));
  // What the golden of the law consultation is about: a long document, one without text, one
  // that cannot be loaded.
  const lengths = resultSet.documents.map(document => contentOf(document).length);
  assert.ok(Math.max(...lengths) > 50_000, 'no document is longer than the workflow reads');
  assert.ok(resultSet.documents.some(document => document.content === ''));
  assert.ok(resultSet.documents.some(document => document.contentStatus === 404));
  assert.ok(resultSet.profiles.some(profile => profile.id === resultSet.searchProfile));
});

test('a search answers with the hits of the query as iFinder writes them, in pages', () => {
  const resultSet = readResultSet();
  const all = searchFor(resultSet, '*', { size: '100' });
  assert.equal(all.status, 200);
  assert.equal(all.body.metadata.total_hits, 6);
  assert.equal(all.body.results.length, 6);
  // Every field of a hit is a list.
  const first = all.body.results[0];
  assert.deepEqual(first.document.id, ['bmg-st-0001']);
  assert.deepEqual(first.document['file.name'], ['verband-der-musterkassen.pdf']);
  assert.deepEqual(first.document['sourceLocations.label'], ['bmg', 'Public']);
  assert.equal(typeof first.metadata.score, 'number');
  // The scan has no title in the index.
  assert.equal('title' in all.body.results[4].document, false);

  const page = searchFor(resultSet, '*', { size: '4', from: '4' });
  assert.equal(page.body.metadata.total_hits, 6);
  assert.deepEqual(
    page.body.results.map(hit => hit.document.id[0]),
    ['bmg-st-0005', 'bmg-st-0006']
  );
  // A query the result set does not know finds nothing; it is not an error.
  const none = searchFor(resultSet, 'Kurzarbeit');
  assert.deepEqual([none.status, none.body.metadata.total_hits, none.body.results], [200, 0, []]);
  // Nor does a word that every object has as a key, or a query that is no text.
  for (const text of ['constructor', 'toString', '__proto__', undefined, 7]) {
    const inherited = searchFor(resultSet, text);
    assert.deepEqual(
      [inherited.status, inherited.body.metadata.total_hits, inherited.body.results],
      [200, 0, []],
      String(text)
    );
  }
});

test('a list of field names is recorded by its length and a hash that does not depend on the order', () => {
  const asked = recordedNames(['id', 'title', 'file.name']);
  assert.equal(asked.count, 3);
  assert.match(asked.names, /^[0-9a-f]{12}$/);
  assert.deepEqual(recordedNames(['file.name', 'id', 'title']), asked);
  // Another field in the place of one: the same number, another hash.
  const substituted = recordedNames(['id', 'title', 'file.size']);
  assert.equal(substituted.count, 3);
  assert.notEqual(substituted.names, asked.names);
});

test('a document answers with its content; one that is gone and an unknown one with 404', () => {
  const resultSet = readResultSet();
  const loaded = ask(resultSet, 'GET', `${DOCS}/bmg-st-0002`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.document.id, 'bmg-st-0002');
  assert.match(loaded.body.document.content, /^Musterkammer Nord/);
  const long = ask(resultSet, 'GET', `${DOCS}/bmg-st-0003`);
  assert.ok(long.body.document.content.length > 50_000);
  assert.match(long.body.document.content, /^Arbeitsgemeinschaft Musterverbände/);
  assert.equal(ask(resultSet, 'GET', `${DOCS}/bmg-st-0005`).body.document.content, '');
  assert.equal(ask(resultSet, 'GET', `${DOCS}/bmg-st-0006`).status, 404);
  assert.equal(ask(resultSet, 'GET', `${DOCS}/no-such-document`).status, 404);
});

test('the search profiles are answered as the searchbar gets them; anything else is refused', () => {
  const resultSet = readResultSet();
  const profiles = ask(resultSet, 'GET', '/internal-api/v2/search', {
    query: { action: 'getconfiguration', 'searchprofile.applications': 'ifinder' }
  });
  assert.equal(profiles.status, 200);
  assert.deepEqual(profiles.body.results[0].sources, [
    {
      value: Buffer.from('searchprofile-standard').toString('base64'),
      name: 'Standard',
      default: true
    },
    {
      value: Buffer.from('searchprofile-archiv').toString('base64'),
      name: 'Archiv',
      default: false
    }
  ]);
  assert.equal(ask(resultSet, 'GET', '/internal-api/v2/search').status, 400);
  // Another search profile than the one of the result set, and a path iFinder does not have.
  const other = SEARCH.replace('searchprofile-standard', 'searchprofile-other');
  assert.equal(ask(resultSet, 'POST', other, { body: { query: { query: '*' } } }).status, 404);
  assert.equal(ask(resultSet, 'GET', '/public-api/v0/assistants').status, 404);
});

/** A token as iHub signs one: RS256 over header and claims. */
function signedToken(privateKey, claims) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}`;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signed), privateKey)
    .toString('base64url');
  return `${signed}.${signature}`;
}

function send(baseUrl, { method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      new URL(path, baseUrl),
      {
        method,
        headers: { ...headers, ...(payload ? { 'content-type': 'application/json' } : {}) }
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (text += chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch (error) {
            reject(new Error(`${method} ${path}: the answer is not JSON (${error.message})`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

test('over HTTP the stand-in writes down each request, the claims of its token and whose key signed it', async t => {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const standIn = await startIFinderStandIn({ publicKey: keys.publicKey });
  t.after(() => standIn.close());
  assert.match(standIn.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const claims = { sub: 'person@example.invalid', scope: 'fa_index_read', iat: 1, exp: 2 };
  const found = await send(standIn.baseUrl, {
    method: 'POST',
    path: `${SEARCH}?size=2&return_fields=id&return_fields=title&query_logging=enable`,
    headers: { authorization: `Bearer ${signedToken(keys.privateKey, claims)}` },
    body: { query: { query: 'Härtefallregelung', query_type: 'QueryStringQuery' } }
  });
  assert.equal(found.status, 200);
  assert.equal(found.body.results.length, 2);
  await send(standIn.baseUrl, {
    method: 'GET',
    path: `${DOCS}/bmg-st-0006`,
    headers: { authorization: `Bearer ${signedToken(stranger.privateKey, claims)}` }
  });
  await send(standIn.baseUrl, { method: 'GET', path: `${DOCS}/bmg-st-0001` });
  // A token whose middle part is JSON but no set of claims is answered like any other request.
  const noClaims = `x.${Buffer.from('null').toString('base64url')}.y`;
  const answered = await send(standIn.baseUrl, {
    method: 'GET',
    path: `${DOCS}/bmg-st-0001`,
    headers: { authorization: `Bearer ${noClaims}` }
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(standIn.requests.pop().bearer, { unreadable: true });

  assert.deepEqual(standIn.requests, [
    {
      method: 'POST',
      path: SEARCH,
      query: {
        size: '2',
        return_fields: recordedNames(['id', 'title']),
        query_logging: 'enable'
      },
      body: { query: { query: 'Härtefallregelung', query_type: 'QueryStringQuery' } },
      // When the token was issued and when it ends is not written down.
      bearer: {
        claims: { sub: 'person@example.invalid', scope: 'fa_index_read' },
        expires: true,
        signedWithInstallationKey: true
      },
      answered: { status: 200, hits: 2, totalHits: 2 }
    },
    {
      method: 'GET',
      path: `${DOCS}/bmg-st-0006`,
      query: {},
      bearer: {
        claims: { sub: 'person@example.invalid', scope: 'fa_index_read' },
        expires: true,
        signedWithInstallationKey: false
      },
      answered: { status: 404 }
    },
    {
      method: 'GET',
      path: `${DOCS}/bmg-st-0001`,
      query: {},
      bearer: null,
      answered: { status: 200, contentLength: 406 }
    }
  ]);
});
