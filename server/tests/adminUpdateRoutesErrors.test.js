// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The update administration routes answer errors through the global error
 * middleware (`{ error, code, details? }`): an installation that cannot be
 * updated in place, a missing write permission, a confirmation the apply needs,
 * an archive that was rejected (with its summary in `details.summary`) and an
 * unexpected failure.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {
  container: false,
  binary: true,
  writable: true,
  applyError: null,
  stageResult: null
};

const realService = await import('../services/updateService.js');
jest.unstable_mockModule('../services/updateService.js', () => ({
  ...realService,
  isContainerInstallation: () => state.container,
  isBinaryInstallation: () => state.binary,
  checkWritePermissions: async () => state.writable,
  applyUpdate: async () => {
    throw state.applyError;
  },
  stageLocalFile: async () => state.stageResult
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../utils/processRestart.js', () => ({ requestServerRestart: () => {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminUpdateRoutes } = await import('../routes/admin/update.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { UpdateRequestError } = realService;

const app = express();
app.use(express.json());
registerAdminUpdateRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.container = false;
  state.binary = true;
  state.writable = true;
  state.applyError = null;
  state.stageResult = null;
});

describe('update routes: errors', () => {
  it('refuses an update in a container with BAD_REQUEST and the explanation', async () => {
    state.container = true;
    const res = await request(app).post('/api/admin/update/apply').send({}).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toMatch(/container/);
  });

  it('refuses an installation that is not a binary one with BAD_REQUEST', async () => {
    state.binary = false;
    const res = await request(app).post('/api/admin/update/apply').send({}).expect(400);
    expect(res.body).toMatchObject({
      detail: 'In-place updates are only available for binary installations',
      code: 'BAD_REQUEST'
    });
  });

  it('refuses an installation that cannot be written with FORBIDDEN', async () => {
    state.writable = false;
    const res = await request(app).delete('/api/admin/update/staged').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('answers a confirmation the apply needs with its own code and status', async () => {
    state.applyError = new UpdateRequestError('confirm the downgrade', {
      status: 409,
      code: 'CONFIRM_DOWNGRADE'
    });
    const res = await request(app).post('/api/admin/update/apply').send({}).expect(409);
    expect(res.body).toMatchObject({ detail: 'confirm the downgrade', code: 'CONFIRM_DOWNGRADE' });
  });

  it('answers a request error without a code with BAD_REQUEST, or CONFLICT for a 409', async () => {
    state.applyError = new UpdateRequestError('No staged update found', { status: 409 });
    const conflict = await request(app).post('/api/admin/update/apply').send({}).expect(409);
    expect(conflict.body.code).toBe('CONFLICT');

    state.applyError = new UpdateRequestError('A file path is required');
    const missing = await request(app).post('/api/admin/update/apply').send({}).expect(400);
    expect(missing.body.code).toBe('BAD_REQUEST');
  });

  it('answers a rejected archive with ARCHIVE_REJECTED and the summary in details', async () => {
    const summary = {
      accepted: false,
      fileName: 'ihub.zip',
      source: 'local',
      sourcePath: '/srv/updates/ihub.zip',
      version: '9.9.9',
      archiveSize: 10,
      archiveSha256: 'abc',
      signature: { status: 'missing' },
      checksum: 'missing',
      problems: [{ code: 'bad-layout', message: 'The archive has no server folder' }]
    };
    state.stageResult = summary;
    const res = await request(app)
      .post('/api/admin/update/stage-local')
      .send({ path: '/srv/updates/ihub.zip' })
      .expect(422);
    expect(res.body).toMatchObject({
      detail: 'The archive has no server folder',
      code: 'ARCHIVE_REJECTED',
      details: { summary }
    });
  });

  it('hides the reason of an unexpected failure', async () => {
    state.applyError = new Error('EACCES /srv/secret/path');
    const res = await request(app).post('/api/admin/update/apply').send({}).expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
