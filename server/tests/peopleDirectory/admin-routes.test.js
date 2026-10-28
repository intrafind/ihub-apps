// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directory search (#3026): the admin API, with the real `adminAuth`.
 *
 * A non-admin, a personal API key, an OAuth client, an agent and the anonymous
 * principal each get a 403 before any entry is parsed or any connection is
 * opened — checked with a listener that would see the connection. An admin
 * gets validation, id clash detection and the certificate store.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { generateCertificates, hasOpenssl } from './fakeLdapServer.js';

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-dir-admin-'));
process.env.CONTENTS_DIR = contentsDir;

const { default: configCache } = await import('../../configCache.js');
const { default: registerAdminPeopleDirectoriesRoutes } =
  await import('../../routes/admin/peopleDirectories.js');

const FILE = path.join(contentsDir, 'config', 'peopleDirectories.json');
const state = { directories: [] };
const readFile = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null);

configCache.getPeopleDirectories = () => ({ data: { directories: state.directories } });
configCache.refreshCacheEntry = async key => {
  if (key === 'config/peopleDirectories.json') state.directories = readFile()?.directories || [];
};
configCache.getGroups = () => ({
  data: { groups: { admins: { permissions: { adminAccess: true } }, users: {} } }
});
configCache.getPlatform = () => ({
  ldapAuth: {
    providers: [
      {
        name: 'corp-ad',
        displayName: 'Corporate AD',
        url: 'ldaps://dc.corp.example',
        adminDn: 'cn=svc',
        adminPasswordRef: 'x'
      }
    ]
  }
});
configCache.getApps = () => ({ data: [{ id: 'people-directory', enabled: false }] });
configCache.getTools = () => ({ data: [{ id: 'evidence_collect' }] });
configCache.getMcpServers = () => ({ data: { servers: [{ id: 'drawio' }] } });
configCache.getA2aAgents = () => ({ data: { agents: [] } });

const PRINCIPALS = {
  admin: { id: 'admin', groups: ['admins'] },
  user: { id: 'user', groups: ['users'] },
  personalKey: { id: 'admin', groups: ['admins'], authMode: 'oauth_personal_key' },
  oauthClient: {
    id: 'client_1',
    groups: ['admins'],
    isOAuthClient: true,
    authMode: 'oauth_client_credentials'
  },
  agent: { id: 'agent_1', groups: ['admins'], isAgent: true },
  anonymous: { id: 'anonymous', groups: ['admins'] }
};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const principal = PRINCIPALS[req.headers['x-principal']];
  if (principal) req.user = structuredClone(principal);
  next();
});
registerAdminPeopleDirectoriesRoutes(app);

const as = (principal, call) => call.set('x-principal', principal);

describe('people directory admin API', () => {
  let listener;
  let connections = 0;
  let inlineEntry;

  before(async () => {
    listener = net.createServer(socket => {
      connections++;
      socket.destroy();
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    inlineEntry = {
      id: 'probe',
      url: `ldaps://127.0.0.1:${listener.address().port}`,
      baseDn: 'o=x',
      bind: { mode: 'anonymous' },
      allowedHosts: ['127.0.0.1'],
      timeoutMs: 1000
    };
  });

  after(async () => {
    await new Promise(resolve => listener.close(resolve));
    fs.rmSync(contentsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.directories = [];
  });

  for (const principal of ['user', 'personalKey', 'oauthClient', 'agent', 'anonymous', null]) {
    it(`refuses ${principal || 'an unauthenticated caller'} on every route before any connection`, async () => {
      const before = connections;
      const calls = [
        request(app).get('/api/admin/people-directories'),
        request(app)
          .put('/api/admin/people-directories')
          .send({ directories: [inlineEntry] }),
        request(app).get('/api/admin/people-directories/presets'),
        request(app)
          .post('/api/admin/people-directories/test')
          .send({ directory: inlineEntry, query: 'x' }),
        request(app).get('/api/admin/people-directories/certificates'),
        request(app)
          .post('/api/admin/people-directories/certificates/preview')
          .send({ content: 'x' }),
        request(app)
          .post('/api/admin/people-directories/certificates')
          .send({ name: 'x', content: 'x' }),
        request(app).delete('/api/admin/people-directories/certificates/x')
      ];
      for (const call of calls) {
        const response = await (principal ? as(principal, call) : call);
        assert.equal(response.status, 403, `${call.method} ${call.url}`);
      }
      assert.equal(connections, before);
      assert.equal(readFile(), null);
    });
  }

  it('lets an admin test an inline entry (which does open the connection)', async () => {
    const before = connections;
    const response = await as(
      'admin',
      request(app).post('/api/admin/people-directories/test').send({ directory: inlineEntry })
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.success, false);
    assert.ok(response.body.steps.some(step => step.id === 'network' && step.status === 'ok'));
    assert.ok(connections > before);
  });

  it('lists directories with summaries, sign-in providers and the app status', async () => {
    state.directories = [
      {
        id: 'x500bund',
        enabled: false,
        url: 'ldaps://x500.bund.de:636',
        baseDn: 'o=Bund,c=DE',
        preset: 'ivbb',
        dataFlow: 'external'
      },
      { id: 'legacy', url: 'ldap://old.example', baseDn: 'o=x', allowPlaintext: true }
    ];
    const response = await as('admin', request(app).get('/api/admin/people-directories'));
    assert.equal(response.status, 200);
    assert.equal(response.body.effective.x500bund.transport, 'ldaps');
    assert.equal(response.body.effective.x500bund.external, true);
    assert.equal(response.body.effective.x500bund.source, 'x500.bund.de');
    assert.equal(response.body.effective.legacy.transport, 'plaintext');
    assert.deepEqual(response.body.ldapProviders, [
      {
        name: 'corp-ad',
        displayName: 'Corporate AD',
        url: 'ldaps://dc.corp.example',
        host: 'dc.corp.example',
        baseDn: null,
        preset: null,
        starttls: false,
        hasBindAccount: true
      }
    ]);
    assert.deepEqual(response.body.peopleSearchApp, {
      id: 'people-directory',
      exists: true,
      enabled: false
    });
  });

  it('validates the whole file before saving', async () => {
    const bad = await as(
      'admin',
      request(app)
        .put('/api/admin/people-directories')
        .send({
          directories: [
            {
              id: 'corp',
              url: 'ldaps://a.example',
              baseDn: 'o=a',
              tlsOptions: { rejectUnauthorized: false }
            }
          ]
        })
    );
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.some(issue => issue.path.includes('tlsOptions')));

    const password = await as(
      'admin',
      request(app)
        .put('/api/admin/people-directories')
        .send({
          directories: [
            {
              id: 'corp',
              authProvider: 'corp-ad',
              bind: { mode: 'service', dn: 'cn=x', password: 'p' }
            }
          ]
        })
    );
    assert.equal(password.status, 400);
    assert.equal(readFile(), null);
  });

  it('refuses ids another tool reference already uses', async () => {
    for (const id of ['evidence', 'drawio']) {
      const response = await as(
        'admin',
        request(app)
          .put('/api/admin/people-directories')
          .send({ directories: [{ id, url: 'ldaps://a.example', baseDn: 'o=a' }] })
      );
      assert.equal(response.status, 409, id);
    }
  });

  it('saves a valid file', async () => {
    const response = await as(
      'admin',
      request(app)
        .put('/api/admin/people-directories')
        .send({ directories: [{ id: 'corp', authProvider: 'corp-ad', groups: ['users'] }] })
    );
    assert.equal(response.status, 200);
    assert.equal(readFile().directories[0].id, 'corp');
    assert.equal(state.directories[0].maxResults, 10);
  });

  it('serves the presets with their mappings', async () => {
    const response = await as('admin', request(app).get('/api/admin/people-directories/presets'));
    const ivbb = response.body.presets.find(preset => preset.id === 'ivbb');
    assert.deepEqual(ivbb.attributeMapping.jobTitle, ['role']);
    assert.deepEqual(ivbb.attributeMapping.academicTitle, ['title']);
    assert.equal(response.body.limits.maxResults, 50);
  });

  describe('certificates', { skip: !hasOpenssl() && 'openssl CLI not available' }, () => {
    it('previews, stores, lists and removes a certificate, refusing removal while it is used', async () => {
      const certs = generateCertificates('admin.test');
      const preview = await as(
        'admin',
        request(app)
          .post('/api/admin/people-directories/certificates/preview')
          .send({ content: certs.rootPem })
      );
      assert.equal(preview.status, 200);
      assert.equal(preview.body.certificate.subjectCN, 'Test Root CA');

      const key = await as(
        'admin',
        request(app)
          .post('/api/admin/people-directories/certificates')
          .send({ name: 'leak', content: certs.key })
      );
      assert.equal(key.status, 400);
      assert.match(key.body.error, /private key/);

      const created = await as(
        'admin',
        request(app)
          .post('/api/admin/people-directories/certificates')
          .send({ name: 'corp-root', content: certs.rootPem })
      );
      assert.equal(created.status, 201);
      const duplicate = await as(
        'admin',
        request(app)
          .post('/api/admin/people-directories/certificates')
          .send({ name: 'corp-root', content: certs.rootPem })
      );
      assert.equal(duplicate.status, 409);

      state.directories = [{ id: 'corp', authProvider: 'corp-ad', tlsCa: ['corp-root'] }];
      const listed = await as(
        'admin',
        request(app).get('/api/admin/people-directories/certificates')
      );
      assert.deepEqual(listed.body.certificates.find(c => c.name === 'corp-root').usedBy, ['corp']);

      const inUse = await as(
        'admin',
        request(app).delete('/api/admin/people-directories/certificates/corp-root')
      );
      assert.equal(inUse.status, 409);
      assert.deepEqual(inUse.body.usedBy, ['corp']);

      state.directories = [];
      const removed = await as(
        'admin',
        request(app).delete('/api/admin/people-directories/certificates/corp-root')
      );
      assert.equal(removed.status, 204);
      const missing = await as(
        'admin',
        request(app).delete('/api/admin/people-directories/certificates/corp-root')
      );
      assert.equal(missing.status, 404);
      const traversal = await as(
        'admin',
        request(app).delete('/api/admin/people-directories/certificates/..%2Fx')
      );
      assert.equal(traversal.status, 400);
    });
  });
});
