// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat turn specs of `chatTurn.test.js`, run with the internal kill
 * switch `platform.runs.chatOnRunService` set to false: the turn runs on the
 * agent loop directly, with the seams it had before it moved onto the run
 * service, and every spec holds the same.
 *
 * The specs read the platform configuration through `configCache`; this file
 * sets the switch there before it loads them, in a process of its own.
 *
 * Run: node --test server/tests/loop/chatTurn.offRunService.test.js
 */
import 'node:test';
import configCache from '../../configCache.js';
import { chatOnRunService } from '../../services/run/RunService.js';

const platformOf = configCache.getPlatform.bind(configCache);
configCache.getPlatform = () => ({
  ...(platformOf() || {}),
  runs: { chatOnRunService: false }
});

if (chatOnRunService() !== false) {
  throw new Error('The kill switch did not take: the specs would run on the run service');
}

await import('./chatTurn.test.js');
