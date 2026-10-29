// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * After an update the process the launcher started must exit with 75, or the
 * launcher never restarts the server. Under clustering that process is the
 * primary: a worker calling process.exit(75) used to be respawned on its own,
 * leaving the other workers on the old code.
 *
 * Run: node --test server/tests/update-restart.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UPDATE_RESTART_CODE } from '../utils/processRestart.js';

const child = fileURLToPath(new URL('./fixtures/update-restart-child.mjs', import.meta.url));
const run = mode =>
  spawnSync(process.execPath, [child, mode], { encoding: 'utf8', timeout: 20_000 });

describe('requestServerRestart', () => {
  it('drains and exits a single process with the restart code', () => {
    const result = run('single');
    assert.equal(result.status, UPDATE_RESTART_CODE, result.stderr);
  });

  it('makes the cluster primary exit with the restart code when a worker asks', () => {
    const result = run('cluster');
    assert.equal(result.status, UPDATE_RESTART_CODE, result.stderr);
  });
});
