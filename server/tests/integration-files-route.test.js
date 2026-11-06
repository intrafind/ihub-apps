// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/integrations/:integration/files` · `/files/:id` · `/files/:id/content[/:filename]`
 * (routes/integrations/files.js): documents by reference from an installed
 * integration that declares the `files` capability — only while the
 * installation exists, is configured and is granted to the user's groups —
 * and the same gate on `GET /api/sources/:provider/*` for a provider that is
 * an installation.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { registerConnector } from '../services/integrations/protocols/native/connectors/index.js';
import filesRoutes from '../routes/integrations/files.js';
import sourceRoutes from '../routes/sources.js';
import {
  _resetSourceProviders,
  registerSourceProvider,
  sourceProviderError
} from '../services/sources/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IFINDER_DEFINITION = JSON.parse(
  fs.readFileSync(
    path.join(
      here,
      '..',
      'defaults',
      'integration-definitions',
      'com.intrafind__ifinder',
      'integration.json'
    ),
    'utf8'
  )
);

const GRANTED = { id: 'ada', permissions: { integrations: new Set(['ifinder']) } };
const UNGRANTED = { id: 'bob', permissions: { integrations: new Set(['jira']) } };

function appFor(user) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/integrations', filesRoutes);
  // Mounted after the files router, as the scope and iFinder authorization routes are.
  app.get('/api/integrations/ifinder/authorization', (_req, res) => res.json({ sibling: true }));
  app.use('/api/sources', sourceRoutes);
  return app;
}

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const calls = [];
let installed;
let configured;

const fakeFiles = {
  configured: () => configured,
  async content({ ref, user, format }) {
    calls.push({ kind: 'content', ref, user: user.id, format });
    if (ref.id === 'gone') throw sourceProviderError(404, 'Document not found');
    if (ref.id === 'boom') throw new Error('upstream exploded');
    return {
      contentType: 'image/png',
      contentDisposition: 'attachment; filename="scan.png"',
      stream: Readable.from([IMAGE])
    };
  },
  async metadata({ ref, user }) {
    calls.push({ kind: 'metadata', ref, user: user.id });
    if (ref.id === 'denied') throw sourceProviderError(403, 'Access denied');
    return { title: `Doc ${ref.id}`, mediaType: 'image/png' };
  }
};

describe('integration files routes', () => {
  const originals = {};
  beforeEach(() => {
    calls.length = 0;
    configured = true;
    installed = [{ id: 'ifinder', definition: 'com.intrafind/ifinder', enabled: true, values: {} }];
    originals.getIntegrations = configCache.getIntegrations;
    originals.registryGet = integrationRegistry.get;
    originals.getFeatures = configCache.getFeatures;
    configCache.getIntegrations = () => ({ data: { installed }, etag: 'test' });
    integrationRegistry.get = id =>
      id === IFINDER_DEFINITION.id
        ? { definition: IFINDER_DEFINITION }
        : id === 'com.intrafind/jira'
          ? {
              definition: {
                id,
                capabilities: ['tools'],
                protocol: { type: 'native', module: 'jira' }
              }
            }
          : null;
    registerConnector({ id: 'ifinder', actions: {}, files: fakeFiles });
    _resetSourceProviders();
  });
  afterEach(() => {
    configCache.getIntegrations = originals.getIntegrations;
    integrationRegistry.get = originals.registryGet;
    configCache.getFeatures = originals.getFeatures;
  });

  it('the shipped iFinder definition declares the files capability', () => {
    assert.ok(IFINDER_DEFINITION.capabilities.includes('files'));
    assert.equal(IFINDER_DEFINITION.releases[0].version, IFINDER_DEFINITION.version);
  });

  describe('the gate', () => {
    it('probe: tells a granted user which integration answers', async () => {
      const res = await request(appFor(GRANTED)).get('/api/integrations/ifinder/files');
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 'ifinder');
      assert.equal(res.body.definition, 'com.intrafind/ifinder');
      assert.deepEqual(res.body.name, IFINDER_DEFINITION.name);
    });

    it('403 INTEGRATION_NOT_GRANTED for a user whose groups do not grant it', async () => {
      const res = await request(appFor(UNGRANTED)).get('/api/integrations/ifinder/files');
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'INTEGRATION_NOT_GRANTED');
    });

    it('404 INTEGRATION_NOT_FOUND when the integration is not installed', async () => {
      installed = [];
      const res = await request(appFor(GRANTED)).get('/api/integrations/ifinder/files');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'INTEGRATION_NOT_FOUND');
    });

    it('404 INTEGRATION_NOT_FOUND for an installation whose definition has no files capability', async () => {
      installed = [{ id: 'jira', definition: 'com.intrafind/jira', enabled: true }];
      const res = await request(
        appFor({ id: 'ada', permissions: { integrations: new Set(['*']) } })
      ).get('/api/integrations/jira/files');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'INTEGRATION_NOT_FOUND');
    });

    it('404 INTEGRATION_NOT_CONFIGURED when switched off or not configured', async () => {
      installed[0].enabled = false;
      let res = await request(appFor(GRANTED)).get('/api/integrations/ifinder/files');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'INTEGRATION_NOT_CONFIGURED');

      installed[0].enabled = true;
      configured = false;
      res = await request(appFor(GRANTED)).get('/api/integrations/ifinder/files/d1/content');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'INTEGRATION_NOT_CONFIGURED');
      assert.deepEqual(calls, [], 'the connector is not asked');
    });

    it('rejects an id that is not a plain id', async () => {
      const res = await request(appFor(GRANTED)).get('/api/integrations/..%2Fx/files');
      assert.ok([400, 404].includes(res.status));
      assert.deepEqual(calls, []);
    });
  });

  describe('the document: details, content, name', () => {
    const BASE = '/api/integrations/ifinder/files';

    it('content: streams the original with the connector headers, for the signed-in user', async () => {
      const res = await request(appFor(GRANTED))
        .get(`${BASE}/d1/content`)
        .query({ scope: 'sales' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.headers['content-disposition'], 'attachment; filename="scan.png"');
      assert.deepEqual(res.body, IMAGE);
      assert.deepEqual(calls, [
        { kind: 'content', ref: { id: 'd1', scope: 'sales' }, user: 'ada', format: 'original' }
      ]);
    });

    it('the id is a URL-encoded path segment: any character an id may carry arrives intact', async () => {
      const id = 'sp:site/Shared Documents/Q1 #2?.pdf';
      const content = await request(appFor(GRANTED)).get(
        `${BASE}/${encodeURIComponent(id)}/content`
      );
      assert.equal(content.status, 200);
      const details = await request(appFor(GRANTED)).get(`${BASE}/${encodeURIComponent(id)}`);
      assert.equal(details.status, 200);
      assert.deepEqual(
        calls.map(call => call.ref),
        [{ id }, { id }]
      );
    });

    it('content: the optional file name names the download when the connector sent none, and never changes what is served', async () => {
      registerConnector({
        id: 'ifinder',
        actions: {},
        files: {
          ...fakeFiles,
          content: async ({ ref }) => {
            calls.push({ kind: 'content', ref });
            return { contentType: 'application/pdf', body: Buffer.from('%PDF') };
          }
        }
      });
      const app = appFor(GRANTED);
      const plain = await request(app).get(`${BASE}/d1/content`);
      assert.equal(plain.headers['content-disposition'], undefined);

      const named = await request(app).get(
        `${BASE}/d1/content/${encodeURIComponent('Q1 Bericht.pdf')}`
      );
      assert.equal(named.status, 200);
      assert.equal(named.body.toString(), '%PDF');
      assert.match(named.headers['content-disposition'], /^attachment; filename="Q1 Bericht\.pdf"/);

      // Any name is a valid header, whatever characters it carries
      const unicode = await request(app).get(
        `${BASE}/d1/content/${encodeURIComponent('Prüfung 文档.pdf')}`
      );
      assert.equal(unicode.status, 200);
      assert.match(
        unicode.headers['content-disposition'],
        /filename\*=UTF-8''Pr%C3%BCfung%20%E6%96%87%E6%A1%A3\.pdf/
      );

      assert.deepEqual(
        calls.map(call => call.ref),
        [{ id: 'd1' }, { id: 'd1' }, { id: 'd1' }]
      );
    });

    it("content: a name in the path does not override the connector's own", async () => {
      const res = await request(appFor(GRANTED)).get(`${BASE}/d1/content/other.png`);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-disposition'], 'attachment; filename="scan.png"');
    });

    it('content: validates the format, the id and the name before the connector is asked', async () => {
      const app = appFor(GRANTED);
      assert.equal(
        (await request(app).get(`${BASE}/d1/content`).query({ format: 'zip' })).status,
        400
      );
      assert.equal((await request(app).get(`${BASE}/${'x'.repeat(1025)}/content`)).status, 400);
      assert.equal((await request(app).get(`${BASE}/a%00b/content`)).status, 400);
      assert.equal((await request(app).get(`${BASE}/d1/content/a%0Ab.pdf`)).status, 400);
      assert.equal((await request(app).get(`${BASE}/d1/content/${'n'.repeat(256)}`)).status, 400);
      assert.equal(
        (
          await request(app)
            .get(`${BASE}/d1`)
            .query({ scope: 's'.repeat(257) })
        ).status,
        400
      );
      assert.deepEqual(calls, []);
    });

    it("content: a connector's status is the answer's; a plain error is 500", async () => {
      const app = appFor(GRANTED);
      assert.equal((await request(app).get(`${BASE}/gone/content`)).status, 404);
      assert.equal((await request(app).get(`${BASE}/boom/content`)).status, 500);
    });

    it('details: returns the connector details at the document itself; a 403 stays a 403', async () => {
      const app = appFor(GRANTED);
      const ok = await request(app).get(`${BASE}/d1`).query({ scope: 'sales' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { title: 'Doc d1', mediaType: 'image/png' });
      assert.deepEqual(calls, [
        { kind: 'metadata', ref: { id: 'd1', scope: 'sales' }, user: 'ada' }
      ]);
      const denied = await request(app).get(`${BASE}/denied`);
      assert.equal(denied.status, 403);
    });

    it('details: 404 when the connector has no details route', async () => {
      registerConnector({ id: 'ifinder', actions: {}, files: { content: fakeFiles.content } });
      const res = await request(appFor(GRANTED)).get(`${BASE}/d1`);
      assert.equal(res.status, 404);
      // The client tells "no details route" from "no such document" by this text.
      assert.equal(res.body.error, 'This integration has no details');
    });

    it('a 5xx answers with a generic message, never the upstream text; a 4xx keeps its own', async () => {
      const app = appFor(GRANTED);
      const failed = await request(app).get(`${BASE}/boom/content`);
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error, 'Integration content failed');
      assert.doesNotMatch(JSON.stringify(failed.body), /upstream exploded/);

      registerConnector({
        id: 'ifinder',
        actions: {},
        files: {
          ...fakeFiles,
          content: async () => {
            throw sourceProviderError(
              502,
              'iFinder returned 502: <html>internal host ifinder-7</html>'
            );
          },
          metadata: async () => {
            throw sourceProviderError(503, 'upstream said: connection refused to 10.0.0.7');
          }
        }
      });
      const bad = await request(app).get(`${BASE}/x/content`);
      assert.equal(bad.status, 502);
      assert.equal(bad.body.error, 'Integration content failed');
      assert.doesNotMatch(JSON.stringify(bad.body), /ifinder-7/);

      const details = await request(app).get(`${BASE}/x`);
      assert.equal(details.status, 503);
      assert.equal(details.body.error, 'Integration metadata failed');
      assert.doesNotMatch(JSON.stringify(details.body), /10\.0\.0\.7/);

      // A 4xx keeps the connector's own words (the client shows or maps them)
      registerConnector({ id: 'ifinder', actions: {}, files: fakeFiles });
      const gone = await request(app).get(`${BASE}/gone/content`);
      assert.equal(gone.status, 404);
      assert.equal(gone.body.error, 'Document not found');
    });
  });

  describe('the integrations feature gate', () => {
    it('closes the file routes when the feature is off, but not the routes behind this router', async () => {
      configCache.getFeatures = () => ({ integrations: false });
      const app = appFor(GRANTED);
      const files = await request(app).get('/api/integrations/ifinder/files');
      assert.equal(files.status, 403);
      assert.equal(files.body.code, 'FEATURE_DISABLED');
      const sibling = await request(app).get('/api/integrations/ifinder/authorization');
      assert.equal(sibling.status, 200);
      assert.deepEqual(sibling.body, { sibling: true });
    });
  });

  describe('a provider that is not an installation', () => {
    it('is served under its own rules, without the integration gate (project documents)', async () => {
      registerSourceProvider({
        id: 'project',
        async content({ ref, user }) {
          calls.push({ kind: 'project', ref, user: user.id });
          return { contentType: 'text/plain', body: 'item text' };
        }
      });
      const app = appFor(UNGRANTED);
      const probe = await request(app).get('/api/integrations/project/files');
      assert.equal(probe.status, 200);
      assert.deepEqual(probe.body, {
        id: 'project',
        definition: null,
        type: null,
        name: 'project'
      });

      const res = await request(app)
        .get('/api/integrations/project/files/item-1/content')
        .query({ scope: 'p1' });
      assert.equal(res.status, 200);
      assert.equal(res.text, 'item text');
      assert.deepEqual(calls, [
        { kind: 'project', ref: { id: 'item-1', scope: 'p1' }, user: 'bob' }
      ]);
    });

    it('404 for an id that is neither', async () => {
      const res = await request(appFor(GRANTED)).get('/api/integrations/nothing/files');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'INTEGRATION_NOT_FOUND');
    });
  });

  describe('the sources route', () => {
    it('applies the gate to the ifinder provider: not granted, not installed', async () => {
      let res = await request(appFor(UNGRANTED))
        .get('/api/sources/ifinder/content')
        .query({ id: 'd1' });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'INTEGRATION_NOT_GRANTED');

      installed = [];
      res = await request(appFor(GRANTED)).get('/api/sources/ifinder/metadata').query({ id: 'd1' });
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'INTEGRATION_NOT_FOUND');
    });
  });
});
