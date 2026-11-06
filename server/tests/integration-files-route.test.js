// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/integrations/:id/files` · `/files/content` · `/files/metadata`
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
      res = await request(appFor(GRANTED))
        .get('/api/integrations/ifinder/files/content')
        .query({ id: 'd1' });
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

  describe('content and metadata', () => {
    it('content: streams the original with the connector headers, for the signed-in user', async () => {
      const res = await request(appFor(GRANTED))
        .get('/api/integrations/ifinder/files/content')
        .query({ id: 'd1', scope: 'sales' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.headers['content-disposition'], 'attachment; filename="scan.png"');
      assert.deepEqual(res.body, IMAGE);
      assert.deepEqual(calls, [
        { kind: 'content', ref: { id: 'd1', scope: 'sales' }, user: 'ada', format: 'original' }
      ]);
    });

    it('content: validates format and id', async () => {
      const app = appFor(GRANTED);
      assert.equal(
        (
          await request(app)
            .get('/api/integrations/ifinder/files/content')
            .query({ id: 'd1', format: 'zip' })
        ).status,
        400
      );
      assert.equal((await request(app).get('/api/integrations/ifinder/files/content')).status, 400);
      assert.equal(
        (
          await request(app)
            .get('/api/integrations/ifinder/files/content')
            .query({ id: 'x'.repeat(1025) })
        ).status,
        400
      );
      assert.deepEqual(calls, []);
    });

    it("content: a connector's status is the answer's; a plain error is 500", async () => {
      const app = appFor(GRANTED);
      assert.equal(
        (await request(app).get('/api/integrations/ifinder/files/content').query({ id: 'gone' }))
          .status,
        404
      );
      assert.equal(
        (await request(app).get('/api/integrations/ifinder/files/content').query({ id: 'boom' }))
          .status,
        500
      );
    });

    it('metadata: returns the connector details; a 403 stays a 403', async () => {
      const app = appFor(GRANTED);
      const ok = await request(app)
        .get('/api/integrations/ifinder/files/metadata')
        .query({ id: 'd1' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { title: 'Doc d1', mediaType: 'image/png' });
      const denied = await request(app)
        .get('/api/integrations/ifinder/files/metadata')
        .query({ id: 'denied' });
      assert.equal(denied.status, 403);
    });

    it('metadata: 404 when the connector has no details route', async () => {
      registerConnector({ id: 'ifinder', actions: {}, files: { content: fakeFiles.content } });
      const res = await request(appFor(GRANTED))
        .get('/api/integrations/ifinder/files/metadata')
        .query({ id: 'd1' });
      assert.equal(res.status, 404);
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
        .get('/api/integrations/project/files/content')
        .query({ id: 'item-1', scope: 'p1' });
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
