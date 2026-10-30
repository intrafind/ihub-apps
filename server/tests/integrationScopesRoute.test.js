// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/integrations/scopes` and `GET /api/integrations/:id/scopes`
 * (#3050): the scopes the chat input offers, only for an app the user may use.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import iFinderService from '../services/integrations/iFinderService.js';
import iFinderSearchProfiles from '../services/integrations/iFinderSearchProfiles.js';
import scopeRoutes from '../routes/integrations/scopes.js';

const APPS = [
  {
    id: 'ifinder-search',
    tools: ['iFinder_search'],
    integrations: { ifinder: { scopePicker: 'hidden' } }
  },
  { id: 'plain-chat', tools: [] },
  { id: 'secret-app', tools: ['iFinder_search'] },
  { id: 'off-app', tools: ['iFinder_search'], enabled: false }
];

function appFor(user) {
  const app = express();
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/integrations', scopeRoutes);
  return app;
}

const USER = {
  id: 'user-1',
  permissions: {
    apps: new Set(['ifinder-search', 'plain-chat', 'off-app']),
    models: new Set(['*'])
  }
};

describe('integration scope routes', () => {
  const originals = {};
  beforeEach(() => {
    originals.getPlatform = configCache.getPlatform;
    originals.getApps = configCache.getApps;
    originals.getModels = configCache.getModels;
    originals.getUserSearchProfiles = iFinderSearchProfiles.getUserSearchProfiles;
    configCache.getPlatform = () => ({
      iFinder: { enabled: true, baseUrl: 'https://ifinder.example' }
    });
    configCache.getApps = () => ({ data: APPS });
    configCache.getModels = () => ({ data: [] });
    iFinderSearchProfiles.getUserSearchProfiles = async () => [
      { id: 'searchprofile-standard', name: 'Standard', isDefault: true },
      { id: 'contracts', name: 'Contracts', isDefault: false }
    ];
    iFinderService.resetConfig();
  });
  afterEach(() => {
    configCache.getPlatform = originals.getPlatform;
    configCache.getApps = originals.getApps;
    configCache.getModels = originals.getModels;
    iFinderSearchProfiles.getUserSearchProfiles = originals.getUserSearchProfiles;
    iFinderService.resetConfig();
  });

  it('lists the scopes of every integration the app uses', async () => {
    const res = await request(appFor(USER)).get('/api/integrations/scopes?appId=ifinder-search');
    assert.equal(res.status, 200);
    assert.equal(res.body.integrations.length, 1);
    const [ifinder] = res.body.integrations;
    assert.equal(ifinder.id, 'ifinder');
    assert.equal(ifinder.action, 'search');
    assert.equal(ifinder.scopePicker, 'hidden');
    assert.equal(ifinder.defaultScope, 'searchprofile-standard');
    assert.deepEqual(
      ifinder.scopes.map(scope => scope.name),
      ['Standard', 'Contracts']
    );
  });

  it('lists nothing for an app without integrations that offer scopes', async () => {
    const res = await request(appFor(USER)).get('/api/integrations/scopes?appId=plain-chat');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.integrations, []);
  });

  it('answers one integration', async () => {
    const res = await request(appFor(USER)).get(
      '/api/integrations/ifinder/scopes?appId=ifinder-search'
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'ifinder');
  });

  it('answers 404 for an integration the app does not use, or one that does not exist', async () => {
    const app = appFor(USER);
    assert.equal(
      (await request(app).get('/api/integrations/iassistant/scopes?appId=ifinder-search')).status,
      404
    );
    assert.equal(
      (await request(app).get('/api/integrations/unknown/scopes?appId=ifinder-search')).status,
      404
    );
  });

  it('answers 404 for an app the user may not use, a disabled app and an unknown app', async () => {
    const app = appFor(USER);
    for (const appId of ['secret-app', 'off-app', 'missing']) {
      const res = await request(app).get(`/api/integrations/scopes?appId=${appId}`);
      assert.equal(res.status, 404, appId);
    }
  });

  it('answers 400 for an invalid app or model id', async () => {
    const app = appFor(USER);
    assert.equal((await request(app).get('/api/integrations/scopes')).status, 400);
    assert.equal(
      (await request(app).get('/api/integrations/scopes?appId=../etc/passwd')).status,
      400
    );
    assert.equal(
      (await request(app).get('/api/integrations/scopes?appId=ifinder-search&modelId=%3Cscript%3E'))
        .status,
      400
    );
  });

  it('requires a signed-in user', async () => {
    const res = await request(appFor(null)).get('/api/integrations/scopes?appId=ifinder-search');
    assert.equal(res.status, 401);
  });

  it('falls back to the configured default when iFinder refuses the list', async () => {
    iFinderSearchProfiles.getUserSearchProfiles = async () => {
      const error = new Error('forbidden (403)');
      error.status = 403;
      throw error;
    };
    const res = await request(appFor(USER)).get('/api/integrations/scopes?appId=ifinder-search');
    assert.equal(res.status, 200);
    const [ifinder] = res.body.integrations;
    assert.equal(ifinder.hint, 'forbidden');
    assert.deepEqual(
      ifinder.scopes.map(scope => scope.id),
      ['searchprofile-standard']
    );
  });
});
