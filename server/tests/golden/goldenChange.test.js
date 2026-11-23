// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the goldens are for, shown on the harness's own case: a change in what
 * the model is sent fails the golden, and the difference list accepts it only
 * with a row that names the golden and the request projection.
 *
 * The "change" is made in the configuration of the case, never in the golden
 * file: the committed golden is compared and stays as it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGolden, comparable, goldenFile } from './assertGolden.js';
import { changedParts, checkChangedGoldens } from './differenceList.js';
import { defineCase, recordCase } from './harness.js';
import { harnessCases, harnessConfig } from './harnessCases.js';
import { canonicalJson } from './normalise.js';

const toolCase = harnessCases.find(goldenCase => goldenCase.name === 'chat-turn-tool');
const GOLDEN = 'harness/chat-turn-tool.json';

/** The case with one detail of its configuration changed. */
const variant = change =>
  defineCase({
    ...toolCase,
    config: () => {
      // Copies, so a change stays in this test: the fixture objects are shared with the real cases.
      const config = harnessConfig();
      config.apps = structuredClone(config.apps);
      config.tools = config.tools.map(tool => ({
        ...tool,
        parameters: structuredClone(tool.parameters)
      }));
      change(config);
      return config;
    }
  });

const row = parts => ({
  id: 'example',
  title: 'What the model is sent changed',
  state: 'proposed',
  decision: 'Accepted in this test.',
  goldens: [GOLDEN],
  parts,
  pr: 'example',
  signedBy: null,
  signedOn: null
});

/** Compare a record with the committed golden and return the failure and the changed parts. */
function compare(record) {
  let failure = null;
  try {
    // No report: these records are changed on purpose, and the report of the real case
    // (`golden.test.js`, same file name under GOLDEN_REPORT_DIR) must keep its wording.
    assertGolden(record, { update: false, reportDir: null });
  } catch (error) {
    failure = error;
  }
  const golden = JSON.parse(fs.readFileSync(goldenFile(record), 'utf8'));
  const now = JSON.parse(canonicalJson(comparable(record)));
  return { failure, parts: changedParts(golden, now), golden, now };
}

test('the unchanged case equals its golden', async () => {
  const { failure, parts } = compare(await recordCase(variant(() => {})));
  assert.equal(failure, null);
  assert.deepEqual(parts, []);
});

test('a changed prompt order fails the golden until a row names the request projection', async () => {
  // The same two pieces of the system prompt, the date sentence now after the app's own text.
  const record = await recordCase(
    variant(config => {
      config.apps[0].system = { en: 'You answer questions about records.\n\n{{platform_context}}' };
    })
  );
  const { failure, parts, golden, now } = compare(record);
  assert.ok(failure, 'the golden fails');
  assert.match(failure.message, /harness\/chat-turn-tool differs from its golden/);
  assert.match(failure.message, /modelRequests\[0\]\.systemPromptHash/);
  assert.match(failure.message, /differences\.json/);
  assert.deepEqual(golden.modelRequests[0].roles, now.modelRequests[0].roles);
  assert.ok(parts.includes('modelRequests'), `changed parts: ${parts.join(', ')}`);

  const changes = [{ golden: GOLDEN, before: golden, after: now }];
  assert.match(checkChangedGoldens({ changes, rows: [] })[0], /no row/);
  // A row that names the golden but only the ledger does not accept the request change.
  assert.match(
    checkChangedGoldens({ changes, rows: [row(['ledger'])] })[0],
    /changed in modelRequests, which no row that names it lists/
  );
  assert.deepEqual(checkChangedGoldens({ changes, rows: [row(parts)] }), []);
});

test('a changed tool schema fails the golden until a row names it', async () => {
  const record = await recordCase(
    variant(config => {
      config.tools[0].parameters.properties.exact = {
        type: 'boolean',
        description: 'Match the key exactly'
      };
    })
  );
  const { failure, parts, golden, now } = compare(record);
  assert.ok(failure, 'the golden fails');
  assert.match(failure.message, /modelRequests\[0\]\.tools\[0\]\.schema/);
  assert.match(failure.message, /toolSchemas\./);
  // The tool is still offered under the same name and id: only its schema moved.
  assert.deepEqual(now.offeredToolIds, golden.offeredToolIds);
  assert.deepEqual(
    now.modelRequests[0].tools.map(tool => tool.name),
    golden.modelRequests[0].tools.map(tool => tool.name)
  );
  assert.ok(parts.includes('modelRequests') && parts.includes('toolSchemas'), parts.join(', '));

  const changes = [{ golden: GOLDEN, before: golden, after: now }];
  assert.equal(checkChangedGoldens({ changes, rows: [] }).length, 1);
  assert.equal(checkChangedGoldens({ changes, rows: [row(['modelRequests'])] }).length, 1);
  assert.deepEqual(checkChangedGoldens({ changes, rows: [row(parts)] }), []);
});

test('assertGolden: a missing golden fails, UPDATE_GOLDENS writes it, and never in CI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-golden-assert-'));
  try {
    const record = {
      surface: 'harness',
      case: 'example',
      title: 'An example',
      envelopes: [{ type: 'run/started', data: { b: 1, a: 2 } }],
      report: { modelRequestBodies: [{ model: 'x' }] }
    };
    // Whatever GOLDEN_REPORT_DIR says, the example writes no report there.
    const quiet = { dir, reportDir: null };
    assert.throws(() => assertGolden(record, { ...quiet, update: false }), /No golden is recorded/);
    assert.throws(
      () => assertGolden(record, { ...quiet, update: true, ci: true }),
      /UPDATE_GOLDENS is set in a CI run/
    );
    assert.equal(assertGolden(record, { ...quiet, update: true, ci: false }).written, true);
    const file = path.join(dir, 'harness', 'example.json');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text, canonicalJson(comparable(record)));
    assert.doesNotMatch(text, /modelRequestBodies/, 'the report is not part of a golden');
    assert.equal(assertGolden(record, { ...quiet, update: true, ci: false }).written, false);
    assert.equal(assertGolden(record, { ...quiet, update: false }).written, false);

    // The full request bodies go beside the goldens only when a directory is named.
    const reportDir = path.join(dir, 'report');
    assertGolden(record, { dir, update: false, reportDir });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(reportDir, 'harness', 'example.requests.json'), 'utf8')),
      record.report
    );

    // Without the option the directory comes from GOLDEN_REPORT_DIR; `reportDir: null` turns it off.
    const fromEnv = path.join(dir, 'report-from-env');
    const envBefore = process.env.GOLDEN_REPORT_DIR;
    process.env.GOLDEN_REPORT_DIR = fromEnv;
    try {
      assertGolden(record, { ...quiet, update: false });
      assert.ok(!fs.existsSync(fromEnv), 'reportDir: null wrote a report');
      assertGolden(record, { dir, update: false });
      assert.ok(fs.existsSync(path.join(fromEnv, 'harness', 'example.requests.json')));
    } finally {
      if (envBefore === undefined) delete process.env.GOLDEN_REPORT_DIR;
      else process.env.GOLDEN_REPORT_DIR = envBefore;
    }

    const changed = { ...record, envelopes: [{ type: 'run/started', data: { b: 1, a: 3 } }] };
    assert.throws(
      () => assertGolden(changed, { ...quiet, update: false }),
      error =>
        /at 1 place\(s\)/.test(error.message) &&
        /envelopes\[0\]\.data\.a\n {4}golden: 2\n {4}now: {4}3/.test(error.message)
    );
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      text,
      'a failed comparison leaves the golden alone'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
