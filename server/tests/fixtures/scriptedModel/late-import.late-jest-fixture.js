// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Not a test of the suite: `scriptedModel.test.js` runs this file in a child
 * jest and expects two of its four tests to FAIL.
 *
 * The helper is first imported inside `beforeAll`, where a hook after each
 * test can no longer be added. The test that makes the unscripted call must
 * fail all the same, and only that one.
 */
import { test, beforeAll } from '@jest/globals';
import { makeClient } from '../../loop/helpers/llmFixtures.js';

let scriptedModel;
let turn;

beforeAll(async () => {
  ({ scriptedModel, turn } = await import('../../helpers/scriptedModel.js'));
});

async function swallowAnExtraCall() {
  const model = scriptedModel([turn.text('one')]);
  const { client } = makeClient({ transport: model.transport, maxRetries: 0 });
  const messages = [{ role: 'user', content: 'hi' }];
  await client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } });
  await client
    .complete({ modelId: 'oa', messages, telemetry: { autoRun: false } })
    .catch(() => 'the product turned the failure into an error answer');
  return model;
}

test('code that swallows the error of an unscripted call', async () => {
  await swallowAnExtraCall();
});

test('a test after it is not blamed', () => {});

test('assertDone reports the call once, not twice', async () => {
  const model = await swallowAnExtraCall();
  let thrown = null;
  try {
    model.assertDone();
  } catch (error) {
    thrown = error;
  }
  // assertDone has taken the error over: thrown here, it is the test's own failure.
  if (!thrown) throw new Error('assertDone did not throw');
  throw new Error(`reported by assertDone: ${thrown.message}`);
});

test('a script that is used exactly passes', async () => {
  const model = scriptedModel([turn.text('one')]);
  const { client } = makeClient({ transport: model.transport, maxRetries: 0 });
  const messages = [{ role: 'user', content: 'hi' }];
  await client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } });
  model.assertDone();
});
