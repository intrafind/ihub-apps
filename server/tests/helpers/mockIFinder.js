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
 *  - a search or a read only sees the documents the principal may see;
 *  - **writes** (create, PATCH, add and remove documents) are what the utilities
 *    service does: an **unversioned read-modify-write** (`rmwDelayMs` widens the
 *    window between the read and the write, so two overlapping writes to one
 *    collection really lose one of them), PATCH updates every non-null field it
 *    is sent (`owner`, `documents` and `viewers` included), add checks no
 *    document id, more than 200 documents answer 500, a create without an
 *    `owner` takes the caller's `sub`;
 *  - failures can be injected: a status for every write (`writeStatus`), a write
 *    that is applied for the first N documents and then fails (`failAfter`), and
 *    one that is applied but whose answer is lost (`dropAnswer`).
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
import { randomUUID } from 'node:crypto';
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
    /** collection id → milliseconds a read of that single collection takes to answer */
    delays: new Map(),
    /** Milliseconds between the read and the write of a collection write (the lost-update window). */
    rmwDelayMs: 0,
    /** Answer every write with this status, without applying it. */
    writeStatus: null,
    /** Apply the first N documents of the next add or remove, then answer 500. */
    failAfter: null,
    /** Apply the next write, then drop the connection without an answer. */
    dropAnswer: false,
    /** The list is a search: while set, it shows the snapshot until `refreshIndex()`. */
    listLag: false,
    listSnapshot: null,
    /** Called with the collection after a document write was applied, before it is answered. */
    afterWrite: null,
    /** Ids handed out by create, in order; random UUIDs when empty. */
    nextIds: [],
    requests: []
  };

  const MAX_DOCUMENTS = 200;
  const clone = value => JSON.parse(JSON.stringify(value));
  const pause = ms =>
    ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const visibleTo = (documentId, sub) => {
    const document = state.documents.get(documentId);
    return document && !document.hiddenFrom?.has(sub) ? document : null;
  };

  /** The write endpoints, as the webapp and the utilities service answer them. */
  const write = async (req, res, { rest, entry, sub }) => {
    if (state.writeStatus) return send(res, state.writeStatus);
    const body = entry.body;
    if (!rest) {
      if (req.method !== 'POST') return send(res, 405);
      if (typeof body?.name !== 'string' || !body.name) return send(res, 400);
      const id = state.nextIds.shift() || randomUUID();
      const now = new Date().toISOString();
      state.collections.set(id, {
        id,
        name: body.name,
        description: body.description ?? '',
        // The webapp fills the owner from the token when none is sent.
        owner: body.owner ?? sub,
        creation_date: now,
        modification_date: now,
        documents: []
      });
      if (state.dropAnswer) {
        state.dropAnswer = false;
        return res.destroy();
      }
      return send(res, 201, { id });
    }
    const [, id, tail] = rest.split('/');
    const collection = state.collections.get(id);
    // Every per-collection route checks the owner, ignoring case.
    if (!collection || collection.owner.toLowerCase() !== String(sub).toLowerCase()) {
      return send(res, 404);
    }
    if (req.method === 'DELETE' && !tail) {
      // The collection goes; its documents are only listed by it.
      state.collections.delete(id);
      return send(res, 204);
    }
    if (req.method === 'PATCH' && !tail) {
      // Every non-null field is written, the owner, the documents and the viewers too.
      for (const field of ['name', 'description', 'owner', 'documents', 'viewers']) {
        if (body?.[field] !== undefined && body[field] !== null) collection[field] = body[field];
      }
      collection.modification_date = new Date().toISOString();
      return send(res, 200, collection);
    }
    if (tail !== 'documents' || !['POST', 'DELETE'].includes(req.method) || !Array.isArray(body)) {
      return send(res, 405);
    }
    const ids = body.map(entryOf => entryOf?.id).filter(Boolean);
    // The read-modify-write of the utilities service: read the list, change it,
    // write all of it back. Nothing checks that it is still the list that was read.
    const read = [...(collection.documents || [])];
    await pause(state.rmwDelayMs);
    const apply = list => {
      let next;
      if (req.method === 'POST') {
        const have = new Set(list.map(document => document.id));
        next = [...list, ...ids.filter(docId => !have.has(docId)).map(docId => ({ id: docId }))];
      } else {
        next = list.filter(document => !ids.includes(document.id));
      }
      return next;
    };
    if (state.failAfter !== null) {
      const first = state.failAfter;
      state.failAfter = null;
      const kept = ids.slice(0, first);
      const half =
        req.method === 'POST'
          ? [
              ...read,
              ...kept.filter(docId => !read.some(d => d.id === docId)).map(docId => ({ id: docId }))
            ]
          : read.filter(document => !kept.includes(document.id));
      collection.documents = half;
      collection.modification_date = new Date().toISOString();
      return send(res, 500);
    }
    const next = apply(read);
    if (next.length > MAX_DOCUMENTS) {
      // An unhandled IllegalArgumentException in the real service.
      return send(res, 500);
    }
    collection.documents = next;
    collection.modification_date = new Date().toISOString();
    state.afterWrite?.(collection);
    if (state.dropAnswer) {
      state.dropAnswer = false;
      return res.destroy();
    }
    return req.method === 'POST' ? send(res, 201) : send(res, 204);
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
      scope: claims.scope,
      at: Date.now()
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
        if (req.method !== 'GET') return write(req, res, { rest, entry, sub });
        if (!rest) {
          const from = Number(url.searchParams.get('from') || 0);
          const size = Number(url.searchParams.get('size') ?? 10);
          // The list matches the owner exactly (`owner.keyword`).
          const source =
            state.listLag && state.listSnapshot ? state.listSnapshot : state.collections;
          const owned = [...source.values()]
            .filter(collection => collection.owner === sub)
            .sort((a, b) => String(b.modification_date).localeCompare(String(a.modification_date)));
          return send(res, 200, { collections: owned.slice(from, from + size) });
        }
        const collection = state.collections.get(rest.slice(1));
        // A single collection is checked ignoring case; someone else's is a 404.
        if (!collection || collection.owner.toLowerCase() !== String(sub).toLowerCase()) {
          return send(res, 404);
        }
        const delay = state.delays.get(collection.id) || 0;
        return delay
          ? setTimeout(() => send(res, 200, collection), delay)
          : send(res, 200, collection);
      }

      if (url.pathname.startsWith(RETRIEVAL)) {
        const rest = url.pathname.slice(RETRIEVAL.length).split('/');
        if (rest[1] === '_search' && req.method === 'POST') {
          const query = String(entry.body?.query?.query || '');
          // A free-text query (the document picker) matches titles and content; an
          // id query (`_id:"a" OR _id:"b"`) names the documents asked for.
          const ids = query.includes('_id:')
            ? [...query.matchAll(/_id:"([^"]+)"/g)].map(match => match[1])
            : [...state.documents.entries()]
                .filter(([, document]) =>
                  query
                    .toLowerCase()
                    .split(/\s+/)
                    .filter(Boolean)
                    .every(term =>
                      `${document.title} ${document.content}`.toLowerCase().includes(term)
                    )
                )
                .map(([id]) => id);
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
      state.delays.clear();
      state.rmwDelayMs = 0;
      state.writeStatus = null;
      state.failAfter = null;
      state.dropAnswer = false;
      state.afterWrite = null;
      state.listLag = false;
      state.listSnapshot = null;
      state.nextIds.length = 0;
    },
    /** Make the list show what is stored now (the index refresh). */
    refreshIndex() {
      state.listSnapshot = clone([...state.collections.entries()]).reduce(
        (map, [id, collection]) => map.set(id, collection),
        new Map()
      );
    },
    /** From now on the list shows a snapshot until `refreshIndex()`. */
    lagList() {
      state.listLag = true;
      this.refreshIndex();
    },
    /** The document ids a stored collection holds. */
    documentIdsOf(id) {
      return (state.collections.get(id)?.documents || []).map(document => document.id);
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
