// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The OCR upload and tool job routes answer errors through the global error
 * middleware (RFC 9457 problem+json with a registry `code`). A multer failure
 * is handed to `next` from its callback, and a result stream that errors before
 * headers go out becomes a NOT_FOUND instead of crashing the process.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as realAuthRequired from '../middleware/authRequired.js';
import * as realJobStore from '../routes/toolsService/jobStore.js';

const state = { remote: null };
const processed = [];

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  ...realAuthRequired,
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({}), getModelsForUser: async () => ({ data: [] }) }
}));
jest.unstable_mockModule('../routes/toolsService/jobStore.js', () => ({
  ...realJobStore,
  findJob: async jobId => (jobId === 'remote' ? state.remote : realJobStore.findJob(jobId))
}));
jest.unstable_mockModule('../routes/toolsService/processors/ocrProcessor.js', () => ({
  processOcrJob: job => {
    processed.push(job.id);
  }
}));
jest.unstable_mockModule('../telemetry/metrics.js', () => ({
  recordUpload: () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { registerOcrRoutes } = await import('../routes/toolsService/ocrRoutes.js');
const { registerJobRoutes } = await import('../routes/toolsService/jobRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const sealedFiles = await import('../storage/atRest/sealedFiles.js');
// A key provider of the test's own, so that the installation's key module (and with it the
// contents directory) is not loaded here. It "wraps" a data key by handing it back.
const keys = {
  provider: {
    id: 'test-keys',
    currentKeyId: async () => 'k1',
    wrap: async dataKey => ({ keyId: 'k1', wrapped: Buffer.from(dataKey) }),
    unwrap: async wrapped => Buffer.from(wrapped)
  }
};

let user = { id: 'u1', groups: ['users'] };
const router = express.Router();
registerOcrRoutes(router);
registerJobRoutes(router);
const app = express();
app.use((req, res, next) => {
  req.user = user;
  next();
});
app.use('/api', router);
app.use(errorHandler);

const PDF = Buffer.from('%PDF-1.4 test');
const problem = res => expect(res.headers['content-type']).toMatch(/application\/problem\+json/);

const postOcr = () => request(app).post('/api/ocr/process');

beforeEach(() => {
  user = { id: 'u1', groups: ['users'] };
  state.remote = null;
  processed.length = 0;
});

describe('OCR upload route: errors', () => {
  it('answers an unexpected file field with BAD_REQUEST', async () => {
    const res = await postOcr().attach('wrong', PDF, 'a.pdf').expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toMatch(/Upload error/);
    expect(processed).toHaveLength(0);
  });

  it('answers a file of a type that is not accepted with BAD_REQUEST', async () => {
    const res = await postOcr()
      .attach('files', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' })
      .expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('Unsupported file type: text/plain');
  });

  it('answers too many files with BAD_REQUEST', async () => {
    let req = postOcr();
    for (let i = 0; i < 21; i += 1) {
      req = req.attach('files', PDF, { filename: `f${i}.pdf`, contentType: 'application/pdf' });
    }
    const res = await req.expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toMatch(/Upload error/);
  });

  it('answers a request without files with BAD_REQUEST', async () => {
    const res = await postOcr().field('ocrMode', 'full').expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toBe('At least one file is required');
  });

  it('answers an unknown ocrMode with BAD_REQUEST', async () => {
    const res = await postOcr()
      .field('ocrMode', 'bogus')
      .attach('files', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('ocrMode must be one of: full, smart, text-only');
    expect(processed).toHaveLength(0);
  });

  it('answers a prompt that is too long with BAD_REQUEST', async () => {
    const res = await postOcr()
      .field('prompt', 'word '.repeat(40000))
      .attach('files', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toMatch(/prompt must be at most \d+ tokens/);
  });

  it('answers an anonymous caller with 401', async () => {
    user = { id: 'anonymous', groups: ['anonymous'] };
    const res = await postOcr().attach('files', PDF, {
      filename: 'a.pdf',
      contentType: 'application/pdf'
    });
    expect(res.status).toBe(401);
  });

  it('starts a job for a valid upload, and the process survives the failures above', async () => {
    const res = await postOcr()
      .attach('files', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(processed).toEqual([res.body.items[0].jobId]);
  });
});

describe('tool job routes: errors', () => {
  const jobFor = (data = {}) => {
    const job = realJobStore.createJob('ocr', 'u1', {});
    Object.assign(job, data);
    return job;
  };

  it('answers an unknown job with NOT_FOUND on progress, download and cancel', async () => {
    for (const [method, url] of [
      ['get', '/api/jobs/nope/progress'],
      ['get', '/api/jobs/nope/download'],
      ['post', '/api/jobs/nope/_cancel']
    ]) {
      const res = await request(app)[method](url).expect(404);
      problem(res);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.detail).toBe('Job not found');
    }
  });

  it('answers a job of another user with NOT_FOUND', async () => {
    const job = jobFor({ userId: 'someone-else', status: 'completed', result: Buffer.from('x') });
    const res = await request(app).get(`/api/jobs/${job.id}/download`).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('answers a download of a job that is not completed with BAD_REQUEST', async () => {
    const job = jobFor({ status: 'running' });
    const res = await request(app).get(`/api/jobs/${job.id}/download`).expect(400);
    problem(res);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toBe('Job is not completed yet');
  });

  it('answers a download of a completed job without a result with BAD_REQUEST', async () => {
    const job = jobFor({ status: 'completed', result: null });
    const res = await request(app).get(`/api/jobs/${job.id}/download`).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('serves the result of a completed job', async () => {
    const job = jobFor({
      status: 'completed',
      result: Buffer.from('DATA'),
      resultContentType: 'text/plain',
      resultFilename: 'out.txt'
    });
    const res = await request(app).get(`/api/jobs/${job.id}/download`).expect(200);
    expect(res.text).toBe('DATA');
  });

  it('answers a result file that cannot be read with NOT_FOUND via next', async () => {
    state.remote = {
      local: false,
      job: {
        id: 'remote',
        userId: 'u1',
        status: 'completed',
        resultFile: '/nonexistent/dir/remote.result'
      }
    };
    const res = await request(app).get('/api/jobs/remote/download').expect(404);
    problem(res);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toBe('Job result not found');
  });

  describe('the result another worker wrote, as a stream', () => {
    // Three 1 MiB segments, so that a change can sit behind bytes that were already sent.
    const RESULT = crypto.randomBytes(2 * 1024 * 1024 + 4096);
    let dir;
    let file;

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-job-stream-'));
      file = path.join(dir, 'remote.result');
      sealedFiles.configureSealedFiles({ enabled: true, keyProvider: keys.provider });
      fs.writeFileSync(file, await sealedFiles.sealForDisk('tool-jobs', 'remote.result', RESULT));
    });

    afterAll(() => {
      sealedFiles.resetSealedFiles();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const remoteJob = () => ({
      local: false,
      job: {
        id: 'remote',
        userId: 'u1',
        status: 'completed',
        resultFile: file,
        resultContentType: 'application/pdf',
        resultFilename: 'out.pdf'
      }
    });

    it('serves a sealed result opened, with the length of the result', async () => {
      state.remote = remoteJob();
      const res = await request(app)
        .get('/api/jobs/remote/download')
        .buffer(true)
        .parse((response, done) => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.body.equals(RESULT)).toBe(true);
      expect(res.headers['content-length']).toBe(String(RESULT.length));
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="out.pdf"');
    });

    it('cuts the download, instead of ending it, when a later part of the file was changed', async () => {
      state.remote = remoteJob();
      const original = fs.readFileSync(file);
      const changed = Buffer.from(original);
      changed[changed.length - 50] ^= 0x01;
      fs.writeFileSync(file, changed);
      try {
        await expect(request(app).get('/api/jobs/remote/download').buffer(true)).rejects.toThrow(
          /aborted|socket hang up|ECONNRESET/i
        );
        // Changed in its first segment, it is refused before anything is sent.
        const early = Buffer.from(original);
        early[512 + 99] ^= 0x01;
        fs.writeFileSync(file, early);
        const refused = await request(app).get('/api/jobs/remote/download');
        expect(refused.status).toBe(500);
        problem(refused);
        expect(refused.headers['content-disposition']).toBeUndefined();
      } finally {
        fs.writeFileSync(file, original);
      }
    });

    it('serves a plaintext result from before as it is', async () => {
      const plain = path.join(dir, 'plain.result');
      fs.writeFileSync(plain, 'PLAIN RESULT');
      state.remote = remoteJob();
      state.remote.job.resultFile = plain;
      const res = await request(app).get('/api/jobs/remote/download').buffer(true).expect(200);
      expect(res.headers['content-length']).toBe('12');
    });
  });

  it.each(['completed', 'cancelled', 'error'])(
    'answers a cancel of a %s job with BAD_REQUEST',
    async status => {
      const job = jobFor({ status });
      const res = await request(app).post(`/api/jobs/${job.id}/_cancel`).expect(400);
      problem(res);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.detail).toBe(`Job is already ${status}`);
    }
  );

  it('cancels a running job', async () => {
    const job = jobFor({ status: 'running' });
    const res = await request(app).post(`/api/jobs/${job.id}/_cancel`).expect(200);
    expect(res.body).toEqual({ id: job.id, status: 'cancelled' });
  });
});
