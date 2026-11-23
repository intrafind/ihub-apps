// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/admin/apps/{appId}/_dependants` lists what names an app, so the
 * delete dialog can say what loses its reference (AI-B12): prompts that open
 * in it, apps that call it as a tool or inherit from it, workflows that call
 * it, and groups that list it by id (a `*` grant is no reference).
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

let apps = [];
let prompts = [];
let workflows = [];
let groupsConfig = null;
const clone = value => JSON.parse(JSON.stringify(value));

jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: clone(apps), etag: 'a' }),
    getPrompts: () => ({ data: clone(prompts), etag: 'p' }),
    getWorkflows: () => ({ data: clone(workflows), etag: 'w' }),
    refreshAppsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async rel => (rel === 'config/groups.json' ? clone(groupsConfig) : null)
  }
}));

jest.unstable_mockModule('../utils/installationCleanup.js', () => ({
  removeMarketplaceInstallation: async () => {}
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminAppsRoutes } = await import('../routes/admin/apps.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const server = express();
server.use(express.json());
registerAdminAppsRoutes(server);
server.use(errorHandler);

describe('GET /api/admin/apps/{appId}/_dependants', () => {
  beforeEach(() => {
    apps = [
      { id: 'translator', name: { en: 'Translator' } },
      { id: 'assistant', name: { en: 'Assistant' }, apps: ['translator', 'summary'] },
      { id: 'translator-de', name: { en: 'Translator DE' }, parentId: 'translator' },
      { id: 'unrelated', name: { en: 'Unrelated' } }
    ];
    prompts = [
      { id: 'translate-mail', name: { en: 'Translate a mail' }, appId: 'translator' },
      { id: 'free', name: { en: 'Free prompt' } }
    ];
    workflows = [
      {
        id: 'flow',
        name: { en: 'Flow' },
        nodes: [{ id: 'n1', type: 'agent', config: { apps: ['translator'] } }]
      },
      { id: 'other-flow', name: { en: 'Other' }, nodes: [{ id: 'n1', config: {} }] }
    ];
    groupsConfig = {
      groups: {
        users: { id: 'users', name: 'Users', permissions: { apps: ['*'] } },
        legal: { id: 'legal', name: 'Legal', permissions: { apps: ['translator'] } }
      }
    };
  });

  test('lists prompts, apps, workflows and groups that name the app', async () => {
    const res = await request(server).get('/api/admin/apps/translator/_dependants');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      prompts: [{ id: 'translate-mail', name: { en: 'Translate a mail' } }],
      apps: [
        { id: 'assistant', name: { en: 'Assistant' }, references: ['tool'] },
        { id: 'translator-de', name: { en: 'Translator DE' }, references: ['parent'] }
      ],
      workflows: [{ id: 'flow', name: { en: 'Flow' } }],
      groups: [{ id: 'legal', name: 'Legal' }]
    });
  });

  test('answers empty lists for an app nothing names', async () => {
    const res = await request(server).get('/api/admin/apps/unrelated/_dependants');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prompts: [], apps: [], workflows: [], groups: [] });
  });

  test('works without a groups file', async () => {
    groupsConfig = null;
    const res = await request(server).get('/api/admin/apps/translator/_dependants');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  test('answers 404 as problem+json for an unknown app', async () => {
    const res = await request(server).get('/api/admin/apps/ghost/_dependants');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('refuses an invalid id with 400', async () => {
    const res = await request(server).get('/api/admin/apps/bad%20id!/_dependants');
    expect(res.status).toBe(400);
  });
});
