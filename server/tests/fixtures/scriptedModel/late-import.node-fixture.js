// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Not a test of the suite: `scriptedModel.test.js` runs this file in a child
 * `node --test` and expects it to FAIL.
 *
 * Like `swallowed-extra-call.node-fixture.js`, but the helper is first
 * imported inside a `before` hook. A hook after each test that is registered
 * that late never runs, so no single test can be failed; the file must still
 * not be green.
 */
import test, { before } from 'node:test';
import { makeClient } from '../../loop/helpers/llmFixtures.js';

let scriptedModel;
let turn;

before(async () => {
  ({ scriptedModel, turn } = await import('../../helpers/scriptedModel.js'));
});

test('code that swallows the error of an unscripted call', async () => {
  const model = scriptedModel([turn.text('one')]);
  const { client } = makeClient({ transport: model.transport, maxRetries: 0 });
  const messages = [{ role: 'user', content: 'hi' }];
  await client.complete({ modelId: 'oa', messages, telemetry: { autoRun: false } });
  await client
    .complete({ modelId: 'oa', messages, telemetry: { autoRun: false } })
    .catch(() => 'the product turned the failure into an error answer');
});

test('a test after it', () => {});
