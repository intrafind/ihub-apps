// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The skill routes answer errors through the global error middleware: an
 * unsafe name, an unknown skill, missing skill content, a missing resource
 * path and an unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { skills: [], content: null, resource: null, failList: false };

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = { id: 'u1', groups: ['users'], permissions: {} };
    next();
  }
}));
jest.unstable_mockModule('../featureRegistry.js', () => ({
  requireFeature: () => (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getSkillsForUser: async () => {
      if (state.failList) throw new Error('/secret/path/skills.json is unreadable');
      return { data: state.skills, etag: null };
    }
  }
}));
jest.unstable_mockModule('../services/skillLoader.js', () => ({
  getSkillContent: async () => state.content,
  getSkillResource: async () => state.resource
}));
jest.unstable_mockModule('../services/skillAccess.js', () => ({
  getUsablePersonalSkills: async () => []
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerSkillRoutes } = await import('../routes/skillRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerSkillRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.skills = [{ name: 'writer', displayName: 'Writer', description: 'd' }];
  state.content = { body: 'b', frontmatter: {}, references: [], scripts: [], assets: [] };
  state.resource = 'text';
  state.failList = false;
});

describe('skill routes: errors', () => {
  it('answers an unsafe name with BAD_REQUEST and an unknown skill with NOT_FOUND', async () => {
    const unsafe = await request(app).get('/api/skills/bad%20name').expect(400);
    expect(unsafe.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    for (const path of ['/api/skills/nobody', '/api/skills/nobody/content']) {
      const res = await request(app).get(path).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Skill not found' });
    }
  });

  it('answers missing content and a missing resource with NOT_FOUND', async () => {
    state.content = null;
    const content = await request(app).get('/api/skills/writer/content').expect(404);
    expect(content.body.detail).toBe('Skill content not found');
    state.resource = null;
    const resource = await request(app).get('/api/skills/writer/files/a.txt').expect(404);
    expect(resource.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Resource not found' });
  });

  it('still serves a known skill', async () => {
    const res = await request(app).get('/api/skills/writer').expect(200);
    expect(res.body.name).toBe('writer');
    await request(app).get('/api/skills/writer/files/a.txt').expect(200);
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.failList = true;
    const res = await request(app).get('/api/skills').expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/secret/path');
  });
});
