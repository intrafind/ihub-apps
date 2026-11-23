// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/jobs/:jobId/download` answers a result as a download: the file name
 * goes through the shared Content-Disposition builder (no quote or newline can
 * leave the quoted string) and `nosniff` stops a browser from guessing a type.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import * as realAuthRequired from '../middleware/authRequired.js';
import * as realJobStore from '../routes/toolsService/jobStore.js';

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  ...realAuthRequired,
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({}) }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { registerJobRoutes } = await import('../routes/toolsService/jobRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const router = express.Router();
registerJobRoutes(router);
const app = express();
app.use((req, res, next) => {
  req.user = { id: 'u1', groups: ['users'] };
  next();
});
app.use('/api', router);
app.use(errorHandler);

const completedJob = filename => {
  const job = realJobStore.createJob('ocr', 'u1', {});
  Object.assign(job, {
    status: 'completed',
    result: Buffer.from('%PDF-1.4'),
    resultContentType: 'application/pdf',
    resultFilename: filename
  });
  return job;
};

describe('job result download headers', () => {
  it('sends an attachment that browsers may not sniff', async () => {
    const job = completedJob('scan.pdf');
    const res = await request(app).get(`/api/jobs/${job.id}/download`).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="scan\.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps a quote in the file name inside the quoted string', async () => {
    const job = completedJob('a"; filename="evil.html');
    const res = await request(app).get(`/api/jobs/${job.id}/download`).expect(200);
    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment; filename="a_; filename=_evil\.html"; filename\*=/);
    expect(disposition.slice(0, disposition.indexOf('; filename*=')).match(/"/g)).toHaveLength(2);
  });
});
