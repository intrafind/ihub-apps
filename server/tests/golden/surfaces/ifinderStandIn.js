// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A stand-in for an iFinder: a real HTTP server on the loopback interface that
 * answers the three requests iHub makes for a law consultation from a result
 * set under `tests/fixtures/stellungnahmen/ifinder/`:
 *
 * - `GET /internal-api/v2/search?action=getconfiguration`: the search profiles
 *   of the user, as the searchbar of iFinder gets them;
 * - `POST /public-api/retrieval/api/v1/search-profiles/{profile}/_search`: the
 *   hits of a query, paged with `size` and `from`;
 * - `GET /public-api/retrieval/api/v1/search-profiles/{profile}/docs/{id}`: a
 *   document with its content.
 *
 * Nothing of iHub is replaced: `iFinderService` builds its requests, signs its
 * token and sends them through `httpFetch` as it does to a real installation.
 * The stand-in writes down every request it got, with the claims of the token
 * and whether the token was signed with the key of the installation, so a
 * golden holds what iHub asked iFinder.
 *
 * The result set is synthetic. No iFinder installation was asked for it.
 *
 * @module tests/golden/surfaces/ifinderStandIn
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from '../byCodeUnit.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The result set of the law consultation, relative to the repository root. */
export const RESULT_SET_PATH = 'tests/fixtures/stellungnahmen/ifinder/result-set.json';

/** @returns {Object} The result set as the fixture file holds it. */
export function readResultSet() {
  return JSON.parse(fs.readFileSync(path.resolve(here, '../../../..', RESULT_SET_PATH), 'utf8'));
}

/** The text of a document: written out, or one paragraph repeated for a very long one. */
export function contentOf(document) {
  if (typeof document.content === 'string') return document.content;
  return (
    (document.contentHead ?? '') +
    String(document.contentParagraph ?? '').repeat(document.contentParagraphs ?? 0)
  );
}

/** A document as a hit of the search holds it: every field is a list. */
function hitOf(document) {
  const fields = {
    id: [document.id],
    sourceName: [document.sourceName],
    sourceType: [document.sourceType],
    mediaType: [document.mediaType],
    language: [document.language],
    modificationDate: [document.modificationDate],
    'file.name': [document.file.name],
    'file.size': [document.file.size],
    url: [document.url],
    'sourceLocations.label': document.labels
  };
  // A scan has no title in the index.
  if (document.title) fields.title = [document.title];
  return { document: fields, metadata: { score: document.score, teasers: [] } };
}

/** The claims of a bearer token and whether `publicKey` verifies its signature. */
function readBearer(header, publicKey) {
  const token = /^Bearer (.+)$/.exec(String(header ?? ''))?.[1];
  if (!token) return null;
  const [head, body, signature] = token.split('.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { unreadable: true };
  }
  // JSON, but no set of claims (`null`, a number, a list).
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { unreadable: true };
  // When it was issued and when it ends say nothing about what was asked.
  const { iat: _iat, exp: _exp, ...kept } = claims;
  const signedWithInstallationKey = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${head}.${body}`),
    publicKey,
    Buffer.from(signature ?? '', 'base64url')
  );
  return { claims: kept, expires: typeof claims.exp === 'number', signedWithInstallationKey };
}

/**
 * A long list of names as a record holds it: how many, and a short hash over the names in one
 * order. Another field in the place of one leaves the number and changes the hash; the order in
 * which they were asked for changes neither, because it does not matter to iFinder.
 *
 * @param {string[]} names
 * @returns {{count: number, names: string}}
 */
export function recordedNames(names) {
  const sorted = [...names].sort(byCodeUnit);
  return {
    count: names.length,
    names: crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 12)
  };
}

/**
 * The parameters of a request that say what was asked; the long field lists by their length and
 * a hash of their names ({@link recordedNames}). Which fields iHub asks for is the list in
 * `iFinderService.js`.
 */
function recordedQuery(searchParams) {
  const out = {};
  for (const name of new Set(searchParams.keys())) {
    const values = searchParams.getAll(name);
    if (name === 'return_fields' || name === 'return_facets') out[name] = recordedNames(values);
    else out[name] = values.length === 1 ? values[0] : values;
  }
  return out;
}

const SEARCH = /^\/public-api\/retrieval\/api\/v1\/search-profiles\/([^/]+)\/_search$/;
const DOCUMENT = /^\/public-api\/retrieval\/api\/v1\/search-profiles\/([^/]+)\/docs\/([^/]+)$/;
const CONFIGURATION = '/internal-api/v2/search';

/**
 * What the stand-in answers to one request.
 *
 * @param {Object} resultSet - {@link readResultSet}
 * @param {{method: string, pathname: string, searchParams: URLSearchParams, body: Object|null}} request
 * @returns {{status: number, body: Object}}
 */
export function answer(resultSet, { method, pathname, searchParams, body }) {
  const byId = new Map(resultSet.documents.map(document => [document.id, document]));
  if (method === 'GET' && pathname === CONFIGURATION) {
    if (searchParams.get('action') !== 'getconfiguration') {
      return { status: 400, body: { error: 'unknown action' } };
    }
    return {
      status: 200,
      body: {
        results: [
          {
            sources: resultSet.profiles.map(profile => ({
              value: Buffer.from(profile.id, 'utf8').toString('base64'),
              name: profile.name,
              default: profile.default === true
            }))
          }
        ]
      }
    };
  }
  const search = SEARCH.exec(pathname);
  if (method === 'POST' && search) {
    if (decodeURIComponent(search[1]) !== resultSet.searchProfile) {
      return { status: 404, body: { error: 'unknown search profile' } };
    }
    // Only a query the result set names: `constructor` is a key of every object, and no query.
    const query = body?.query?.query;
    const ids =
      typeof query === 'string' && Object.hasOwn(resultSet.queries, query)
        ? resultSet.queries[query]
        : [];
    const from = Number(searchParams.get('from') ?? 0);
    const size = Number(searchParams.get('size') ?? 10);
    return {
      status: 200,
      body: {
        metadata: { total_hits: ids.length, took: 4 },
        results: ids.slice(from, from + size).map(id => hitOf(byId.get(id))),
        facets: null
      }
    };
  }
  const found = DOCUMENT.exec(pathname);
  if (method === 'GET' && found) {
    const document = byId.get(decodeURIComponent(found[2]));
    if (!document || document.contentStatus === 404) {
      return { status: 404, body: { error: 'document not found' } };
    }
    return {
      status: 200,
      body: {
        metadata: { took: 2 },
        document: {
          id: document.id,
          title: document.title,
          content: contentOf(document),
          language: document.language,
          mimeType: document.mediaType,
          filename: document.file.name,
          size: document.file.size,
          url: document.url
        }
      }
    };
  }
  return { status: 404, body: { error: 'no such endpoint' } };
}

/**
 * Start the stand-in on a free port of the loopback interface.
 *
 * @param {Object} options
 * @param {Object} [options.resultSet] - Default: the result set of the law consultation.
 * @param {crypto.KeyObject|string} options.publicKey - The public half of the key the installation
 *   signs its tokens with.
 * @returns {Promise<{baseUrl: string, requests: Object[], close: () => Promise<void>}>}
 */
export async function startIFinderStandIn({ resultSet = readResultSet(), publicKey }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { unreadable: text.slice(0, 200) };
      }
      const request = {
        method: req.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        body
      };
      const response = answer(resultSet, request);
      requests.push({
        method: request.method,
        path: decodeURIComponent(url.pathname),
        query: recordedQuery(url.searchParams),
        ...(body ? { body } : {}),
        bearer: readBearer(req.headers.authorization, publicKey),
        answered: {
          status: response.status,
          ...(Array.isArray(response.body.results) && response.body.metadata
            ? { hits: response.body.results.length, totalHits: response.body.metadata.total_hits }
            : {}),
          ...(response.body.document
            ? { contentLength: response.body.document.content.length }
            : {})
        }
      });
      const payload = JSON.stringify(response.body);
      res.writeHead(response.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      });
      res.end(payload);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
