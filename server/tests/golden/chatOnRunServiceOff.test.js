// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The goldens of the surfaces that run through the chat host — a person's
 * chat, a scheduled run, and the app turns and plain completions of the
 * inference API — recorded with the internal kill switch
 * `platform.runs.chatOnRunService` set to false: the turn runs on the agent
 * loop directly, as before it moved onto the run service.
 *
 * Every case equals its golden, except the one the difference row
 * `unattended-admin-rights` is about: with the switch off a scheduled run of
 * an admin keeps the admin flags, so that record differs from its golden in
 * exactly the parts the row names, and in no other.
 *
 * Run: node --test server/tests/golden/chatOnRunServiceOff.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertGolden, comparable, goldenFile } from './assertGolden.js';
import {
  changedParts,
  parseDifferenceList,
  DIFFERENCES_PATH,
  REPO_ROOT
} from './differenceList.js';
import { defineCase, recordCase } from './harness.js';
import { CASES } from './cases.js';
import { canonicalJson } from './normalise.js';
import path from 'node:path';

/** The surfaces whose turns run through `ChatService.runTurn`. */
const CHAT_HOST_SURFACES = new Set([
  'harness',
  'chat',
  'scheduled-task',
  'completions',
  'inference-app'
]);

/** The case whose record the switch changes, and the row that says how. */
const ADMIN_OWNER = 'scheduled-task/admin-owner';
const ADMIN_ROW = 'unattended-admin-rights';

/** Same as the case limit of `golden.test.js`. */
const CASE_TIMEOUT_MS = 120_000;

/** The case with the kill switch set in its platform configuration. */
const switchedOff = goldenCase =>
  defineCase({
    ...goldenCase,
    config: () => {
      const config =
        typeof goldenCase.config === 'function' ? goldenCase.config() : goldenCase.config;
      return {
        ...config,
        platform: { ...(config.platform || {}), runs: { chatOnRunService: false } }
      };
    }
  });

const cases = CASES.filter(goldenCase => CHAT_HOST_SURFACES.has(goldenCase.surface));

test('the chat host surfaces have cases', () => {
  assert.ok(cases.length > 20, `${cases.length} cases`);
  assert.ok(cases.some(goldenCase => goldenCase.id === ADMIN_OWNER));
});

for (const goldenCase of cases.filter(c => c.id !== ADMIN_OWNER)) {
  test(`switch off: ${goldenCase.id}`, { timeout: CASE_TIMEOUT_MS }, async () => {
    // Compared only: never written, whatever UPDATE_GOLDENS says.
    assertGolden(await recordCase(switchedOff(goldenCase)), { update: false, reportDir: null });
  });
}

test(
  `switch off: ${ADMIN_OWNER} keeps the admin flags, in the parts of its row`,
  {
    timeout: CASE_TIMEOUT_MS
  },
  async () => {
    const goldenCase = cases.find(c => c.id === ADMIN_OWNER);
    const record = await recordCase(switchedOff(goldenCase));
    const golden = JSON.parse(fs.readFileSync(goldenFile(record), 'utf8'));
    const now = JSON.parse(canonicalJson(comparable(record)));
    const rows = parseDifferenceList(
      fs.readFileSync(path.join(REPO_ROOT, DIFFERENCES_PATH), 'utf8')
    );
    const row = rows.find(r => r.id === ADMIN_ROW);
    assert.ok(row, `the row ${ADMIN_ROW}`);
    const parts = changedParts(golden, now);
    // The title of the case is the golden's; the run is the one before the change.
    assert.deepEqual(
      parts.filter(part => part !== 'title'),
      row.parts.filter(part => part !== 'title')
    );
    // The flag shows where the row says: the workflow no group of the owner grants is offered.
    assert.deepEqual(now.offeredToolIds, [['workflow_installation-check']]);
    assert.deepEqual(golden.offeredToolIds, [[]]);
  }
);
