// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A server that starts on contents that still hold Agent Factory data (#3773).
 *
 * The Agent Factory was removed; its stored files stay. What a starting server
 * does with them:
 *
 * - the agent profiles still load (frozen legacy code reads them until the
 *   legacy path is removed, #3784), and no default profile ships any more;
 * - every unfinished Agent Factory run is cancelled with the reason
 *   `AGENT_FACTORY_REMOVED` before the resume, its open interactions are
 *   withdrawn, and it is not resumed; a plain workflow interrupted at the same
 *   time is still resumed, and finished runs are left alone;
 * - `startup/worker.js` cancels before it resumes, and its resolver never
 *   hands an Agent Factory run to the engine.
 *
 * The real boot of the entry point on such contents is a scenario of
 * `scripts/smoke-boot.js` (`npm run test:boot`); a test that starts a server
 * process belongs there or in the nightly tier.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The order `sort()` has without a comparator, said out loud: by UTF-16 code unit. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The contents directory is read once, when server/config.js is first imported.
const CONTENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-agent-factory-contents-'));
process.env.CONTENTS_DIR = CONTENTS;

const PROFILE = {
  id: 'legacy-agent',
  name: { en: 'Legacy agent' },
  description: { en: 'An Agent Factory profile written before the removal.' },
  enabled: true,
  workflow: { ref: 'external', workflowId: 'legacy-agent-workflow' }
};

function writeFile(relative, content) {
  const file = path.join(CONTENTS, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// The five places the Agent Factory stored data in (the fifth, the runs, is
// seeded through the storage provider below, which serves this directory as a
// starting server's provider does: `baseDir` is `<contents>/data`).
writeFile(`agents/profiles/${PROFILE.id}.json`, JSON.stringify(PROFILE, null, 2));
writeFile(`agents/memory/${PROFILE.id}.md`, '## iFinder corpus map\n\nTwo sources.\n');
writeFile('data/agent-inboxes/legacy-inbox.md', '# Inbox\n\n- [ ] open item\n');
writeFile('data/agent-artifacts/wf-exec-agent-done/report.md', '# Report\n');

const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
const { stateRepositoryFor } = await import('./helpers/testStorage.js');
const { StateManager, WorkflowStatus } = await import('../services/workflow/StateManager.js');
const { WorkflowEngine } = await import('../services/workflow/WorkflowEngine.js');
const { resumeInterruptedRuns } = await import('../services/workflow/resumeManager.js');
const { loadResources } = await import('../resourceLoaders.js');
const { AGENT_FACTORY_REMOVED, cancelAgentFactoryExecutions, isAgentFactoryExecution } =
  await import('../services/workflow/agentFactoryRuns.js');

const AGENT = { profileId: PROFILE.id, triggeredBy: { userId: 'alice', kind: 'manual' } };

/** Stored executions: four of the Agent Factory, two plain workflow runs. */
const SEED = {
  'wf-exec-agent-running': { status: 'running', data: { _agent: AGENT } },
  'wf-exec-agent-pending': { status: 'pending', data: { _agent: AGENT } },
  'wf-exec-agent-paused': { status: 'paused', data: { _agent: AGENT } },
  'wf-child-agent-task': { status: 'running', data: { _agent: AGENT } },
  'wf-exec-agent-done': { status: 'completed', data: { _agent: AGENT } },
  'wf-exec-plain': { status: 'running', workflowId: 'plain', data: { topic: 'x' } },
  'wf-exec-plain-paused': { status: 'paused', workflowId: 'plain', data: {} }
};

const PLAIN = {
  id: 'plain',
  config: { maxExecutionTime: 60000 },
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'end', type: 'end' }
  ],
  edges: [{ source: 'start', target: 'end' }]
};

let storage;
before(async () => {
  await shutdownStorageBootstrap();
  const provider = await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(CONTENTS, 'data'), flushIntervalMs: 25 }
    }
  });
  storage = { provider };
});
after(async () => {
  await shutdownStorageBootstrap();
  fs.rmSync(CONTENTS, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function seed(repository) {
  for (const [executionId, state] of Object.entries(SEED)) {
    await repository.write(executionId, {
      executionId,
      workflowId: state.workflowId || 'legacy-agent-workflow',
      status: state.status,
      currentNodes: state.status === 'completed' ? [] : ['end'],
      completedNodes: ['start'],
      checkpoints: [],
      history: [],
      data: state.data
    });
  }
}

/** An engine over the seeded store, with the interactions of the paused run stubbed. */
function engineFor(repository) {
  const withdrawn = [];
  const interactions = {
    listPending: async () => [
      { id: 'question-1', runId: 'wf-exec-agent-paused' },
      { id: 'question-2', runId: 'wf-exec-plain-paused' }
    ],
    cancel: async (id, reason) => withdrawn.push([id, reason])
  };
  const engine = new WorkflowEngine({
    stateManager: new StateManager({ repository }),
    interactions
  });
  return { engine, withdrawn };
}

test('the agent profiles of an existing installation still load', async () => {
  const profiles = await loadResources('agents', { includeDisabled: true, verbose: false });
  assert.deepEqual(
    profiles.map(p => p.id),
    [PROFILE.id]
  );
});

test('a new installation gets no agent profile', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'server/defaults/agents/profiles')), false);
});

test('unfinished Agent Factory runs are cancelled before the resume and are not resumed', async () => {
  const repository = stateRepositoryFor(storage);
  await seed(repository);
  const { engine, withdrawn } = engineFor(repository);

  const result = await cancelAgentFactoryExecutions({
    engine,
    repository,
    requireSchedulerOwner: false
  });
  assert.deepEqual(
    [...result.cancelled].sort(byCodeUnit),
    [
      'wf-child-agent-task',
      'wf-exec-agent-paused',
      'wf-exec-agent-pending',
      'wf-exec-agent-running'
    ].sort(byCodeUnit)
  );
  assert.deepEqual(result.failed, []);
  // Only the interaction of the Agent Factory run is withdrawn.
  assert.deepEqual(withdrawn, [['question-1', 'run_cancelled']]);

  // What is stored, read back through a fresh repository: cancelled, with the reason.
  const fresh = stateRepositoryFor(storage);
  for (const executionId of result.cancelled) {
    const state = await fresh.read(executionId);
    assert.equal(state.status, WorkflowStatus.CANCELLED, executionId);
    assert.ok(state.completedAt, `${executionId} has an end time`);
    const step = state.history.find(entry => entry.type === 'workflow_cancelled');
    assert.equal(step?.data?.reason, AGENT_FACTORY_REMOVED, `${executionId} records the reason`);
  }
  assert.equal((await fresh.read('wf-exec-agent-done')).status, 'completed');
  assert.equal((await fresh.read('wf-exec-plain')).status, 'running');
  assert.equal((await fresh.read('wf-exec-plain-paused')).status, 'paused');

  // The resume that follows, with the resolver startup/worker.js uses.
  const resumed = [];
  const sweep = await resumeInterruptedRuns({
    engine: {
      resumeFromCheckpoint: async (_definition, executionId) => resumed.push(executionId)
    },
    resolveDefinition: async state =>
      isAgentFactoryExecution(state)
        ? null
        : state.workflowId === 'plain'
          ? { definition: PLAIN, options: {} }
          : null,
    requireSchedulerOwner: false,
    repository: fresh,
    heldByAnotherWorker: () => false
  });
  assert.deepEqual(resumed, ['wf-exec-plain']);
  assert.equal(sweep.scanned, 1, 'no cancelled Agent Factory run is a resume candidate');

  // A second start finds nothing left to cancel.
  const again = await cancelAgentFactoryExecutions({
    engine: engineFor(fresh).engine,
    repository: fresh,
    requireSchedulerOwner: false
  });
  assert.deepEqual(again.cancelled, []);
});

test('the resolver tells an Agent Factory run from a plain workflow run', async () => {
  const state = { status: 'running', data: { _agent: AGENT } };
  assert.equal(isAgentFactoryExecution(state), true);
  assert.equal(isAgentFactoryExecution({ status: 'running', data: { topic: 'x' } }), false);
  assert.equal(isAgentFactoryExecution(null), false);
});

test('only the scheduler-lock owner cancels', async () => {
  let called = false;
  const result = await cancelAgentFactoryExecutions({
    engine: {
      cancel: async () => {
        called = true;
      }
    },
    repository: stateRepositoryFor(storage)
  });
  assert.deepEqual(result, { scanned: 0, cancelled: [], failed: [] });
  assert.equal(called, false);
});

test('startup/worker.js cancels before it resumes and never resolves an Agent Factory run', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'server/startup/worker.js'), 'utf8');
  const cancelAt = source.indexOf('await cancelAgentFactoryExecutions({ engine })');
  const resumeAt = source.indexOf('await resumeInterruptedRuns({ engine, resolveDefinition })');
  assert.ok(cancelAt > 0, 'worker.js cancels the Agent Factory runs');
  assert.ok(resumeAt > cancelAt, 'the cancel comes before the resume');
  assert.match(source, /if \(isAgentFactoryExecution\(state\)\) return null;/);
  assert.doesNotMatch(source, /routes\/agents\//);
});
