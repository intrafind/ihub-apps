// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The icon file a definition ships (`"icon": "icon.svg"`):
 *
 * - the registry reports and reads it only for a plain `.svg` file name
 *   that exists in the definition's folder (no folders, no `..`, no other type);
 * - the listing names `GET /api/integrations/:id/icon` for it, with the base path;
 * - the route answers it as an image (`nosniff`, a CSP that allows nothing) for
 *   an installation the user may use, and 404 for anyone else.
 *
 * Run: node --test server/tests/integrations/integrationIcon.test.js
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import configCache from '../../configCache.js';
import integrationRegistry, {
  IntegrationRegistry
} from '../../services/integrations/definitions/IntegrationRegistry.js';
import userIntegrationRoutes from '../../routes/integrations/userIntegrations.js';
import { iconOf } from '../../services/integrations/userIntegrations.js';
import errorHandler from '../../middleware/errorHandler.js';

const installed = [
  {
    id: 'ifinder',
    definition: 'com.intrafind/ifinder',
    definitionVersion: '1.0.0',
    enabled: true,
    values: { baseUrl: 'https://ifinder.example.com' },
    auth: { mode: 'none' }
  },
  {
    id: 'jira',
    definition: 'com.intrafind/jira',
    definitionVersion: '1.0.0',
    enabled: true,
    values: { clientId: 'c', clientSecretRef: 's' },
    auth: { mode: 'oauth-user' }
  }
];

const USERS = {
  member: { id: 'member', groups: ['users'], permissions: { integrations: new Set(['ifinder']) } },
  outsider: { id: 'outsider', groups: ['users'], permissions: { integrations: new Set() } }
};

const saved = {};
before(async () => {
  saved.getIntegrations = configCache.getIntegrations;
  saved.get = configCache.get;
  saved.getPlatform = configCache.getPlatform;
  saved.getFeatures = configCache.getFeatures;
  configCache.getIntegrations = () => ({ data: { installed } });
  configCache.get = key =>
    key === 'config/integrations.json' ? { data: { installed } } : saved.get.call(configCache, key);
  configCache.getPlatform = () => ({ anonymousAuth: { enabled: false } });
  configCache.getFeatures = () => ({ integrations: true });
  await integrationRegistry.ensureLoaded();
});
after(() => {
  configCache.getIntegrations = saved.getIntegrations;
  configCache.get = saved.get;
  configCache.getPlatform = saved.getPlatform;
  configCache.getFeatures = saved.getFeatures;
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = USERS[req.headers['x-test-user']] || { id: 'anonymous', groups: ['anonymous'] };
  next();
});
app.use('/api/integrations', userIntegrationRoutes);
app.use(errorHandler);

describe('the icon file of a shipped definition', () => {
  it('is known for iFinder and not for Jira (which ships none)', () => {
    assert.equal(integrationRegistry.iconFile('com.intrafind/ifinder'), 'icon.svg');
    assert.equal(integrationRegistry.iconFile('com.intrafind/jira'), null);
    assert.equal(integrationRegistry.iconFile('com.example/unknown'), null);
  });

  it('is read as an SVG', async () => {
    const icon = await integrationRegistry.readIcon('com.intrafind/ifinder');
    assert.equal(icon.contentType, 'image/svg+xml');
    assert.match(icon.data.toString('utf8'), /<svg/);
    assert.equal(await integrationRegistry.readIcon('com.intrafind/jira'), null);
  });
});

describe('what the registry accepts as an icon name', () => {
  let root;
  let registry;
  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'integration-icon-'));
    const shipped = path.join(root, 'shipped');
    await fs.mkdir(shipped);
    const base = JSON.parse(
      await fs.readFile(
        path.join(integrationRegistry.entries.get('com.intrafind/jira').dir, 'integration.json'),
        'utf8'
      )
    );
    const make = async (id, icon, files = {}) => {
      const dir = path.join(shipped, id.replace('/', '__'));
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, 'integration.json'),
        JSON.stringify({ ...base, id, icon, releases: undefined })
      );
      for (const [name, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await fs.writeFile(path.join(dir, name), content);
      }
    };
    await make('com.example/svg', 'logo.svg', { 'logo.svg': '<svg/>' });
    await make('com.example/png', 'logo.png', { 'logo.png': 'x' });
    await make('com.example/missing', 'logo.svg');
    await make('com.example/html', 'logo.html', { 'logo.html': '<script>1</script>' });
    await make('com.example/folder', 'img/logo.svg', { 'img/logo.svg': '<svg/>' });
    await make('com.example/big', 'big.svg', { 'big.svg': 'x'.repeat(200 * 1024) });
    registry = new IntegrationRegistry({ shippedDir: shipped, contentsDir: path.join(root, 'c') });
    await registry.reload();
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('takes a plain svg file that exists and is small', async () => {
    assert.equal(registry.iconFile('com.example/svg'), 'logo.svg');
    assert.equal((await registry.readIcon('com.example/svg')).contentType, 'image/svg+xml');
  });

  it('refuses a missing file, another type (PNG too: marketplace installs fetch text), a folder path and a large file', async () => {
    for (const id of ['missing', 'html', 'png', 'folder', 'big']) {
      assert.equal(registry.iconFile(`com.example/${id}`), null, id);
      assert.equal(await registry.readIcon(`com.example/${id}`), null, id);
    }
  });
});

describe('the listing and the route', () => {
  it('names the icon route in the listing and keeps an http(s) URL as it is', () => {
    const definition = integrationRegistry.get('com.intrafind/ifinder');
    assert.match(iconOf(definition, 'ifinder'), /\/api\/integrations\/ifinder\/icon$/);
    assert.equal(
      iconOf({ id: 'x', icon: 'https://cdn.example.com/a.svg' }, 'x'),
      'https://cdn.example.com/a.svg'
    );
    assert.equal(iconOf(integrationRegistry.get('com.intrafind/jira'), 'jira'), null);
  });

  it('serves the image to a user who may use the installation', async () => {
    const res = await request(app)
      .get('/api/integrations/ifinder/icon')
      .set('x-test-user', 'member');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.match(res.headers['content-security-policy'], /sandbox/);
  });

  it('stops at the feature gate: no lookup when integrations are switched off', async () => {
    const before = configCache.getFeatures;
    configCache.getFeatures = () => ({ integrations: false });
    try {
      for (const url of ['/api/integrations/ifinder/icon', '/api/integrations/ifinder']) {
        const res = await request(app).get(url).set('x-test-user', 'member');
        assert.notEqual(res.status, 200, url);
        assert.equal(res.body?.code, 'FEATURE_DISABLED', url);
      }
    } finally {
      configCache.getFeatures = before;
    }
  });

  it('answers 404 to a user whose groups do not allow it, and for an installation without an icon', async () => {
    const denied = await request(app)
      .get('/api/integrations/ifinder/icon')
      .set('x-test-user', 'outsider');
    assert.equal(denied.status, 404);
    const none = await request(app).get('/api/integrations/jira/icon').set('x-test-user', 'member');
    assert.equal(none.status, 404);
  });
});
