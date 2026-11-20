// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Not a test of the suite: `scriptedModel.test.js` runs this file in a child
 * `node --test` and expects it to FAIL. The code under test here swallows the
 * error of the model call nobody scripted, and the test asserts nothing about
 * it. Only the hook of `scriptedModel.js` can fail it.
 */
import test from 'node:test';
import { makeClient } from '../../loop/helpers/llmFixtures.js';
import { scriptedModel, turn } from '../../helpers/scriptedModel.js';

test('code that swallows the error of an unscripted call', async () => {
  const model = scriptedModel([turn.text('one')]);
  const { client } = makeClient({ transport: model.transport, maxRetries: 0 });
  const messages = [{ role: 'user', content: 'hi' }];
  await client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } });
  await client
    .complete({ modelId: 'oa', messages, telemetry: { autoRun: false } })
    .catch(() => 'the product turned the failure into an error answer');
});

test('a test after it is not blamed', () => {});
