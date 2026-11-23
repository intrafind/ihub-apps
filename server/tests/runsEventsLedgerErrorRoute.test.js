// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A failed model call's `error` event in the run ledger carries no raw
 * failure text: the run's owner replays the ledger through
 * `GET /api/runs/:runId/events` without being an administrator, and the raw
 * text of a socket failure names the internal host ("getaddrinfo ENOTFOUND
 * llm.corp.local") or carries the provider's body. LLMClient records the safe
 * sentence (`ledgerErrorMessage`) and logs the raw text on the server.
 *
 * Native ESM: run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const HOST = 'llm.corp.local';
const ledger = [];
const warnings = [];

const realAuth = await import('../middleware/authRequired.js');
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  ...realAuth,
  // The run's owner, a plain user: no admin group.
  authRequired: (req, res, next) => {
    req.user = { id: 'bea', groups: ['users'] };
    next();
  }
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res) => res.status(403).end()
}));
jest.unstable_mockModule('../services/loop/runAccess.js', () => ({
  authorizeRun: async () => ({ ok: true, meta: {} }),
  authorizeInteraction: async () => true
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: {
    info: () => {},
    warn: (message, meta) => warnings.push({ message, meta }),
    error: () => {},
    debug: () => {}
  }
}));

const { default: runLog } = await import('../services/loop/RunLog.js');
jest
  .spyOn(runLog, 'readEvents')
  .mockImplementation(async (runId, { afterSeq, limit }) =>
    ledger.filter(e => e.runId === runId && e.seq > afterSeq).slice(0, limit)
  );
jest.spyOn(runLog, 'isJournalDeleted').mockResolvedValue(false);

const { makeClient, textResponse } = await import('./loop/helpers/llmFixtures.js');
const { default: ErrorHandler } = await import('../utils/ErrorHandler.js');
const { default: registerRunRoutes } = await import('../routes/runs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { RUN_LOG_EVENTS } = await import('../../shared/runEvents.js');

/** A ledger that keeps what the client appends, in order. */
const ledgerStub = {
  append: (runId, type, data) => ledger.push({ seq: ledger.length + 1, runId, type, data }),
  isRecording: () => false,
  getRunMeta: () => null
};

/** A failed DNS lookup as the socket reports it: the message names the host. */
function dnsFailure() {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), {
    code: 'ENOTFOUND',
    hostname: HOST
  });
}

/** What a provider wrote into the body of a refused request. */
const PROVIDER_BODY = 'deployment gpt-internal-7 at tenant acme-prod rejected the request';

const app = express();
app.use(express.json());
registerRunRoutes(app);
app.use(errorHandler);

/** Run one model call that fails as `transport` fails, in run `runId`. */
async function failingCall(runId, transport) {
  const { client } = makeClient({
    runLog: ledgerStub,
    maxRetries: 0,
    errorHandler: new ErrorHandler(),
    transport
  });
  await expect(
    client.complete({
      modelId: 'oa',
      messages: [{ role: 'user', content: 'hi' }],
      telemetry: { runId, step: 1 }
    })
  ).rejects.toBeTruthy();
}

describe('the ledger of a failed model call, replayed by a non-admin owner', () => {
  beforeAll(async () => {
    await failingCall('run-dns', async () => {
      throw dnsFailure();
    });
    await failingCall('run-http', async () => textResponse(PROVIDER_BODY, { status: 400 }));
    expect(ledger.filter(event => event.type === RUN_LOG_EVENTS.ERROR)).toHaveLength(2);
  });

  it('holds no host and no socket text in the raw events', async () => {
    const res = await request(app).get('/api/runs/run-dns/events').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(HOST);
    expect(text).not.toContain('ENOTFOUND');
    const error = res.body.items.find(event => event.type === RUN_LOG_EVENTS.ERROR);
    expect(error.data.message).toBe('Network error');
  });

  it('holds no host and no socket text in the re-sync envelopes', async () => {
    const res = await request(app).get('/api/runs/run-dns/events?view=sse').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(HOST);
    expect(text).not.toContain('ENOTFOUND');
  });

  it("holds no provider body, only the call's code", async () => {
    const res = await request(app).get('/api/runs/run-http/events').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('acme-prod');
    const error = res.body.items.find(event => event.type === RUN_LOG_EVENTS.ERROR);
    expect(error.data.message).toBe('The model call failed (INVALID_REQUEST)');
    expect(error.data.status).toBe(400);
  });

  it('keeps the raw text in the server log', () => {
    const logged = warnings.find(entry => entry.message === 'Model call failed');
    expect(JSON.stringify(logged.meta)).toContain(`ENOTFOUND ${HOST}`);
  });
});
