// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The scope of a run (`utils/runScope.js`): its ids reach every log line
 * written inside it (`utils/logger.js`) and the attributes of a model-call span
 * (`telemetry/attributes.js`), and nothing outside it.
 *
 * Run: node --test server/tests/runScope.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRunScope, withRunScope, RUN_SCOPE_FIELDS } from '../utils/runScope.js';
import logger from '../utils/logger.js';
import { buildCustomAttributes } from '../telemetry/attributes.js';

/** The JSON log lines written while `fn` runs. */
async function linesOf(fn) {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const text = String(chunk);
    for (const line of text.split('\n')) {
      if (line.includes('"run-scope-test"')) lines.push(JSON.parse(line));
    }
    return write(chunk, ...rest);
  };
  try {
    await fn();
    // The console transport writes on the next tick.
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.stdout.write = write;
  }
  return lines;
}

const IDS = {
  runId: 'chat-1',
  parentRunId: 'chat-0',
  kind: 'chat',
  principalId: 'u1',
  agentId: null,
  chatId: 'c1',
  modelId: 'm1'
};

test('a scope carries the ids of the run, without the empty ones, only inside it', async () => {
  assert.deepEqual(RUN_SCOPE_FIELDS, [
    'runId',
    'parentRunId',
    'kind',
    'principalId',
    'agentId',
    'chatId',
    'modelId'
  ]);
  assert.equal(currentRunScope(), null);
  const inside = await withRunScope(IDS, async () => {
    await Promise.resolve();
    return currentRunScope();
  });
  assert.deepEqual(
    { ...inside },
    {
      runId: 'chat-1',
      parentRunId: 'chat-0',
      kind: 'chat',
      principalId: 'u1',
      chatId: 'c1',
      modelId: 'm1'
    }
  );
  assert.ok(Object.isFrozen(inside));
  assert.equal(currentRunScope(), null);
});

test('a run started inside another has a scope of its own', () => {
  withRunScope(IDS, () => {
    withRunScope({ runId: 'subagent-1', parentRunId: 'chat-1', kind: 'subagent' }, () => {
      assert.equal(currentRunScope().runId, 'subagent-1');
      assert.equal(currentRunScope().parentRunId, 'chat-1');
    });
    assert.equal(currentRunScope().runId, 'chat-1');
  });
});

test('a log line inside a run carries its ids; one the caller set wins; none outside', async () => {
  const lines = await linesOf(async () => {
    await withRunScope(IDS, async () => {
      logger.info('inside', { component: 'run-scope-test' });
      logger.info('own id', { component: 'run-scope-test', runId: 'mine' });
    });
    logger.info('outside', { component: 'run-scope-test' });
  });
  const [inside, own, outside] = lines;
  assert.equal(inside.message, 'inside');
  assert.deepEqual(
    [
      inside.runId,
      inside.parentRunId,
      inside.kind,
      inside.principalId,
      inside.chatId,
      inside.modelId
    ],
    ['chat-1', 'chat-0', 'chat', 'u1', 'c1', 'm1']
  );
  assert.equal('agentId' in inside, false);
  assert.equal(own.runId, 'mine');
  assert.equal(own.kind, 'chat');
  assert.equal(outside.message, 'outside');
  assert.equal('runId' in outside, false);
});

test('the span of a model call carries the ids of its run as attributes', () => {
  assert.deepEqual(buildCustomAttributes({ appId: 'a1', run: { ...IDS, agentId: 'agent-7' } }), {
    'app.id': 'a1',
    'ihub.run.id': 'chat-1',
    'ihub.run.parent_id': 'chat-0',
    'ihub.run.kind': 'chat',
    'ihub.principal.id': 'u1',
    'ihub.agent.id': 'agent-7'
  });
  assert.deepEqual(buildCustomAttributes({ appId: 'a1' }), { 'app.id': 'a1' });
});
