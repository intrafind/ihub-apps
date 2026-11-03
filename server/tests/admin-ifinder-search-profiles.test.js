// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/admin/integrations/ifinder/search-profiles`: the search profiles
 * the admin sees in iFinder, narrowed to the installation's allow-list, for
 * the iFinder panel of the app editor.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules` (native ESM + jest).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin', groups: ['admins'] };
    next();
  }
}));

const { default: configCache } = await import('../configCache.js');
const { default: iFinderSearchProfiles } =
  await import('../services/integrations/iFinderSearchProfiles.js');
const { default: registerRoutes } = await import('../routes/admin/iFinderAssistants.js');
const { stubInstallations } = await import('./helpers/installedIFinder.js');

const PROFILES = [
  { id: 'searchprofile-standard', name: 'Standard', isDefault: true },
  { id: 'contracts', name: 'Contracts', isDefault: false },
  { id: 'hr', name: 'HR', isDefault: false }
];

function makeApp() {
  const app = express();
  registerRoutes(app);
  return app;
}

describe('GET /api/admin/integrations/ifinder/search-profiles', () => {
  const originals = {};
  let platform;
  let calls;

  beforeEach(() => {
    calls = [];
    platform = {
      iFinder: {
        enabled: true,
        baseUrl: 'https://ifinder.example',
        defaultSearchProfile: 'searchprofile-standard'
      }
    };
    originals.getPlatform = configCache.getPlatform;
    configCache.getPlatform = () => platform;
    originals.restoreInstallations = stubInstallations(configCache, () => platform);
    originals.getUserSearchProfiles = iFinderSearchProfiles.getUserSearchProfiles;
    iFinderSearchProfiles.getUserSearchProfiles = async args => {
      calls.push(args);
      return PROFILES;
    };
  });

  afterEach(() => {
    configCache.getPlatform = originals.getPlatform;
    originals.restoreInstallations();
    iFinderSearchProfiles.getUserSearchProfiles = originals.getUserSearchProfiles;
  });

  it('answers 409 while iFinder is not configured', async () => {
    platform = {};
    const res = await request(makeApp()).get('/api/admin/integrations/ifinder/search-profiles');
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('lists the profiles of the admin with the installation settings', async () => {
    const res = await request(makeApp()).get('/api/admin/integrations/ifinder/search-profiles');
    expect(res.status).toBe(200);
    expect(res.body.profiles.map(profile => profile.id)).toEqual([
      'searchprofile-standard',
      'contracts',
      'hr'
    ]);
    expect(res.body.defaultSearchProfile).toBe('searchprofile-standard');
    expect(typeof res.body.allowUserSearchProfileChange).toBe('boolean');
    expect(calls[0].user.id).toBe('admin');
    expect(calls[0].baseUrl).toBe('https://ifinder.example');
  });

  it('narrows the list to the allow-list, always keeping the default', async () => {
    platform.iFinder.allowedSearchProfiles = ['contracts'];
    const res = await request(makeApp()).get('/api/admin/integrations/ifinder/search-profiles');
    expect(res.status).toBe(200);
    expect(res.body.profiles.map(profile => profile.id)).toEqual([
      'searchprofile-standard',
      'contracts'
    ]);
  });

  it('answers 502 when iFinder cannot be asked', async () => {
    iFinderSearchProfiles.getUserSearchProfiles = async () => {
      throw new Error('boom');
    };
    const res = await request(makeApp()).get('/api/admin/integrations/ifinder/search-profiles');
    expect(res.status).toBe(502);
  });
});
