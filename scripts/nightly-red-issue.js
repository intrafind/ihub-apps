#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Opens the issue that says the nightly run is red, or adds a comment to the
 * one that is already open (`.github/workflows/nightly.yml`, job "Report").
 *
 * There is at most one open issue with the label `nightly-red`. The first red
 * run opens it; every later red run adds a comment to it, so the issue is the
 * history of the failure until somebody closes it. An open issue with that
 * label blocks a release candidate (docs/developer-onboarding.md).
 *
 * Who gets it: the login in `NIGHTLY_OWNER` (the repository variable of that
 * name), the person the product owner named. While nobody is named, the author
 * of the pull request that was merged last into the default branch; a pull
 * request of a bot (a dependency update) is passed over, because a bot cannot
 * act on an issue.
 *
 * Environment:
 * - `NIGHTLY_RESULTS`: JSON `{ "<job>": "success|failure|cancelled|skipped", … }`
 * - `NIGHTLY_RUN_URL`, `NIGHTLY_SHA`, `NIGHTLY_EVENT`: the run, its commit and
 *   what started it
 * - `NIGHTLY_OWNER`: a GitHub login, or empty
 * - `NIGHTLY_DEFAULT_BRANCH`: the default branch (`main` when empty)
 * - `GITHUB_REPOSITORY`, `GH_TOKEN`: for the GitHub CLI
 *
 * Usage:
 *   node scripts/nightly-red-issue.js            # open or update the issue
 *   node scripts/nightly-red-issue.js --dry-run  # print what it would post
 *
 * Exit code 0 when nothing failed or the issue was written; 1 when GitHub
 * refused; 2 when the environment is unusable.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { systemBinary } from '../server/tests/golden/differenceList.js';

export const LABEL = 'nightly-red';
export const TITLE = 'The nightly run is red';

/** Results that make a night red. A skipped job did not run and proves nothing either way. */
const RED = ['failure', 'cancelled', 'timed_out'];

/**
 * The jobs that make this run red, in the order they were given.
 *
 * @param {Record<string, string>} results - Job name → result
 * @returns {string[]}
 */
export function redJobs(results) {
  return Object.entries(results)
    .filter(([, result]) => RED.includes(result))
    .map(([job]) => job);
}

/**
 * The text of the issue, or of the comment on the open one.
 *
 * @param {Object} run
 * @param {Record<string, string>} run.results
 * @param {string} run.runUrl
 * @param {string} run.sha
 * @param {string} run.event - `schedule` or `workflow_dispatch`
 * @param {boolean} [run.first=true] - false for a comment on an open issue
 * @returns {string}
 */
export function issueBody({ results, runUrl, sha, event, first = true }) {
  const rows = Object.entries(results).map(([job, result]) => `| ${job} | ${result} |`);
  const lines = [
    first
      ? 'The nightly run failed. This issue stays open until the cause is found and fixed, and it blocks a release candidate while it is open.'
      : 'The nightly run failed again.',
    '',
    `- Run: ${runUrl}`,
    `- Commit: \`${sha}\``,
    `- Started by: ${event === 'schedule' ? 'the schedule' : event}`,
    '',
    '| Job | Result |',
    '|---|---|',
    ...rows
  ];
  if (first) {
    lines.push(
      '',
      'What to do:',
      '',
      '1. Open the run and read the log of each failed job.',
      '2. Run the failed tier on your machine (`npm run test:faults`, see docs/run-testing.md).',
      '3. Fix the cause. Do not skip a test, add it to the quarantine or set the job to continue on error.',
      '4. Close this issue when a later nightly run is green.'
    );
  }
  return lines.join('\n');
}

function gh(args, { input } = {}) {
  return execFileSync(systemBinary('gh'), args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  }).trim();
}

/**
 * The `--jq` program that picks the author of the pull request merged last
 * from `gh pr list --json author,mergedAt`: the list is ordered by creation,
 * and a bot is nobody an issue can go to.
 */
export const LAST_MERGED_AUTHOR =
  'map(select(.author.is_bot | not)) | sort_by(.mergedAt) | last | .author.login // ""';

/** A branch name as an argument of `gh`: never something that reads as an option. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The author of the pull request of a person that was merged last into the
 * default branch, or ''.
 *
 * @param {string} repo - `<owner>/<name>`
 * @param {string} branch - The default branch
 * @returns {string}
 */
function lastMergedAuthor(repo, branch) {
  try {
    return gh([
      ...['pr', 'list', '--repo', repo, '--state', 'merged'],
      ...['--base', BRANCH.test(branch) ? branch : 'main', '--limit', '30'],
      ...['--json', 'author,mergedAt', '--jq', LAST_MERGED_AUTHOR]
    ]);
  } catch {
    return '';
  }
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  let results;
  try {
    results = JSON.parse(process.env.NIGHTLY_RESULTS || '');
  } catch {
    console.error('NIGHTLY_RESULTS must be JSON: { "<job>": "<result>", … }');
    return 2;
  }
  const failed = redJobs(results);
  if (failed.length === 0) {
    console.log('No job of the nightly run failed; no issue.');
    return 0;
  }
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!dryRun && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(`GITHUB_REPOSITORY is not a repository: "${repo}"`);
    return 2;
  }
  const run = {
    results,
    runUrl: process.env.NIGHTLY_RUN_URL || '(unknown run)',
    sha: process.env.NIGHTLY_SHA || '(unknown commit)',
    event: process.env.NIGHTLY_EVENT || 'schedule'
  };
  if (dryRun) {
    console.log(`Red: ${failed.join(', ')}\n\n${issueBody(run)}`);
    return 0;
  }

  try {
    const open = gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      LABEL,
      '--state',
      'open',
      '--limit',
      '1',
      '--json',
      'number',
      '--jq',
      '.[0].number // ""'
    ]);
    if (open) {
      gh(['issue', 'comment', open, '--repo', repo, '--body-file', '-'], {
        input: issueBody({ ...run, first: false })
      });
      console.log(`Red: ${failed.join(', ')}. Commented on #${open}.`);
      return 0;
    }
    // The label may not exist yet. With `--force` an existing one is no error:
    // it is set to this colour and description again.
    gh([
      'label',
      'create',
      LABEL,
      '--repo',
      repo,
      '--color',
      'B60205',
      '--description',
      'The nightly run failed. Blocks a release candidate while open.',
      '--force'
    ]);
    const url = gh(
      ['issue', 'create', '--repo', repo, '--title', TITLE, '--label', LABEL, '--body-file', '-'],
      { input: issueBody(run) }
    );
    console.log(`Red: ${failed.join(', ')}. Opened ${url}.`);
    // Best effort: a login that cannot be assigned must not lose the issue.
    const owner =
      (process.env.NIGHTLY_OWNER || '').trim() ||
      lastMergedAuthor(repo, process.env.NIGHTLY_DEFAULT_BRANCH || 'main');
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) {
      try {
        gh(['issue', 'edit', url, '--repo', repo, '--add-assignee', owner]);
        console.log(`Assigned to ${owner}.`);
      } catch (error) {
        console.log(`Not assigned to ${owner}: ${String(error.stderr || error.message).trim()}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(`GitHub refused: ${String(error.stderr || error.message).trim()}`);
    return 1;
  }
}

// Run only as a script: the test imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
