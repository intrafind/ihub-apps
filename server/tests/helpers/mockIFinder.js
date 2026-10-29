// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A fake iFinder for the tests of the iFinder tier of projects: the Smart
 * Collections v1 public API and the two retrieval calls iHub makes for a
 * document (search by id, read by id), over plain HTTP or HTTPS.
 *
 * It behaves like the real thing where the tier depends on it:
 *
 *  - the principal is the `sub` of the bearer JWT (decoded, not verified), and
 *    the Smart Collections calls need the `fi_smartcollections` scope;
 *  - the list matches the owner **case-sensitively**, a single collection
 *    **case-insensitively** (the verified iFinder behavior);
 *  - a collection of someone else answers 404;
 *  - a search or a read only sees the documents the principal may see.
 *
 * Every request is recorded in `requests`, so a test can say what was asked,
 * with which principal and scope, and that nothing was asked at all.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import jwt from 'jsonwebtoken';

const COLLECTIONS = '/public-api/smart-collections/api/v1/smart-collections';
const RETRIEVAL = '/public-api/retrieval/api/v1/search-profiles/';

/** A self-signed certificate for `127.0.0.1` and `localhost`, or null without openssl. */
export function selfSignedCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-mock-ifinder-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=mock-ifinder',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1'
      ],
      { stdio: 'ignore' }
    );
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem')),
      cert: fs.readFileSync(path.join(dir, 'cert.pem'))
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A PEM private key iHub can sign the iFinder JWT with. */
export async function generatePrivateKeyPem() {
  const { generateKeyPairSync } = await import('node:crypto');
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  }).privateKey;
}

/** A collection document as iFinder stores it. */
export function collectionDocument({
  id,
  owner,
  name = 'Collection',
  description = '',
  documents = [],
  modified = '2026-10-20T10:00:00Z'
}) {
  return {
    id,
    name,
    description,
    owner,
    creation_date: '2026-10-01T10:00:00Z',
    modification_date: modified,
    documents: documents.map(documentId => ({ id: documentId }))
  };
}

/**
 * @param {Object} [options]
 * @param {{key: Buffer, cert: Buffer}} [options.tls] - Serve HTTPS with this certificate.
 */
export async function startMockIFinder({ tls } = {}) {
  const state = {
    /** collection id → stored collection document */
    collections: new Map(),
    /** document id → {title, content, hiddenFrom: Set<sub>} */
    documents: new Map(),
    /** Answer every Smart Collections call with this status. */
    collectionsStatus: null,
    /** Never answer a Smart Collections call. */
    hang: false,
    requests: []
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const visibleTo = (documentId, sub) => {
    const document = state.documents.get(documentId);
    return document && !document.hiddenFrom?.has(sub) ? document : null;
  };

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const claims = token ? jwt.decode(token) || {} : {};
    const sub = claims.sub;
    const entry = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      sub,
      scope: claims.scope
    };
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      if (raw) {
        try {
          entry.body = JSON.parse(raw);
        } catch {
          entry.body = raw;
        }
      }
      state.requests.push(entry);
      if (!sub) return send(res, 401);

      if (url.pathname.startsWith(COLLECTIONS)) {
        if (state.hang) return; // never answered
        if (state.collectionsStatus) return send(res, state.collectionsStatus);
        if (
          !String(claims.scope || '')
            .split(' ')
            .includes('fi_smartcollections')
        ) {
          return send(res, 403);
        }
        const rest = url.pathname.slice(COLLECTIONS.length);
        if (!rest) {
          const from = Number(url.searchParams.get('from') || 0);
          const size = Number(url.searchParams.get('size') ?? 10);
          // The list matches the owner exactly (`owner.keyword`).
          const owned = [...state.collections.values()]
            .filter(collection => collection.owner === sub)
            .sort((a, b) => String(b.modification_date).localeCompare(String(a.modification_date)));
          return send(res, 200, { collections: owned.slice(from, from + size) });
        }
        const collection = state.collections.get(rest.slice(1));
        // A single collection is checked ignoring case; someone else's is a 404.
        if (!collection || collection.owner.toLowerCase() !== String(sub).toLowerCase()) {
          return send(res, 404);
        }
        return send(res, 200, collection);
      }

      if (url.pathname.startsWith(RETRIEVAL)) {
        const rest = url.pathname.slice(RETRIEVAL.length).split('/');
        if (rest[1] === '_search' && req.method === 'POST') {
          const query = String(entry.body?.query?.query || '');
          const ids = [...query.matchAll(/_id:"([^"]+)"/g)].map(match => match[1]);
          entry.ids = ids;
          const size = Number(url.searchParams.get('size') ?? 10);
          const hits = ids
            .map(id => ({ id, document: visibleTo(id, sub) }))
            .filter(hit => hit.document)
            .slice(0, size)
            .map(hit => ({
              document: { id: [hit.id], title: [hit.document.title] },
              metadata: { score: 1 }
            }));
          return send(res, 200, { results: hits, metadata: { total_hits: hits.length, took: 1 } });
        }
        if (rest[1] === 'docs' && req.method === 'GET') {
          const document = visibleTo(decodeURIComponent(rest[2]), sub);
          if (!document) return send(res, 404);
          return send(res, 200, {
            document: { id: rest[2], title: document.title, content: document.content },
            metadata: { took: 1 }
          });
        }
      }
      return send(res, 404);
    });
  };

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    state,
    requests: state.requests,
    /** Requests of one kind: `collections`, `search` or `docs`. */
    calls(kind) {
      return state.requests.filter(request =>
        kind === 'collections'
          ? request.path.startsWith(COLLECTIONS)
          : kind === 'search'
            ? request.path.endsWith('/_search')
            : request.path.includes('/docs/')
      );
    },
    reset() {
      state.requests.length = 0;
      state.collectionsStatus = null;
      state.hang = false;
    },
    addCollection(collection) {
      state.collections.set(collection.id, collection);
    },
    addDocument(id, { title, content = '', hiddenFrom = [] }) {
      state.documents.set(id, { title, content, hiddenFrom: new Set(hiddenFrom) });
    },
    close() {
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(resolve));
    }
  };
}
