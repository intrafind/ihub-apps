// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Not a test of the suite: `scriptedModel.test.js` runs this file in a child
 * jest and expects it to FAIL, like its `node --test` twin next to it.
 */
import { test } from '@jest/globals';
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
