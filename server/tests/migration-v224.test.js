// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V224 — the pre-provider runtime records (workflow checkpoints, the
 * run ledger index, the execution registry, pending interactions) are carried
 * into the storage provider once.
 *
 * The cases drive the real filesystem provider over scratch directories. The
 * properties that matter for an upgrade: nothing is lost that a user can see,
 * nothing the user deleted comes back, a record the live server already wrote
 * is never overwritten, the legacy files stay where they are, and an
 * installation whose boot-time importer already ran does not import twice.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { RunSummaryRepository } from '../services/runtime/RunSummaryRepository.js';
import { RUNTIME_NAMESPACES } from '../storage/namespaces.js';
import {
  hasLegacyRuntimeData,
  importPendingInteractions,
  importRunEvents,
  importRunSummaries,
  importWorkflowStates
} from '../migrations/support/legacyRuntimeImport.js';
import { precondition, version } from '../migrations/V224__import_legacy_runtime_stores.js';

const OWNER = 'user-1';
const OTHER_OWNER = 'user-2';

const WORKFLOW_STATE_NAMESPACE = RUNTIME_NAMESPACES.workflowState;
const INTERACTIONS_NAMESPACE = RUNTIME_NAMESPACES.interactions;
const MARKERS = RUNTIME_NAMESPACES.runtimeImports;

/** A log that records what the import said. */
function recordingLog() {
  const lines = [];
  return {
    lines,
    info: message => lines.push({ level: 'info', message }),
    warn: message => lines.push({ level: 'warn', message })
  };
}

/**
 * A scratch installation: a provider over `<root>/data`, and the legacy files
 * under the same root, laid out as the releases before 5.5.2 wrote them.
 */
async function withInstall(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v224-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const provider = new FilesystemStorageProvider({ baseDir: dataDir, flushIntervalMs: 25 });
  await provider.initialize();
  const stateDir = path.join(dataDir, 'workflow-state');
  const indexDir = path.join(dataDir, 'run-log', 'index');
  const registryFile = path.join(stateDir, 'execution-registry.json');
  const interactionsFile = path.join(dataDir, 'run-log', 'interactions.json');
  const runsDir = path.join(dataDir, 'run-log', 'runs');
  const spillDir = path.join(dataDir, 'run-log', 'spill');
  try {
    await fn({
      root,
      provider,
      repository: new RunSummaryRepository({
        documents: provider.documents,
        locks: provider.locks
      }),
      stateDir,
      indexDir,
      registryFile,
      interactionsFile,
      runsDir,
      spillDir,
      log: recordingLog()
    });
  } finally {
    await provider.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function state(executionId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    executionId,
    workflowId: 'wf-1',
    status: 'running',
    currentNodes: ['node-a'],
    data: { _workflow: { startedBy: OWNER }, nodeResults: {} },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function writeLegacyState(stateDir, executionId, body) {
  const dir = path.join(stateDir, executionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'latest.json');
  await fs.writeFile(file, JSON.stringify(body), 'utf8');
  return file;
}

async function writeIndexFile(indexDir, day, entries) {
  await fs.mkdir(indexDir, { recursive: true });
  const file = path.join(indexDir, `${day}.jsonl`);
  await fs.writeFile(
    file,
    entries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') +
      '\n',
    'utf8'
  );
  return file;
}

async function writeRegistryFile(file, executions) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, executions }), 'utf8');
  return file;
}

function pendingInteraction(id = 'int-legacy') {
  return {
    id,
    runId: 'wf-exec-1',
    step: 0,
    kind: 'question',
    origin: 'node',
    prompt: { message: 'Approve?', inputType: 'text', allowSkip: false, allowOther: false },
    policy: { onTimeout: 'fail', fallback: 'park' },
    status: 'pending',
    source: { principalId: 'u1', executionId: 'wf-exec-1' },
    createdAt: new Date().toISOString()
  };
}

describe('migration V224', () => {
  it('has the number it was created with', () => {
    assert.equal(version, '224');
  });

  it('runs only where a legacy runtime file exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v224-pre-'));
    try {
      assert.equal(await hasLegacyRuntimeData(root), false);
      assert.equal(await precondition({ contentsDir: root }), false, 'a fresh install skips it');
      await fs.mkdir(path.join(root, 'data', 'run-log'), { recursive: true });
      await fs.writeFile(path.join(root, 'data', 'run-log', 'interactions.json'), '{}', 'utf8');
      assert.equal(await precondition({ contentsDir: root }), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('V224: workflow states', () => {
  it('carries the checkpoint directories into the namespace, owner and all', async () => {
    await withInstall(async ({ provider, stateDir, log }) => {
      await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1'));
      await writeLegacyState(
        stateDir,
        'wf-exec-agent',
        state('wf-exec-agent', { data: { _agent: { profileId: 'p-7' } } })
      );
      await writeLegacyState(stateDir, 'wf-child-1', state('wf-child-1'));
      // The registry file shares the directory and is not an execution.
      await writeRegistryFile(path.join(stateDir, 'execution-registry.json'), []);

      const result = await importWorkflowStates({ documents: provider.documents, stateDir, log });

      assert.equal(result.ran, true);
      assert.equal(result.imported, 3, 'sub-workflow states are carried over too');
      assert.equal(
        (await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1')).ownerId,
        OWNER
      );
      assert.equal(
        (await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-agent')).ownerId,
        'agent:p-7'
      );
      assert.equal(result.candidates, 3, 'the registry file is not mistaken for an execution');
    });
  });

  it('leaves the legacy directories exactly where they are', async () => {
    await withInstall(async ({ provider, stateDir, log }) => {
      const file = await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1'));
      const before = await fs.readFile(file, 'utf8');
      await importWorkflowStates({ documents: provider.documents, stateDir, log });
      assert.equal(await fs.readFile(file, 'utf8'), before);
    });
  });

  it('skips unreadable states and ones that are not states', async () => {
    await withInstall(async ({ provider, stateDir, log }) => {
      await writeLegacyState(stateDir, 'wf-good', state('wf-good'));
      await fs.mkdir(path.join(stateDir, 'wf-torn'), { recursive: true });
      await fs.writeFile(path.join(stateDir, 'wf-torn', 'latest.json'), '{"status":', 'utf8');
      await writeLegacyState(stateDir, 'wf-not-a-state', { hello: 'world' });
      const result = await importWorkflowStates({ documents: provider.documents, stateDir, log });
      assert.equal(result.imported, 1);
      assert.ok(await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-good'));
    });
  });

  it('is idempotent, and never overwrites a newer document', async () => {
    await withInstall(async ({ provider, stateDir, log }) => {
      await writeLegacyState(stateDir, 'wf-exec-1', state('wf-exec-1', { workflowId: 'old' }));
      const documents = provider.documents;

      assert.equal((await importWorkflowStates({ documents, stateDir, log })).imported, 1);
      const second = await importWorkflowStates({ documents, stateDir, log });
      assert.equal(second.ran, false, 'the marker ends it');
      assert.ok((await documents.get(MARKERS, 'workflow-states')).data.completedAt);

      // A checkpoint the running server wrote since must survive a forced re-run.
      await documents.put(
        WORKFLOW_STATE_NAMESPACE,
        'wf-exec-1',
        state('wf-exec-1', { workflowId: 'new' })
      );
      const third = await importWorkflowStates({ documents, stateDir, log, force: true });
      assert.equal(third.imported, 0);
      assert.equal(third.skipped, 1);
      assert.equal(
        (await documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-exec-1')).data.workflowId,
        'new'
      );
    });
  });

  it('honours the marker a boot-time import already wrote', async () => {
    await withInstall(async ({ provider, stateDir, log }) => {
      await writeLegacyState(stateDir, 'wf-deleted-since', state('wf-deleted-since'));
      await provider.documents.put(MARKERS, 'workflow-states', {
        completedAt: new Date().toISOString()
      });
      const result = await importWorkflowStates({ documents: provider.documents, stateDir, log });
      assert.equal(result.ran, false);
      assert.equal(
        await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-deleted-since'),
        null
      );
    });
  });

  it('imports newest first up to the bound and says it truncated', async () => {
    await withInstall(async ({ provider, stateDir, log }) => {
      await writeLegacyState(
        stateDir,
        'wf-old',
        state('wf-old', {
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z'
        })
      );
      await writeLegacyState(
        stateDir,
        'wf-new',
        state('wf-new', {
          updatedAt: '2026-02-01T00:00:00.000Z',
          createdAt: '2026-02-01T00:00:00.000Z'
        })
      );
      const result = await importWorkflowStates({
        documents: provider.documents,
        stateDir,
        log,
        max: 1
      });
      assert.equal(result.imported, 1);
      assert.equal(result.truncated, true);
      assert.ok(await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-new'));
      assert.equal(await provider.documents.get(WORKFLOW_STATE_NAMESPACE, 'wf-old'), null);
      assert.ok(
        log.lines.some(line => line.level === 'warn' && /Only the newest 1 of 2/.test(line.message))
      );
    });
  });

  it('does nothing when there is no state directory', async () => {
    await withInstall(async ({ provider, root, log }) => {
      const result = await importWorkflowStates({
        documents: provider.documents,
        stateDir: path.join(root, 'missing'),
        log
      });
      assert.equal(result.ran, true);
      assert.equal(result.imported, 0);
    });
  });
});

describe('V224: run summaries', () => {
  it('carries the ledger index and the execution registry into the namespace', async () => {
    await withInstall(async ({ provider, repository, indexDir, registryFile, log }) => {
      await writeIndexFile(indexDir, '2026-01-01', [
        {
          ts: '2026-01-01T10:00:00.000Z',
          runId: 'chat-1',
          kind: 'chat',
          principalId: OWNER,
          anonymous: false,
          refs: { chatId: 'c-1' },
          status: 'running'
        },
        {
          ts: '2026-01-01T10:05:00.000Z',
          runId: 'chat-1',
          kind: 'chat',
          principalId: OWNER,
          anonymous: false,
          status: 'completed',
          finishReason: 'stop',
          usage: { totalTokens: 12 },
          endedAt: '2026-01-01T10:05:00.000Z'
        },
        {
          ts: '2026-01-01T11:00:00.000Z',
          runId: 'anon-abcdef',
          kind: 'chat',
          principalId: 'anon-abcdef',
          anonymous: true,
          status: 'completed'
        },
        {
          ts: '2026-01-01T12:00:00.000Z',
          runId: 'chat-deleted',
          kind: 'chat',
          principalId: OWNER,
          anonymous: false,
          status: 'running'
        },
        { ts: '2026-01-01T12:30:00.000Z', runId: 'chat-deleted', deleted: true },
        'not json at all'
      ]);
      await writeIndexFile(indexDir, '2026-01-02', [
        {
          ts: '2026-01-02T09:00:00.000Z',
          runId: 'wf-exec-1',
          kind: 'workflow',
          principalId: 'p-hash-of-u2',
          anonymous: false,
          refs: { executionId: 'wf-exec-1' },
          status: 'running'
        }
      ]);
      await writeRegistryFile(registryFile, [
        {
          executionId: 'wf-exec-1',
          userId: OTHER_OWNER,
          workflowId: 'quarterly',
          workflowName: { en: 'Quarterly' },
          status: 'completed',
          startedAt: '2026-01-02T09:00:00.000Z',
          updatedAt: '2026-01-02T09:30:00.000Z',
          completedAt: '2026-01-02T09:30:00.000Z',
          source: 'ui',
          inputPreview: 'Q4 numbers',
          models: ['gpt-4o'],
          triggeredBy: { userId: OTHER_OWNER, kind: 'human' },
          archived: false
        },
        {
          executionId: 'wf-exec-agent',
          userId: 'agent:profile-7',
          workflowId: 'agent-run',
          status: 'running',
          startedAt: '2026-01-03T09:00:00.000Z',
          updatedAt: '2026-01-03T09:00:00.000Z',
          source: 'agent'
        }
      ]);

      const result = await importRunSummaries({
        documents: provider.documents,
        locks: provider.locks,
        indexDir,
        registryFile,
        log
      });

      assert.equal(result.ran, true);
      assert.equal(result.imported, 3, 'chat-1, wf-exec-1 and wf-exec-agent');
      assert.equal(result.truncated, false);

      const chat = await repository.get('chat-1');
      assert.equal(chat.ownerId, OWNER);
      assert.equal(chat.status, 'completed');
      assert.equal(chat.startedAt, '2026-01-01T10:00:00.000Z', 'the run/start line dates the run');
      assert.equal(chat.endedAt, '2026-01-01T10:05:00.000Z');
      assert.deepEqual(chat.refs, { chatId: 'c-1' });
      assert.deepEqual(chat.usage, { totalTokens: 12 });

      // The registry wins on every field it carries, including the owner: it
      // holds the raw user id "my executions" lists by, while the ledger may
      // have recorded a pseudonymized principal for the same run.
      const workflow = await repository.get('wf-exec-1');
      assert.equal(workflow.ownerId, OTHER_OWNER);
      assert.equal(workflow.kind, 'workflow');
      assert.equal(workflow.status, 'completed');
      assert.deepEqual(workflow.workflowName, { en: 'Quarterly' });
      assert.equal(workflow.inputPreview, 'Q4 numbers');
      assert.deepEqual(workflow.triggeredBy, { userId: OTHER_OWNER, kind: 'human' });

      assert.equal((await repository.get('wf-exec-agent')).kind, 'agent');
      assert.equal(await repository.get('anon-abcdef'), null, 'anonymous runs are never imported');
      assert.equal(await repository.get('chat-deleted'), null, 'a tombstoned run stays deleted');
    });
  });

  it('leaves the legacy files exactly as they were', async () => {
    await withInstall(async ({ provider, indexDir, registryFile, log }) => {
      const indexFile = await writeIndexFile(indexDir, '2026-02-01', [
        {
          ts: '2026-02-01T10:00:00.000Z',
          runId: 'chat-2',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await writeRegistryFile(registryFile, [
        {
          executionId: 'wf-exec-9',
          userId: OWNER,
          workflowId: 'wf',
          status: 'completed',
          startedAt: '2026-02-01T10:00:00.000Z'
        }
      ]);
      const before = {
        index: await fs.readFile(indexFile, 'utf8'),
        registry: await fs.readFile(registryFile, 'utf8')
      };
      await importRunSummaries({ documents: provider.documents, indexDir, registryFile, log });
      assert.equal(await fs.readFile(indexFile, 'utf8'), before.index);
      assert.equal(await fs.readFile(registryFile, 'utf8'), before.registry);
    });
  });

  it('is idempotent, and never overwrites a record the live path wrote', async () => {
    await withInstall(async ({ provider, repository, indexDir, registryFile, log }) => {
      await writeIndexFile(indexDir, '2026-03-01', [
        {
          ts: '2026-03-01T10:00:00.000Z',
          runId: 'chat-3',
          kind: 'chat',
          principalId: OWNER,
          status: 'running'
        }
      ]);
      await writeRegistryFile(registryFile, []);
      const args = { documents: provider.documents, indexDir, registryFile, log };

      assert.equal((await importRunSummaries(args)).imported, 1);
      assert.equal((await importRunSummaries(args)).ran, false, 'the marker ends it');
      assert.ok((await provider.documents.get(MARKERS, 'run-summaries')).data.completedAt);

      await repository.patch('chat-3', { status: 'completed', finishReason: 'stop' });
      const forced = await importRunSummaries({ ...args, force: true });
      assert.equal(forced.imported, 0);
      assert.equal(forced.skipped, 1);
      assert.equal((await repository.get('chat-3')).status, 'completed');
    });
  });

  it('honours the marker a boot-time import already wrote', async () => {
    await withInstall(async ({ provider, repository, indexDir, registryFile, log }) => {
      await writeIndexFile(indexDir, '2026-03-02', [
        {
          ts: '2026-03-02T10:00:00.000Z',
          runId: 'chat-deleted-since',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await provider.documents.put(MARKERS, 'run-summaries', {
        completedAt: new Date().toISOString()
      });
      const result = await importRunSummaries({
        documents: provider.documents,
        indexDir,
        registryFile,
        log
      });
      assert.equal(result.ran, false);
      assert.equal(await repository.get('chat-deleted-since'), null);
    });
  });

  it('imports newest-first up to the bound and says it truncated', async () => {
    await withInstall(async ({ provider, repository, indexDir, registryFile, log }) => {
      await writeIndexFile(indexDir, '2026-04-01', [
        {
          ts: '2026-04-01T08:00:00.000Z',
          runId: 'chat-oldest',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        },
        {
          ts: '2026-04-01T09:00:00.000Z',
          runId: 'chat-newest',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await writeRegistryFile(registryFile, []);
      const result = await importRunSummaries({
        documents: provider.documents,
        indexDir,
        registryFile,
        log,
        max: 1
      });
      assert.equal(result.imported, 1);
      assert.equal(result.truncated, true);
      assert.equal(result.candidates, 2);
      assert.ok(await repository.get('chat-newest'));
      assert.equal(await repository.get('chat-oldest'), null);
      assert.ok(
        log.lines.some(line => line.level === 'warn' && /Only the newest 1 of 2/.test(line.message))
      );
    });
  });

  it('skips a truncated registry rather than failing', async () => {
    await withInstall(async ({ provider, repository, indexDir, registryFile, log }) => {
      await writeIndexFile(indexDir, '2026-05-01', [
        {
          ts: '2026-05-01T10:00:00.000Z',
          runId: 'chat-4',
          kind: 'chat',
          principalId: OWNER,
          status: 'completed'
        }
      ]);
      await fs.mkdir(path.dirname(registryFile), { recursive: true });
      await fs.writeFile(registryFile, '{"version":1,"executions":[{"executionId":"wf-', 'utf8');
      const result = await importRunSummaries({
        documents: provider.documents,
        indexDir,
        registryFile,
        log
      });
      assert.equal(result.imported, 1, 'the readable half is still carried over');
      assert.ok(await repository.get('chat-4'));
      assert.ok(
        log.lines.some(line => line.level === 'warn' && /not valid JSON/.test(line.message))
      );
    });
  });

  it('does nothing, and says nothing, when there is nothing to read', async () => {
    await withInstall(async ({ provider, root, log }) => {
      const result = await importRunSummaries({
        documents: provider.documents,
        indexDir: path.join(root, 'missing', 'index'),
        registryFile: path.join(root, 'missing', 'execution-registry.json'),
        log
      });
      assert.equal(result.ran, true);
      assert.equal(result.imported, 0);
      assert.equal(result.candidates, 0);
      assert.deepEqual(log.lines, []);
    });
  });
});

describe('V224: pending interactions', () => {
  it('carries pending interactions over, leaving the file alone', async () => {
    await withInstall(async ({ provider, interactionsFile, log }) => {
      await fs.mkdir(path.dirname(interactionsFile), { recursive: true });
      const body = JSON.stringify({
        version: 1,
        interactions: {
          'int-legacy': pendingInteraction(),
          'int-done': { ...pendingInteraction('int-done'), status: 'answered' }
        }
      });
      await fs.writeFile(interactionsFile, body, 'utf8');

      const result = await importPendingInteractions({
        documents: provider.documents,
        file: interactionsFile,
        log
      });

      assert.equal(result.imported, 1, 'only the pending one: a settled record is a tombstone');
      const doc = await provider.documents.get(INTERACTIONS_NAMESPACE, 'int-legacy');
      assert.equal(doc.data.status, 'pending');
      assert.equal(doc.ownerId, 'u1');
      assert.equal(await provider.documents.get(INTERACTIONS_NAMESPACE, 'int-done'), null);
      assert.equal(await fs.readFile(interactionsFile, 'utf8'), body);
    });
  });

  it('never overwrites a record the live path already wrote', async () => {
    await withInstall(async ({ provider, interactionsFile, log }) => {
      await fs.mkdir(path.dirname(interactionsFile), { recursive: true });
      await fs.writeFile(
        interactionsFile,
        JSON.stringify({ version: 1, interactions: { 'int-legacy': pendingInteraction() } }),
        'utf8'
      );
      await provider.documents.put(
        INTERACTIONS_NAMESPACE,
        'int-legacy',
        { ...pendingInteraction(), status: 'answered' },
        { ownerId: 'u1' }
      );
      const result = await importPendingInteractions({
        documents: provider.documents,
        file: interactionsFile,
        log
      });
      assert.equal(result.imported, 0);
      assert.equal(
        (await provider.documents.get(INTERACTIONS_NAMESPACE, 'int-legacy')).data.status,
        'answered'
      );
    });
  });

  it('does not import again once the marker is there', async () => {
    // Answering the imported record settles it; a second import from the
    // untouched file would bring it back as pending and resume its run twice.
    await withInstall(async ({ provider, interactionsFile, log }) => {
      await fs.mkdir(path.dirname(interactionsFile), { recursive: true });
      await fs.writeFile(
        interactionsFile,
        JSON.stringify({ version: 1, interactions: { 'int-legacy': pendingInteraction() } }),
        'utf8'
      );
      const args = { documents: provider.documents, file: interactionsFile, log };
      assert.equal((await importPendingInteractions(args)).imported, 1);
      await provider.documents.delete(INTERACTIONS_NAMESPACE, 'int-legacy');
      assert.equal((await importPendingInteractions(args)).ran, false);
      assert.equal(await provider.documents.get(INTERACTIONS_NAMESPACE, 'int-legacy'), null);
    });
  });

  it('records that it ran when there is no file', async () => {
    await withInstall(async ({ provider, root, log }) => {
      const result = await importPendingInteractions({
        documents: provider.documents,
        file: path.join(root, 'nope.json'),
        log
      });
      assert.equal(result.ran, true);
      assert.equal(result.imported, 0);
      assert.ok((await provider.documents.get(MARKERS, 'interactions')).data.completedAt);
    });
  });
});

describe('V224: run events', () => {
  const event = (seq, type, runId = 'run-1') => ({
    seq,
    ts: `2026-01-01T10:00:0${seq}.000Z`,
    runId,
    type,
    data: {}
  });

  async function writeRunFile(runsDir, runId, events) {
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      path.join(runsDir, `${runId}.jsonl`),
      events.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n',
      'utf8'
    );
  }

  it('carries the events and spilled payloads of a run into its stream', async () => {
    await withInstall(async ({ provider, runsDir, spillDir, log }) => {
      await writeRunFile(runsDir, 'run-1', [
        event(1, 'run/start'),
        event(2, 'message/user'),
        'torn line {',
        event(3, 'run/end')
      ]);
      await fs.mkdir(path.join(spillDir, 'run-1'), { recursive: true });
      await fs.writeFile(path.join(spillDir, 'run-1', 'tool-1.json'), '{"big":true}', 'utf8');

      const result = await importRunEvents({
        logs: provider.logs,
        documents: provider.documents,
        runsDir,
        spillDir,
        log
      });

      assert.deepEqual(result, { ran: true, runs: 1, events: 3, blobs: 1, skipped: 0 });
      const events = await provider.logs.read('run:run-1', { afterSeq: 0, limit: Infinity });
      assert.deepEqual(
        events.map(e => e.seq),
        [1, 2, 3]
      );
      assert.equal(
        (await provider.logs.getBlob('run:run-1', 'tool-1.json')).toString('utf8'),
        '{"big":true}'
      );
      assert.ok(await fs.stat(path.join(runsDir, 'run-1.jsonl')), 'the legacy file stays');
    });
  });

  it('adds only the events a stream does not hold, and is idempotent', async () => {
    await withInstall(async ({ provider, runsDir, spillDir, log }) => {
      await writeRunFile(runsDir, 'run-2', [
        event(1, 'run/start', 'run-2'),
        event(2, 'message/user', 'run-2')
      ]);
      // A run continued after an earlier upgrade already has seq 3 in its stream.
      await provider.logs.append('run:run-2', event(3, 'run/end', 'run-2'), 3);
      const args = { logs: provider.logs, documents: provider.documents, runsDir, spillDir, log };

      const first = await importRunEvents(args);
      assert.equal(first.events, 2);
      const events = await provider.logs.read('run:run-2', { afterSeq: 0, limit: Infinity });
      assert.deepEqual(
        events.map(e => e.seq),
        [1, 2, 3]
      );

      assert.equal((await importRunEvents(args)).ran, false, 'the marker ends it');
      const forced = await importRunEvents({ ...args, force: true });
      assert.equal(forced.events, 0, 'a forced re-run adds nothing');
    });
  });

  it('skips files that are not named after a run id', async () => {
    await withInstall(async ({ provider, runsDir, spillDir, log }) => {
      await writeRunFile(runsDir, '..hidden', [event(1, 'run/start')]);
      const result = await importRunEvents({
        logs: provider.logs,
        documents: provider.documents,
        runsDir,
        spillDir,
        log
      });
      assert.equal(result.runs, 0);
      assert.equal(result.skipped, 1);
    });
  });
});
