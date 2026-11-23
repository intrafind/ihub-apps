#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Runs the server test files (`server/tests/**\/*.test.js`) so that no test is
 * silently left out of CI.
 *
 * Server tests are written for two runners:
 *   - jest: files that use `@jest/globals`, the `jest.` API, or the global
 *     `describe`/`test` without importing `node:test`
 *   - node:test / plain assert-and-run scripts: everything else (a plain script
 *     passes when it exits with code 0)
 *
 * Each group is run with one invocation. The process exits non-zero when either
 * group fails.
 *
 * Tiers. A file belongs to exactly one tier:
 *   - `nightly`: everything under `server/tests/faults/` and every
 *     `*.nightly.test.js`. These start real server processes or run for
 *     minutes, so they never run on a pull request: they run only with
 *     `--tier=nightly` (`npm run test:nightly`). No workflow runs this tier
 *     yet (docs/run-testing.md).
 *   - `pr`: every other file. This is the default and what `npm run test:quick`
 *     runs.
 *
 * Usage:
 *   node scripts/run-server-tests.js                     # the pr tier
 *   node scripts/run-server-tests.js <substr> [...]      # only files whose path contains every <substr>
 *   node scripts/run-server-tests.js --tier=nightly      # the whole nightly tier (`npm run test:nightly`)
 *   node scripts/run-server-tests.js --tier=nightly faults   # only its fault tests (`npm run test:faults`)
 *   node scripts/run-server-tests.js --tier=all          # both tiers
 *   node scripts/run-server-tests.js --list              # print the classification and exit
 *   node scripts/run-server-tests.js --check-quarantine  # fail when a quarantined file passes
 *
 * See docs/run-testing.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The tiers a run can ask for; `all` is both of the others. */
export const TIERS = ['pr', 'nightly', 'all'];

/**
 * A jest worker that holds more than this after a test file is replaced
 * before the next file. Without it one heavy file leaves a worker so large
 * that a later file dies with "Jest worker ran out of memory" on a machine
 * that also runs something else, which reads as a failing test.
 */
export const JEST_WORKER_IDLE_MEMORY_LIMIT = '1GB';

// Tests that fail today. They are listed here (not silently skipped) so the
// failures stay visible and a fixed test is removed from the list. Do not add
// to this list to get a red build green; fix the test or the code instead.
// `--check-quarantine` fails when a file listed here passes. "Passes" means
// what it means for every run of this script: the file's process exits with
// code 0. A plain script that logs a failed check and exits 0 passes, so such
// a file is made to exit non-zero before it is listed here.
export const QUARANTINED = {
  'adminGroupPermissions.test.js': 'permission list drifted from authorization layer',
  'adminRescue.test.js': 'expects groups.json that the test environment does not provide',
  'admin-endpoints-security.test.js': 'relies on jest.mock hoisting, which does not work in ESM',
  'authentication-security.test.js': 'relies on jest.mock hoisting, which does not work in ESM',
  'gemini3-converter.test.js': 'assertion on tool_calls finish reason fails',
  'googleImageGenerationWithSearch.test.js': 'throws TypeError on current google adapter output',
  'googleAdapter-additionalProperties.test.js': 'throws TypeError on current google adapter output',
  'googleAdapter-nda-scenario.test.js': 'throws TypeError on current google adapter output',
  'group-handling.test.js': 'uses fs.readFileSync.mockReturnValue, which ESM jest cannot mock',
  'jwt-user-validation.test.js': 'relies on jest.mock hoisting, which does not work in ESM',
  'native-web-search.test.js': 'citation text assertion fails',
  'openaiResponsesAdapter.test.js': 'max_output_tokens assertion fails (16384 vs 1024)',
  'openai-reasoning.test.js': 'budget fallback assertion fails',
  // Legacy workflow path, which the agents epic (#3771) does not move. The test
  // expects an 8192 fallback; the planner falls back to 16384 (#3861).
  'planner-maxtokens.test.js': 'exits non-zero (#3861)',
  'nda-risk-analyzer.test.js': 'NDA app config not found in the test environment',
  'pageReader-ssrf.test.js': 'redirect SSRF assertions fail: redirects are not rejected',
  // The test is wrong, not `verifyRawSignature`: its fixture is byte-identical
  // after a JSON round trip, so the signature it calls bad is the valid one
  // (#3862).
  'WebhookTrigger.test.js': 'raw signature assertion fails on its own fixture (#3862)',
  'teamsAuth.test.js': 'imports `getClearAuthCookieOptions`, no longer exported by cookieSettings',
  'telemetry-providerMap.test.js': 'provider mapping assertions fail',
  // A plain script. Until the agents epic (#3771) it logged its failed checks
  // and exited 0; it now exits 1 when a check fails. It passes its arguments to
  // `createCompletionRequest` in the wrong positions (#3863).
  'toolCallingIntegration.test.js':
    '10 checks fail: no tools in the request of four adapters (and their parameters), ' +
    'the anthropic multi-round request, no fallback for an unknown provider'
};

/**
 * The tier of a test file.
 *
 * @param {string} file - Path relative to the repository root, or any path that
 *   contains `server/tests/`.
 * @returns {'pr'|'nightly'}
 */
export function tierOf(file) {
  const normalised = file.split(path.sep).join('/');
  if (normalised.includes('server/tests/faults/')) return 'nightly';
  if (normalised.endsWith('.nightly.test.js')) return 'nightly';
  return 'pr';
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{list: boolean, checkQuarantine: boolean, tier: string, filters: string[]}}
 */
export function parseArgs(argv) {
  const options = { list: false, checkQuarantine: false, tier: 'pr', filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--check-quarantine') options.checkQuarantine = true;
    else if (arg === '--tier') options.tier = argv[++i];
    else if (arg.startsWith('--tier=')) options.tier = arg.slice('--tier='.length);
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    // More than one filter narrows further: `npm run test:faults -- resume` is "faults" and "resume".
    else options.filters.push(arg);
  }
  if (!TIERS.includes(options.tier)) {
    throw new Error(`Unknown tier "${options.tier}". Known tiers: ${TIERS.join(', ')}`);
  }
  return options;
}

/**
 * Split test files into what a run executes and what it leaves out.
 *
 * @param {string[]} allFiles - Paths relative to the repository root.
 * @param {Object} [options]
 * @param {string} [options.tier='pr']
 * @param {string[]} [options.filters=[]] - Substrings of the path; a file must contain every one.
 * @param {Object} [options.quarantined=QUARANTINED]
 * @returns {{selected: string[], quarantined: string[], otherTier: string[]}}
 */
export function selectFiles(
  allFiles,
  { tier = 'pr', filters = [], quarantined = QUARANTINED } = {}
) {
  const sorted = [...allFiles].sort((a, b) => a.localeCompare(b));
  const inTier = f => tier === 'all' || tierOf(f) === tier;
  const matches = f => filters.every(filter => f.includes(filter));
  const isQuarantined = f => Boolean(quarantined[path.basename(f)]);
  return {
    selected: sorted.filter(f => inTier(f) && matches(f) && !isQuarantined(f)),
    quarantined: sorted.filter(f => matches(f) && isQuarantined(f)),
    otherTier: sorted.filter(f => !inTier(f) && matches(f) && !isQuarantined(f))
  };
}

/**
 * Run every quarantined file on its own and report the ones that do not
 * belong in the list any more: a file that passes, and an entry without a file.
 *
 * @param {Object} params
 * @param {string[]} params.files - The quarantined files found on disk.
 * @param {Object} params.quarantined - The list (`basename → reason`).
 * @param {(file: string) => boolean} params.passes - Runs one file; true when it passes.
 * @param {string[]} [params.filters=[]] - Substrings of the path; entries outside them are not
 *   checked.
 * @returns {{passing: string[], missing: string[], stillFailing: string[]}}
 */
export function checkQuarantine({ files, quarantined, passes, filters = [] }) {
  const passing = [];
  const stillFailing = [];
  for (const file of files) (passes(file) ? passing : stillFailing).push(file);
  const found = new Set(files.map(f => path.basename(f)));
  const missing = Object.keys(quarantined).filter(
    name => !found.has(name) && filters.every(filter => name.includes(filter))
  );
  return { passing, missing, stillFailing };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (entry.name.endsWith('.test.js')) {
      out.push(path.relative(root, full));
    }
  }
  return out;
}

function isJest(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  if (/['"]node:test['"]/.test(src)) return false;
  return (
    /from ['"]@jest\/globals['"]/.test(src) ||
    /\bjest\.(fn|mock|spyOn|unstable_mockModule|useFakeTimers)\b/.test(src) ||
    /^\s*(describe|test)\(/m.test(src)
  );
}

function runNodeGroup(files, { env, stdio = 'inherit' }) {
  return spawnSync(process.execPath, ['--test', ...files], { cwd: root, env, stdio });
}

function runJestGroup(files, { env, stdio = 'inherit' }) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      `--workerIdleMemoryLimit=${JEST_WORKER_IDLE_MEMORY_LIMIT}`,
      ...files.map(f => path.relative('server', f))
    ],
    { cwd: path.join(root, 'server'), env, stdio }
  );
}

// The server tests need the Node version the package declares (`engines.node`):
// on an older Node a few suites cannot even load (ESM `require`), which shows up
// as unrelated loader errors. Stop with one clear message instead. Set
// ALLOW_UNSUPPORTED_NODE=1 to run anyway, knowing those suites will fail.
function assertSupportedNode() {
  const required = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines
    ?.node;
  const requiredMajor = Number(/\d+/.exec(required || '')?.[0]);
  const currentMajor = Number(process.versions.node.split('.')[0]);
  if (requiredMajor && currentMajor < requiredMajor && process.env.ALLOW_UNSUPPORTED_NODE !== '1') {
    console.error(
      `[server tests] Node ${process.versions.node} is too old: package.json requires ${required}. ` +
        `Use Node ${requiredMajor} (see .nvmrc), or set ALLOW_UNSUPPORTED_NODE=1 to run anyway.`
    );
    process.exit(1);
  }
}

/**
 * Run the script. The parameters exist for the self-test, which runs the
 * quarantine check on fixture files with a list of its own
 * (`server/tests/run-server-tests-runner.test.js`); the command line cannot
 * set them. Ends the process.
 *
 * @param {Object} [params]
 * @param {string[]} [params.argv] - The command line without `node` and the script.
 * @param {Object} [params.quarantined=QUARANTINED] - The quarantine list (`basename → reason`).
 * @param {string} [params.testsDir] - The directory searched for `*.test.js`.
 */
export function main({
  argv = process.argv.slice(2),
  quarantined: quarantineList = QUARANTINED,
  testsDir = path.join(root, 'server', 'tests')
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[server tests] ${error.message}`);
    process.exit(2);
  }
  assertSupportedNode();

  const allFiles = walk(testsDir);
  const { selected, quarantined, otherTier } = selectFiles(allFiles, {
    ...options,
    quarantined: quarantineList
  });
  const jestFiles = selected.filter(isJest);
  const nodeFiles = selected.filter(f => !jestFiles.includes(f));

  if (options.list) {
    const unquarantined = allFiles.filter(f => !quarantineList[path.basename(f)]);
    const count = tier => unquarantined.filter(f => tierOf(f) === tier).length;
    console.log(`tier: ${options.tier}`);
    console.log(`node:test/plain: ${nodeFiles.length}\njest: ${jestFiles.length}`);
    console.log(`quarantined: ${Object.keys(quarantineList).length}`);
    console.log(`tier pr: ${count('pr')} files`);
    console.log(`tier nightly: ${count('nightly')} files`);
    console.log(`not in this run (other tier): ${otherTier.length}`);
    process.exit(0);
  }

  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' };

  if (options.checkQuarantine) {
    console.log(`[server tests] checking ${quarantined.length} quarantined files`);
    // Some listed tests read the contents directory and pass on a machine where
    // the server has run. What counts is a fresh checkout, as in CI, so the
    // check gives every file an empty contents directory.
    const emptyContents = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-quarantine-contents-'));
    env.CONTENTS_DIR = emptyContents;
    process.once('exit', () => fs.rmSync(emptyContents, { recursive: true, force: true }));
    console.log(
      '[server tests] each file runs with an empty contents directory, as on a fresh checkout'
    );
    console.log('[server tests] a file passes when its run exits with code 0, whatever it printed');
    const result = checkQuarantine({
      files: quarantined,
      quarantined: quarantineList,
      filters: options.filters,
      passes: file => {
        const run = isJest(file) ? runJestGroup : runNodeGroup;
        const passed = run([file], { env, stdio: 'ignore' }).status === 0;
        console.log(`  ${passed ? 'PASSES' : 'fails '}  ${file}`);
        return passed;
      }
    });
    for (const file of result.passing) {
      console.error(
        `[server tests] ${file} is quarantined but passes (exit code 0). ` +
          'Remove it from QUARANTINED in scripts/run-server-tests.js. If its output shows ' +
          'failed checks, the file swallows them: make it exit non-zero instead.'
      );
    }
    for (const name of result.missing) {
      console.error(
        `[server tests] ${name} is quarantined but no such test file exists. ` +
          'Remove it from QUARANTINED in scripts/run-server-tests.js.'
      );
    }
    const stale = result.passing.length + result.missing.length;
    console.log(
      `[server tests] quarantine: ${result.stillFailing.length} still failing, ` +
        `${result.passing.length} passing, ${result.missing.length} without a file`
    );
    process.exit(stale > 0 ? 1 : 0);
  }

  if (selected.length === 0) {
    console.log(
      `[server tests] no test file in tier "${options.tier}"` +
        (options.filters.length > 0 ? ` matches "${options.filters.join('" and "')}"` : '')
    );
  }

  let failed = false;

  if (nodeFiles.length > 0) {
    console.log(`\n[server tests] node:test group: ${nodeFiles.length} files`);
    if (runNodeGroup(nodeFiles, { env }).status !== 0) failed = true;
  }

  if (jestFiles.length > 0) {
    console.log(`\n[server tests] jest group: ${jestFiles.length} files`);
    if (runJestGroup(jestFiles, { env }).status !== 0) failed = true;
  }

  process.exit(failed ? 1 : 0);
}

// Run only as a script: the self-test imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
