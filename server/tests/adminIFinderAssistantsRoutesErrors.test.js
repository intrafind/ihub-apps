// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder iAssistants and search-profiles admin routes answer errors
 * through the global error middleware: an unconfigured integration is a
 * CONFLICT (409), an iFinder that cannot be asked is an UPSTREAM_ERROR (502,
 * never a 500) and the cause is not leaked.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { configured: true, assistantsError: null, profilesError: null };
const CFG = {
  baseUrl: 'https://ifinder.example',
  defaultSearchProfile: 'searchprofile-standard'
};

const realIfinderConfig = await import('../services/integrations/ifinderConfig.js');

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin', groups: ['admins'] };
    next();
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
jest.unstable_mockModule('../services/integrations/ifinderConfig.js', () => ({
  ...realIfinderConfig,
  isIFinderConfigured: () => state.configured,
  getIFinderConfig: () => CFG
}));
jest.unstable_mockModule('../services/integrations/iAssistantService.js', () => ({
  default: { getConfig: () => ({ baseUrl: CFG.baseUrl }) }
}));
jest.unstable_mockModule('../services/integrations/iFinderAssistants.js', () => ({
  default: {
    listAssistants: async () => {
      if (state.assistantsError) throw state.assistantsError;
      return [];
    }
  }
}));
jest.unstable_mockModule('../services/integrations/iFinderSearchProfiles.js', () => ({
  default: {
    getUserSearchProfiles: async () => {
      if (state.profilesError) throw state.profilesError;
      return [];
    }
  }
}));

const { default: registerRoutes } = await import('../routes/admin/iFinderAssistants.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerRoutes(app);
app.use(errorHandler);

const PATHS = [
  '/api/admin/integrations/ifinder/assistants',
  '/api/admin/integrations/ifinder/search-profiles'
];

beforeEach(() => {
  state.configured = true;
  state.assistantsError = null;
  state.profilesError = null;
});

describe.each(PATHS)('GET %s: errors', path => {
  it('answers CONFLICT while iFinder is not configured', async () => {
    state.configured = false;
    const res = await request(app).get(path).expect(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.detail).toContain('not configured');
  });

  it('answers UPSTREAM_ERROR, not 500, when iFinder cannot be asked', async () => {
    const failure = new Error('connect ECONNREFUSED secret-host');
    state.assistantsError = failure;
    state.profilesError = failure;
    const res = await request(app).get(path);
    expect(res.status).toBe(502);
    expect(res.status).not.toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
  });
});

describe('GET assistants: success', () => {
  it('answers the list when iFinder answers', async () => {
    const res = await request(app).get(PATHS[0]).expect(200);
    expect(res.body).toEqual({ assistants: [] });
  });
});
