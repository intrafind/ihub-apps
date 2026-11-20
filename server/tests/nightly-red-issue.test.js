// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `scripts/nightly-red-issue.js`: which results make a night red, what the
 * issue says, and that the workflow gives the script what it reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LABEL,
  LAST_MERGED_AUTHOR,
  TITLE,
  issueBody,
  redJobs
} from '../../scripts/nightly-red-issue.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(root, 'scripts', 'nightly-red-issue.js');
const WORKFLOW = fs.readFileSync(path.join(root, '.github', 'workflows', 'nightly.yml'), 'utf8');

const run = (env, ...args) => {
  const clean = { ...process.env };
  delete clean.NODE_TEST_CONTEXT;
  delete clean.GITHUB_REPOSITORY;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...clean, ...env }
  });
};

/**
 * The `if:` of every job of a workflow text, in the order of the file: the
 * text after `if:`, a folded one (`>-`) joined into one line.
 *
 * @param {string} workflow
 * @returns {Array<[string, string]>} `[job, condition]`; '' for a job without one
 */
function jobConditions(workflow) {
  const found = [];
  let folded = false;
  for (const line of workflow.slice(workflow.indexOf('\njobs:')).split('\n')) {
    const job = /^ {2}([\w-]+):$/.exec(line);
    if (job) {
      found.push([job[1], '']);
      folded = false;
    } else if (folded && line.startsWith('      ')) {
      const last = found.at(-1);
      last[1] = `${last[1]} ${line.trim()}`.trim();
    } else {
      folded = false;
      const condition = /^ {4}if: (.*)$/.exec(line);
      if (condition && found.length > 0) {
        folded = condition[1] === '>-';
        if (!folded) found.at(-1)[1] = condition[1];
      }
    }
  }
  return found;
}

test('a failed, cancelled or timed-out job makes the night red; a skipped one does not', () => {
  assert.deepEqual(redJobs({ faults: 'success', load: 'success' }), []);
  assert.deepEqual(redJobs({ faults: 'success', quarantine: 'skipped' }), []);
  assert.deepEqual(
    redJobs({ faults: 'failure', quarantine: 'success', browsers: 'cancelled', load: 'timed_out' }),
    ['faults', 'browsers', 'load']
  );
});

test('the issue names the run, the commit and the result of every job, and says what to do', () => {
  const body = issueBody({
    results: { faults: 'failure', load: 'success' },
    runUrl: 'run-address',
    sha: 'abc123',
    event: 'schedule'
  });
  assert.match(body, /^The nightly run failed\. This issue stays open/);
  assert.match(body, /blocks a release candidate/);
  assert.match(body, /- Run: run-address/);
  assert.match(body, /- Commit: `abc123`/);
  assert.match(body, /- Started by: the schedule/);
  assert.match(body, /\| faults \| failure \|\n\| load \| success \|/);
  assert.match(
    body,
    /Do not skip a test, add it to the quarantine or set the job to continue on error/
  );
});

test('the comment on an open issue is short: the run and the results', () => {
  const body = issueBody({
    results: { faults: 'failure' },
    runUrl: 'run-address',
    sha: 'abc123',
    event: 'workflow_dispatch',
    first: false
  });
  assert.match(body, /^The nightly run failed again\./);
  assert.match(body, /- Started by: workflow_dispatch/);
  assert.doesNotMatch(body, /What to do/);
});

test('a green night writes nothing and ends with 0', () => {
  const result = run({ NIGHTLY_RESULTS: '{"faults":"success","load":"success"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No job of the nightly run failed; no issue\./);
});

test('--dry-run prints what a red night would post, without GitHub', () => {
  const result = run(
    {
      NIGHTLY_RESULTS: '{"faults":"failure","load":"success"}',
      NIGHTLY_RUN_URL: 'run-address',
      NIGHTLY_SHA: 'abc123',
      NIGHTLY_EVENT: 'schedule'
    },
    '--dry-run'
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Red: faults\n\nThe nightly run failed\./);
});

test('an unusable environment ends with 2 and writes nothing', () => {
  assert.equal(run({ NIGHTLY_RESULTS: 'not json' }).status, 2);
  assert.equal(run({ NIGHTLY_RESULTS: '' }).status, 2);
  const noRepository = run({ NIGHTLY_RESULTS: '{"faults":"failure"}' });
  assert.equal(noRepository.status, 2);
  assert.match(noRepository.stderr, /GITHUB_REPOSITORY is not a repository/);
});

test('the workflow gives the script the result of every job it waits for, and never reports a pull request', () => {
  const report = WORKFLOW.slice(WORKFLOW.indexOf('\n  report:'));
  const needs = /needs: \[([^\]]+)\]/
    .exec(report)[1]
    .split(',')
    .map(name => name.trim());
  assert.deepEqual(needs, ['faults', 'quarantine', 'browsers', 'agents', 'load']);
  for (const job of needs) {
    assert.ok(report.includes(`"${job}": "\${{ needs.${job}.result }}"`), `${job} is reported`);
    assert.match(WORKFLOW, new RegExp(`\\n  ${job}:\\n`), `${job} is a job`);
  }
  assert.match(report, /if: always\(\) && github\.event_name != 'pull_request'/);
  assert.match(report, /issues: write/);
  assert.equal(LABEL, 'nightly-red');
  assert.equal(TITLE, 'The nightly run is red');
});

test('the nightly runs on a schedule, by hand and on a pull request with the label run-faults', () => {
  assert.match(WORKFLOW, /schedule:\n\s+- cron: '17 2 \* \* \*'/);
  assert.match(WORKFLOW, /\n  workflow_dispatch:\n/);
  assert.match(WORKFLOW, /pull_request:\n\s+types: \[labeled, synchronize, reopened\]/);
  // On a pull request only the fault tier runs, and only with the label.
  const conditions = jobConditions(WORKFLOW);
  assert.deepEqual(
    conditions.map(([job]) => job),
    ['faults', 'quarantine', 'browsers', 'agents', 'load', 'report']
  );
  for (const [job, condition] of conditions) {
    if (job === 'faults') {
      assert.equal(
        condition,
        "github.event_name != 'pull_request' || " +
          "(contains(github.event.pull_request.labels.*.name, 'run-faults') && " +
          "(github.event.action != 'labeled' || github.event.label.name == 'run-faults'))"
      );
    } else {
      assert.match(condition, /github\.event_name != 'pull_request'/, job);
    }
  }
  // Another label that is put on does not cancel the fault tier of the pull request.
  assert.match(
    WORKFLOW,
    /github\.event\.action == 'labeled' && github\.event\.label\.name != 'run-faults' && '-other-label'/
  );
  // The end-to-end suite runs once per browser, and one red browser does not stop the others.
  assert.match(WORKFLOW, /fail-fast: false\n\s+matrix:\n\s+browser: \[chromium, firefox, webkit\]/);
  assert.match(WORKFLOW, /run: npm run test:e2e -- --project=\$\{\{ matrix\.browser \}\}/);
  // A red night is a finding: nothing is allowed to fail quietly.
  assert.doesNotMatch(WORKFLOW.replace(/^\s*#.*$/gm, ''), /continue-on-error/);
});

test('the pull request workflow runs the fault tests tagged smoke', () => {
  const e2e = fs.readFileSync(path.join(root, '.github', 'workflows', 'e2e.yml'), 'utf8');
  const job = e2e.slice(e2e.indexOf('\n  faults-smoke:'), e2e.indexOf('\n  difference-list:'));
  assert.match(job, /if: github\.event_name == 'pull_request' && inputs\.suite != 'full'/);
  assert.match(job, /run: npm run test:faults:smoke/);
  assert.doesNotMatch(job, /continue-on-error/);
});

/** `jq` by its full path in a system directory, never through PATH; null when absent. */
const JQ =
  ['/usr/bin/jq', '/usr/local/bin/jq', '/opt/homebrew/bin/jq'].find(candidate =>
    fs.existsSync(candidate)
  ) || null;

test(
  'while nobody is named, the issue goes to the person whose pull request was merged last',
  { skip: JQ ? false : 'jq is not installed in a system directory' },
  () => {
    const pick = list =>
      spawnSync(JQ, ['-r', LAST_MERGED_AUTHOR], { input: JSON.stringify(list), encoding: 'utf8' });
    // As `gh pr list --json author,mergedAt` prints it: ordered by creation, not by merge.
    const merged = pick([
      { author: { login: 'app/dependabot', is_bot: true }, mergedAt: '2026-03-04T09:00:00Z' },
      { author: { login: 'early', is_bot: false }, mergedAt: '2026-03-01T09:00:00Z' },
      { author: { login: 'late', is_bot: false }, mergedAt: '2026-03-03T09:00:00Z' }
    ]);
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(merged.stdout.trim(), 'late', 'the newest merge of a person, not of a bot');

    for (const none of [[], [{ author: { login: 'app/renovate', is_bot: true }, mergedAt: 'x' }]]) {
      const nobody = pick(none);
      assert.equal(nobody.status, 0, nobody.stderr);
      assert.equal(nobody.stdout.trim(), '');
    }
    // The workflow tells the script which branch is the default one.
    assert.match(
      WORKFLOW,
      /NIGHTLY_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/
    );
  }
);
