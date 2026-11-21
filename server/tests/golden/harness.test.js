// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The golden harness leaves nothing behind: not after a recording, and not
 * when its set-up fails half way. A case that cannot start must be one clear
 * failure, and the recording after it in the same process must still give the
 * bytes of its golden.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGolden } from './assertGolden.js';
import { recordCase, startGoldenEnv } from './harness.js';
import { harnessCases, harnessConfig } from './harnessCases.js';
import integrationRegistry from '../../services/integrations/definitions/IntegrationRegistry.js';
import { fixtureDefinitionId } from '../helpers/integrationToolFixture.js';

const toolCase = harnessCases.find(goldenCase => goldenCase.name === 'chat-turn-tool');

test('a set-up that fails undoes what it had already set up', async () => {
  const keyBefore = process.env.OPENAI_API_KEY;
  await integrationRegistry.ensureLoaded();
  const overrideBefore = integrationRegistry.contentsDirOverride;
  let reached = false;

  await assert.rejects(
    startGoldenEnv({
      ...harnessConfig(),
      env: { GOLDEN_HARNESS_SELF_TEST: 'set by the failing set-up' },
      // Called after the environment variables, the storage and the fixture tools are in place.
      integrations: () => {
        reached = true;
        assert.equal(process.env.OPENAI_API_KEY, 'sk-golden');
        assert.equal(process.env.GOLDEN_HARNESS_SELF_TEST, 'set by the failing set-up');
        assert.ok(integrationRegistry.get(fixtureDefinitionId('lookup')), 'the fixture tool is in');
        throw new Error('the integrations of this case cannot be built');
      }
    }),
    /the integrations of this case cannot be built/
  );

  assert.ok(reached);
  assert.equal(process.env.OPENAI_API_KEY, keyBefore);
  assert.equal(process.env.GOLDEN_HARNESS_SELF_TEST, undefined);
  assert.equal(integrationRegistry.contentsDirOverride, overrideBefore);
  await integrationRegistry.reload();
  assert.ok(!integrationRegistry.get(fixtureDefinitionId('lookup')), 'the fixture tool is gone');

  // The recording after the failed one starts clean: it equals its golden.
  assertGolden(await recordCase(toolCase), { update: false, reportDir: null });
});

test('stopping an environment twice is harmless', async () => {
  const keyBefore = process.env.OPENAI_API_KEY;
  const env = await startGoldenEnv(harnessConfig());
  assert.equal(process.env.OPENAI_API_KEY, 'sk-golden');
  await env.stop();
  assert.equal(process.env.OPENAI_API_KEY, keyBefore);
  // A second stop must not run the restores again, in the wrong order.
  process.env.OPENAI_API_KEY = 'set after the stop';
  try {
    await env.stop();
    assert.equal(process.env.OPENAI_API_KEY, 'set after the stop');
  } finally {
    if (keyBefore === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = keyBefore;
  }
});

test('what a case registers for the end of its recording runs when the environment stops, last first', async () => {
  const env = await startGoldenEnv(harnessConfig());
  const order = [];
  env.afterRecording(() => order.push('first registered'));
  env.afterRecording(async () => {
    // The storage of the recording is still there: what is ended here can still write.
    assert.ok(env.storage, 'the environment is gone already');
    await env.settle();
    order.push('last registered');
  });
  assert.deepEqual(order, []);
  await env.stop();
  assert.deepEqual(order, ['last registered', 'first registered']);
});
