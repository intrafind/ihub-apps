// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `scripts/nightly-red-issue.js`: which results make a night red, what the
 * issue says, what the script asks of GitHub on a red night (with a GitHub CLI
 * that only writes down what it is asked), and that the workflow gives the
 * script what it reads.
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
  LOCAL_COMMANDS,
  TITLE,
  issueBody,
  main,
  otherBranch,
  redJobs
} from '../../scripts/nightly-red-issue.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(root, 'scripts', 'nightly-red-issue.js');
const WORKFLOW = fs.readFileSync(path.join(root, '.github', 'workflows', 'nightly.yml'), 'utf8');
const ONBOARDING = fs.readFileSync(path.join(root, 'docs', 'developer-onboarding.md'), 'utf8');

const RED_NIGHT = {
  NIGHTLY_RESULTS: '{"faults":"failure","load":"success"}',
  NIGHTLY_RUN_URL: 'run-address',
  NIGHTLY_SHA: 'abc123',
  NIGHTLY_EVENT: 'schedule',
  NIGHTLY_REF_NAME: 'main',
  NIGHTLY_DEFAULT_BRANCH: 'main',
  NIGHTLY_OWNER: '',
  GITHUB_REPOSITORY: 'owner/repository'
};

/**
 * Run `main` with a GitHub CLI that writes down what it is asked and answers
 * from `answers`: the first entry whose key the arguments start with. An
 * answer that is an Error is thrown, as the CLI throws when GitHub refuses.
 *
 * @param {Record<string, string>} env - Laid over a red scheduled night
 * @param {Record<string, string|Error>} [answers] - Key: the first words of a command
 * @returns {{code: number, asked: string[][], input: Array<string|undefined>, out: string[], err: string[]}}
 */
function report(env, answers = {}) {
  const asked = [];
  const input = [];
  const out = [];
  const err = [];
  const gh = (args, options = {}) => {
    asked.push(args);
    input.push(options.input);
    const key = Object.keys(answers).find(words => args.join(' ').startsWith(words));
    const answer = key === undefined ? '' : answers[key];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const code = main([], {
    env: { ...RED_NIGHT, ...env },
    gh,
    log: line => out.push(line),
    error: line => err.push(line)
  });
  return { code, asked, input, out, err };
}

/** The first words of each command, as `gh` was asked. */
const commands = asked => asked.map(args => args.slice(0, 2).join(' '));

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
  assert.match(
    body,
    /\| faults \| failure \| `npm run test:faults` \|\n\| load \| success \| {2}\|/,
    'the command stands with the job that failed, and with no other'
  );
  assert.match(
    body,
    /Do not skip a test, add it to the quarantine or set the job to continue on error/
  );
});

test('the issue names the command of whichever job failed, and the page that says who acts', () => {
  for (const [job, command] of Object.entries(LOCAL_COMMANDS)) {
    const body = issueBody({
      results: { [job]: 'failure' },
      runUrl: 'run-address',
      sha: 'abc123',
      event: 'schedule'
    });
    assert.ok(body.includes(`| ${job} | failure | ${command} |`), job);
    assert.match(body, /Run each failed job on your machine, with the command in the table\./);
    assert.match(body, /docs\/developer-onboarding\.md, "When the nightly is red"/);
    if (job !== 'faults') assert.doesNotMatch(body, /test:faults/, `${job}: not the fault command`);
    // A cell of a table: nothing in it ends the cell.
    assert.doesNotMatch(command, /\|/, job);
  }
  // The comment on an open issue carries the command too.
  const again = issueBody({
    results: { load: 'failure' },
    runUrl: 'run-address',
    sha: 'abc123',
    event: 'schedule',
    first: false
  });
  assert.ok(again.includes(`| load | failure | ${LOCAL_COMMANDS.load} |`));
});

test('every job the report waits for has a command, and the onboarding page lists each one', () => {
  const report = WORKFLOW.slice(WORKFLOW.indexOf('\n  report:'));
  const needs = /needs: \[([^\]]+)\]/
    .exec(report)[1]
    .split(',')
    .map(name => name.trim());
  assert.deepEqual(Object.keys(LOCAL_COMMANDS), needs);
  const section = ONBOARDING.slice(
    ONBOARDING.indexOf('#### When the nightly is red'),
    ONBOARDING.indexOf('### Agents End-to-End Suite')
  );
  assert.ok(section.length > 0, 'the section was read');
  for (const [job, cell] of Object.entries(LOCAL_COMMANDS)) {
    // The commands of a cell: what stands between backticks and starts a command line.
    const lines = [...cell.matchAll(/`((?:npm|node) [^`]+)`/g)].map(match => match[1]);
    assert.ok(lines.length > 0, `${job} names a command`);
    for (const line of lines) assert.ok(section.includes(`\`${line}\``), `${job}: ${line}`);
  }
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

test('a red night with an open issue adds one comment to it and opens nothing', () => {
  const { code, asked, input, out, err } = report({}, { 'issue list': '17' });
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(asked, [
    [
      ...['issue', 'list', '--repo', 'owner/repository', '--label', 'nightly-red'],
      ...['--state', 'open', '--limit', '1', '--json', 'number', '--jq', '.[0].number // ""']
    ],
    ['issue', 'comment', '17', '--repo', 'owner/repository', '--body-file', '-']
  ]);
  assert.match(input[1], /^The nightly run failed again\./);
  assert.match(input[1], /- Run: run-address/);
  assert.deepEqual(out, ['Red: faults. Commented on #17.']);
});

test('a red night without an open issue makes the label, opens the issue and assigns it, in that order', () => {
  const { code, asked, input, out, err } = report(
    { NIGHTLY_OWNER: ' night-owner ' },
    { 'issue create': 'issue-address' }
  );
  assert.equal(code, 0, err.join('\n'));
  assert.deepEqual(commands(asked), ['issue list', 'label create', 'issue create', 'issue edit']);
  assert.deepEqual(asked[1].slice(0, 5), [
    'label',
    'create',
    'nightly-red',
    '--repo',
    'owner/repository'
  ]);
  assert.ok(asked[1].includes('--force'), 'a label that is there is no error');
  assert.deepEqual(asked[2], [
    ...['issue', 'create', '--repo', 'owner/repository'],
    ...['--title', 'The nightly run is red', '--label', 'nightly-red', '--body-file', '-']
  ]);
  assert.match(input[2], /^The nightly run failed\. This issue stays open/);
  assert.deepEqual(asked[3], [
    ...['issue', 'edit', 'issue-address', '--repo', 'owner/repository'],
    ...['--add-assignee', 'night-owner']
  ]);
  assert.deepEqual(out, ['Red: faults. Opened issue-address.', 'Assigned to night-owner.']);
});

test('while nobody is named, the script asks who merged last into the default branch', () => {
  const { code, asked, out } = report(
    { NIGHTLY_DEFAULT_BRANCH: 'trunk', NIGHTLY_REF_NAME: 'trunk' },
    { 'issue create': 'issue-address', 'pr list': 'last-author' }
  );
  assert.equal(code, 0);
  assert.deepEqual(commands(asked), [
    'issue list',
    'label create',
    'issue create',
    'pr list',
    'issue edit'
  ]);
  assert.deepEqual(asked[3], [
    ...['pr', 'list', '--repo', 'owner/repository', '--state', 'merged'],
    ...['--base', 'trunk', '--limit', '30'],
    ...['--json', 'author,mergedAt', '--jq', LAST_MERGED_AUTHOR]
  ]);
  assert.deepEqual(asked[4].slice(-2), ['--add-assignee', 'last-author']);
  assert.equal(out.at(-1), 'Assigned to last-author.');

  // A branch name that would read as an option is not passed on.
  const odd = report(
    { NIGHTLY_DEFAULT_BRANCH: '--web', NIGHTLY_REF_NAME: '--web' },
    { 'issue create': 'issue-address', 'pr list': 'last-author' }
  );
  assert.deepEqual(odd.asked[3].slice(6, 8), ['--base', 'main']);
});

test('an issue nobody can be assigned to is still opened, and the run ends with 0', () => {
  // GitHub refuses the login.
  const refused = report(
    { NIGHTLY_OWNER: 'gone-away' },
    {
      'issue create': 'issue-address',
      'issue edit': Object.assign(new Error('failed'), { stderr: 'could not assign\n' })
    }
  );
  assert.equal(refused.code, 0);
  assert.deepEqual(commands(refused.asked), [
    'issue list',
    'label create',
    'issue create',
    'issue edit'
  ]);
  assert.deepEqual(refused.out, [
    'Red: faults. Opened issue-address.',
    'Not assigned to gone-away: could not assign'
  ]);
  assert.deepEqual(refused.err, []);

  // Nobody is named and nobody merged: no assignment is tried.
  const nobody = report({}, { 'issue create': 'issue-address', 'pr list': '' });
  assert.equal(nobody.code, 0);
  assert.deepEqual(commands(nobody.asked), [
    'issue list',
    'label create',
    'issue create',
    'pr list'
  ]);

  // The question who merged last fails: the issue is there, unassigned.
  const unknown = report(
    {},
    { 'issue create': 'issue-address', 'pr list': new Error('no such branch') }
  );
  assert.equal(unknown.code, 0);
  assert.deepEqual(commands(unknown.asked), [
    'issue list',
    'label create',
    'issue create',
    'pr list'
  ]);

  // A name that is no login is not passed to the command line.
  const noLogin = report({ NIGHTLY_OWNER: '--web' }, { 'issue create': 'issue-address' });
  assert.equal(noLogin.code, 0);
  assert.deepEqual(commands(noLogin.asked), ['issue list', 'label create', 'issue create']);
});

test('when GitHub refuses, the run ends with 1 and says why', () => {
  const noList = report(
    {},
    { 'issue list': Object.assign(new Error('x'), { stderr: 'HTTP 403\n' }) }
  );
  assert.equal(noList.code, 1);
  assert.deepEqual(noList.err, ['GitHub refused: HTTP 403']);
  assert.deepEqual(commands(noList.asked), ['issue list']);

  const noIssue = report({}, { 'issue create': new Error('no permission') });
  assert.equal(noIssue.code, 1);
  assert.deepEqual(noIssue.err, ['GitHub refused: no permission']);
});

test('a run by hand on another branch reports nothing; one on the default branch does', () => {
  const byHand = { NIGHTLY_EVENT: 'workflow_dispatch' };
  const elsewhere = report({ ...byHand, NIGHTLY_REF_NAME: 'feature/try-the-faults' });
  assert.equal(elsewhere.code, 0);
  assert.deepEqual(elsewhere.asked, [], 'GitHub is not asked anything');
  assert.deepEqual(elsewhere.out, [
    'Red: faults. This run is on "feature/try-the-faults", not on the default branch "main"; no issue.'
  ]);

  const onDefault = report(byHand, { 'issue list': '17' });
  assert.deepEqual(commands(onDefault.asked), ['issue list', 'issue comment']);
  assert.match(onDefault.input[1], /- Started by: workflow_dispatch/);

  assert.equal(
    otherBranch({
      NIGHTLY_EVENT: 'workflow_dispatch',
      NIGHTLY_REF_NAME: 'x',
      NIGHTLY_DEFAULT_BRANCH: 'main'
    }),
    'x'
  );
  // A schedule runs on the default branch, whatever the variables say or lack.
  assert.equal(
    otherBranch({
      NIGHTLY_EVENT: 'schedule',
      NIGHTLY_REF_NAME: 'x',
      NIGHTLY_DEFAULT_BRANCH: 'main'
    }),
    ''
  );
  assert.equal(otherBranch({ NIGHTLY_REF_NAME: 'x', NIGHTLY_DEFAULT_BRANCH: 'main' }), '');
  // Unknown is not "another branch": the workflow has the same condition and decides first.
  assert.equal(otherBranch({ NIGHTLY_EVENT: 'workflow_dispatch', NIGHTLY_REF_NAME: 'x' }), '');
  assert.equal(
    otherBranch({ NIGHTLY_EVENT: 'workflow_dispatch', NIGHTLY_DEFAULT_BRANCH: 'main' }),
    ''
  );
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
  assert.equal(run({ NIGHTLY_RESULTS: 'null' }).status, 2);
  assert.equal(run({ NIGHTLY_RESULTS: '["faults"]' }).status, 2);
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
  // Not for a pull request, and not for a run by hand on another branch than the default one.
  assert.equal(
    Object.fromEntries(jobConditions(WORKFLOW)).report,
    "always() && github.event_name != 'pull_request' && " +
      "(github.event_name == 'schedule' || github.ref_name == github.event.repository.default_branch)"
  );
  assert.match(report, /NIGHTLY_REF_NAME: \$\{\{ github\.ref_name \}\}/);
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
