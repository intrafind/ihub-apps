// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Saving a workflow with an "Ask a Person" step whose `options` list is empty
 * is refused (AX-B4): the person would get no button to answer with, and the
 * run would wait until it is cancelled. The answer is a VALIDATION_FAILED
 * problem whose `errors[].pointer` names the step's options.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const realSse = await import('../utils/sseChannel.js');
// The module starts an interval at import; the test must not keep the process alive.
jest.unstable_mockModule('../utils/sseChannel.js', () => ({
  ...realSse,
  startInactiveClientSweep: () => {}
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: configCache } = await import('../configCache.js');
const { default: configStore } = await import('../services/config/ConfigStore.js');
const { default: registerWorkflowRoutes } = await import('../routes/workflow/workflowRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { findUnanswerableHumanSteps } = await import('../services/workflow/workflowSaveChecks.js');

configCache.getFeatures = () => ({ workflows: true });
configCache.refreshWorkflowsCache = () => {};

const stored = new Map();
configStore.listDocuments = async () =>
  [...stored.entries()].map(([key, data]) => ({ key, path: `workflows/${key}.json`, data }));
configStore.writeJson = async (relPath, data) => {
  stored.set(relPath.replace(/^workflows\//, '').replace(/\.json$/, ''), data);
};

const app = express();
app.use(express.json());
registerWorkflowRoutes(app, { workflowEngine: {} });
app.use(errorHandler);

/** A minimal workflow: start → ask a person → end. */
function workflow(humanConfig) {
  return {
    id: 'approve-it',
    name: { en: 'Approve it' },
    description: { en: 'Asks a person' },
    version: '1.0.0',
    nodes: [
      { id: 'start', type: 'start', name: { en: 'Start' }, position: { x: 0, y: 0 }, config: {} },
      {
        id: 'ask',
        type: 'human',
        name: { en: 'Manager approval', de: 'Freigabe' },
        position: { x: 200, y: 0 },
        config: { message: { en: 'Approve?' }, ...humanConfig }
      },
      {
        id: 'end',
        type: 'end',
        name: { en: 'End' },
        position: { x: 400, y: 0 },
        config: { output: { result: '$.data' } }
      }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'ask' },
      { id: 'e2', source: 'ask', target: 'end' }
    ]
  };
}

beforeEach(() => stored.clear());

describe('saving a workflow with an Ask a Person step', () => {
  it.each([
    ['POST', '/api/workflows'],
    ['PUT', '/api/workflows/approve-it']
  ])('%s refuses an empty options list with a pointer to it', async (method, url) => {
    if (method === 'PUT') stored.set('approve-it', workflow({}));
    const before = stored.get('approve-it');

    const res = await request(app)
      [method.toLowerCase()](url)
      .send(workflow({ options: [] }))
      .expect(400);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors).toEqual([
      {
        pointer: '/nodes/1/config/options',
        code: 'too_small',
        message: expect.stringContaining('"Manager approval"')
      }
    ]);
    expect(stored.get('approve-it')).toBe(before);
  });

  it('saves a step with options', async () => {
    await request(app)
      .post('/api/workflows')
      .send(workflow({ options: [{ value: 'yes', label: { en: 'Yes', de: 'Ja' } }] }))
      .expect(201);
    expect(stored.get('approve-it').nodes[1].config.options).toHaveLength(1);
  });

  it('saves a step without an options list: the run offers "Continue"', async () => {
    await request(app).post('/api/workflows').send(workflow({})).expect(201);
    expect(stored.has('approve-it')).toBe(true);
  });
});

describe('findUnanswerableHumanSteps', () => {
  it('ignores other step types and steps with options', () => {
    expect(
      findUnanswerableHumanSteps({
        nodes: [
          { id: 'p', type: 'prompt', config: { options: [] } },
          { id: 'h', type: 'human', config: { options: [{ value: 'ok' }] } }
        ]
      })
    ).toEqual([]);
  });

  it('names the step by its id when it has no name', () => {
    const [issue] = findUnanswerableHumanSteps({
      nodes: [{ id: 'human-1', type: 'human', config: { options: [] } }]
    });
    expect(issue.message).toContain('"human-1"');
  });
});
