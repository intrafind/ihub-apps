// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin queue of internal websites for the Website Corpus, over a real
 * filesystem storage provider:
 *
 *   GET    /api/admin/website-corpus/domains
 *   POST   /api/admin/website-corpus/domains
 *   POST   /api/admin/website-corpus/domains/:id/_approve | _decline
 *   DELETE /api/admin/website-corpus/domains/:id
 *
 * - only admins may read or change it;
 * - a request a user made shows up, an approval takes effect for the crawl, and
 *   withdrawing it takes the host away again;
 * - an admin may add a host directly, with a wildcard; a user may not;
 * - failures are answered as problem+json with registry codes, and every change is audited.
 *
 * Run: node --test server/tests/website-corpus-domains-routes.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestStorage } from './helpers/testStorage.js';

// The audit log lands in a contents directory of its own; config reads it on import.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'website-corpus-domains-'));
process.env.CONTENTS_DIR = path.join(tmpDir, 'contents');

const { default: configCache } = await import('../configCache.js');
const { default: registerRoutes } = await import('../routes/admin/websiteCorpusDomains.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { getDomainStore, MAX_NOTE_CHARS } = await import('../services/websiteCorpus/DomainStore.js');
const { flushAuditLog, queryAuditLog } = await import('../services/AuditLogService.js');

const USERS = {
  admin: { id: 'admin', name: 'Admin', isAdmin: true, groups: ['admins'] },
  alice: { id: 'alice', name: 'Alice', groups: ['users'] }
};

const BASE = '/api/admin/website-corpus/domains';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = USERS[req.headers['x-test-user']] || { id: 'anonymous', groups: ['anonymous'] };
  next();
});
registerRoutes(app);
app.use(errorHandler);

const as = (user, method, url) => {
  const r = request(app)[method](url);
  return user ? r.set('x-test-user', user) : r;
};

let storage;
const savedGroups = configCache.getGroups;
before(async () => {
  storage = await startTestStorage({ prefix: 'website-corpus-domains-' });
  configCache.getGroups = () => ({
    data: {
      groups: {
        admins: { id: 'admins', permissions: { adminAccess: true } },
        users: { id: 'users', permissions: {} },
        anonymous: { id: 'anonymous', permissions: {} }
      }
    }
  });
});
after(async () => {
  configCache.getGroups = savedGroups;
  await storage.stop();
  await flushAuditLog();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('admin queue of internal websites', () => {
  it('is for admins only', async () => {
    for (const user of [undefined, 'alice']) {
      for (const [method, url] of [
        ['get', BASE],
        ['post', BASE],
        ['post', `${BASE}/wd_00000000000000000000000000000000/_approve`],
        ['delete', `${BASE}/wd_00000000000000000000000000000000`]
      ]) {
        const res = await as(user, method, url).send({ host: 'wiki.corp' });
        assert.ok([401, 403].includes(res.status), `${user} ${method} ${url} -> ${res.status}`);
      }
    }
    assert.equal((await getDomainStore().list()).items.length, 0, 'nothing was changed');
  });

  it('shows a request, approves it, and withdraws the approval again', async () => {
    const store = getDomainStore();
    await store.request({ host: 'https://Wiki.corp/page', user: USERS.alice, reason: 'Size it' });

    const list = await as('admin', 'get', BASE);
    assert.equal(list.status, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(list.body.openCount, 1);
    assert.equal(list.body.nextCursor, null);
    const [entry] = list.body.items;
    assert.equal(entry.host, 'wiki.corp');
    assert.equal(entry.status, 'requested');
    assert.equal(entry.requesters[0].reason, 'Size it');

    const approved = await as('admin', 'post', `${BASE}/${entry.id}/_approve`).send({
      note: 'Fine'
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.decidedBy.id, 'admin');
    assert.equal(approved.body.note, 'Fine');
    assert.deepEqual(await store.approvedHosts(Date.now() + 1e9), ['wiki.corp']);
    assert.equal((await as('admin', 'get', BASE)).body.openCount, 0);

    const declined = await as('admin', 'post', `${BASE}/${entry.id}/_decline`).send({});
    assert.equal(declined.body.status, 'declined');
    assert.deepEqual(await store.approvedHosts(Date.now() + 2e9), []);

    assert.equal((await as('admin', 'delete', `${BASE}/${entry.id}`)).status, 204);
    assert.equal((await as('admin', 'get', BASE)).body.items.length, 0);
    assert.equal((await as('admin', 'delete', `${BASE}/${entry.id}`)).status, 404);
  });

  it('lets an admin add a host directly, wildcards included, and answers 201 with a Location', async () => {
    const created = await as('admin', 'post', BASE).send({
      host: '*.dept.corp',
      note: 'whole department'
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.host, '*.dept.corp');
    assert.equal(created.body.status, 'approved');
    assert.equal(created.body.source, 'admin');
    assert.equal(created.headers.location, `${BASE}/${created.body.id}`);
    const hosts = await getDomainStore().approvedHosts(Date.now() + 3e9);
    assert.ok(hosts.includes('*.dept.corp'));
  });

  it('answers a bad request as problem+json with a registry code', async () => {
    const cases = [
      [{ host: '' }, 400],
      [{ host: 5 }, 400],
      [{}, 400],
      [{ host: '*.com' }, 400],
      [{ host: 'a.corp', note: 'x'.repeat(MAX_NOTE_CHARS + 1) }, 400],
      [{ host: 'a.corp', note: 5 }, 400]
    ];
    for (const [body, status] of cases) {
      const res = await as('admin', 'post', BASE).send(body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.match(res.headers['content-type'], /application\/problem\+json/);
      assert.equal(res.body.code, 'VALIDATION_FAILED');
      assert.equal(typeof res.body.detail, 'string');
    }
    for (const id of ['nope', '../x', 'wd_00000000000000000000000000000000']) {
      const res = await as('admin', 'post', `${BASE}/${encodeURIComponent(id)}/_approve`).send({});
      assert.equal(res.status, 404, id);
      assert.equal(res.body.code, 'NOT_FOUND');
    }
  });

  it('writes a valid audit entry for every change', async () => {
    await flushAuditLog();
    const { entries } = await queryAuditLog({ resource: 'websiteCorpusDomain', limit: 50 });
    const verbs = new Set(
      entries.map(entry => `${entry.action}: ${/^(\w+)/.exec(entry.summary)?.[1]}`)
    );
    // Actions from the audit log's own list, with the verb in the summary.
    for (const expected of [
      'create: Allowed',
      'requestDecision: Approved',
      'requestDecision: Declined',
      'delete: Removed'
    ]) {
      assert.ok(verbs.has(expected), `${expected} was audited: ${[...verbs]}`);
    }
    assert.ok(entries.every(entry => /Website Corpus/.test(entry.summary)));
  });
});
