// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The marketplace routes that let an admin review a skill's files before installing it:
 *
 *   - `GET …/items/skill/:name` carries `files` (SKILL.md first); when the list cannot be made
 *     the detail still loads with SKILL.md only;
 *   - `GET …/items/:type/:name/_file?path=` serves a text file of a `skill` (and the Markdown
 *     companion of an `integration`), as text the browser does not render; a path the catalog
 *     does not list is 404, another item type 400.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const registryService = {
  getItemDetail: jest.fn()
};
const contentInstaller = {
  fetchSkillFile: jest.fn(),
  fetchIntegrationCompanion: jest.fn(),
  listSkillFiles: jest.fn()
};

jest.unstable_mockModule('../services/marketplace/RegistryService.js', () => ({
  default: registryService
}));
jest.unstable_mockModule('../services/marketplace/ContentInstaller.js', () => ({
  default: {},
  fetchSkillFile: contentInstaller.fetchSkillFile,
  fetchIntegrationCompanion: contentInstaller.fetchIntegrationCompanion,
  listSkillFiles: contentInstaller.listSkillFiles
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: configCache } = await import('../configCache.js');
const { default: registerMarketplaceRoutes } = await import('../routes/admin/marketplace.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

configCache.getFeatures = () => ({ marketplace: true });

const app = express();
app.use(express.json());
registerMarketplaceRoutes(app);
app.use(errorHandler);

const BASE = '/api/admin/marketplace/registries/main/items';

beforeEach(() => {
  for (const fn of [...Object.values(registryService), ...Object.values(contentInstaller)]) {
    fn.mockReset();
  }
});

describe('the detail of a skill', () => {
  it('carries the files an install would write, SKILL.md first', async () => {
    registryService.getItemDetail.mockResolvedValue({ type: 'skill', name: 'audit' });
    contentInstaller.listSkillFiles.mockResolvedValue(['SKILL.md', 'references/a.md']);

    const res = await request(app).get(`${BASE}/skill/audit`).expect(200);

    expect(res.body.files).toEqual(['SKILL.md', 'references/a.md']);
    expect(contentInstaller.listSkillFiles).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({ name: 'audit' })
    );
  });

  it('still loads, with SKILL.md only, when the files cannot be listed', async () => {
    registryService.getItemDetail.mockResolvedValue({ type: 'skill', name: 'audit' });
    contentInstaller.listSkillFiles.mockRejectedValue(new Error('GitHub tree API: HTTP 403'));

    const res = await request(app).get(`${BASE}/skill/audit`).expect(200);

    expect(res.body).toMatchObject({ name: 'audit', files: ['SKILL.md'] });
  });

  it('does not list files for another type', async () => {
    registryService.getItemDetail.mockResolvedValue({ type: 'app', name: 'chat' });

    const res = await request(app).get(`${BASE}/app/chat`).expect(200);

    expect(res.body.files).toBeUndefined();
    expect(contentInstaller.listSkillFiles).not.toHaveBeenCalled();
  });
});

describe('GET …/items/:type/:name/_file', () => {
  it('serves a file of a skill as plain text the browser does not sniff', async () => {
    contentInstaller.fetchSkillFile.mockResolvedValue('print("hi")\n');

    const res = await request(app)
      .get(`${BASE}/skill/audit/_file`)
      .query({ path: 'scripts/run.py' })
      .expect(200);

    expect(contentInstaller.fetchSkillFile).toHaveBeenCalledWith('main', 'audit', 'scripts/run.py');
    expect(res.headers['content-type']).toMatch(/^text\/plain; charset=utf-8/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe('print("hi")\n');
  });

  it('serves a Markdown file as text/markdown', async () => {
    contentInstaller.fetchSkillFile.mockResolvedValue('# Title\n');

    const res = await request(app)
      .get(`${BASE}/skill/audit/_file`)
      .query({ path: 'references/a.md' })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/markdown; charset=utf-8/);
  });

  it('still serves the Markdown companion of an integration', async () => {
    contentInstaller.fetchIntegrationCompanion.mockResolvedValue('# Notes\n');

    const res = await request(app)
      .get(`${BASE}/integration/ckan/_file`)
      .query({ path: 'releases/1.0.0/features.md' })
      .expect(200);

    expect(contentInstaller.fetchIntegrationCompanion).toHaveBeenCalledWith(
      'main',
      'ckan',
      'releases/1.0.0/features.md'
    );
    expect(contentInstaller.fetchSkillFile).not.toHaveBeenCalled();
    expect(res.text).toBe('# Notes\n');
  });

  it('answers 404 for a file the catalog does not list', async () => {
    contentInstaller.fetchSkillFile.mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/skill/audit/_file`)
      .query({ path: 'secret.md' })
      .expect(404);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('answers 400 for another item type, a missing path and an unsafe name', async () => {
    const type = await request(app)
      .get(`${BASE}/app/chat/_file`)
      .query({ path: 'x.md' })
      .expect(400);
    expect(type.body.code).toBe('BAD_REQUEST');

    await request(app).get(`${BASE}/skill/audit/_file`).expect(400);
    await request(app).get(`${BASE}/skill/bad%20name/_file`).query({ path: 'a.md' }).expect(400);
    expect(contentInstaller.fetchSkillFile).not.toHaveBeenCalled();
  });

  it('passes the typed errors of a file that is too large or binary through', async () => {
    const { ServiceError } = await import('../utils/ServiceError.js');
    contentInstaller.fetchSkillFile.mockRejectedValueOnce(
      new ServiceError('PAYLOAD_TOO_LARGE', 'exceeds the 512KB size limit')
    );
    const large = await request(app)
      .get(`${BASE}/skill/audit/_file`)
      .query({ path: 'assets/big.txt' })
      .expect(413);
    expect(large.body.code).toBe('PAYLOAD_TOO_LARGE');

    contentInstaller.fetchSkillFile.mockRejectedValueOnce(
      new ServiceError('UNSUPPORTED_MEDIA_TYPE', 'is not a text file')
    );
    const binary = await request(app)
      .get(`${BASE}/skill/audit/_file`)
      .query({ path: 'assets/blob.dat' })
      .expect(415);
    expect(binary.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});
