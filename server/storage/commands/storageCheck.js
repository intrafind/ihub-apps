// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:check`: check the configured blob storage without the
 * server.
 *
 * It reads `contents/config/platform.json` and the environment exactly as a
 * server start would, runs the same check with the same classification
 * (`probeBlobStorage`), and prints one line per named step. Exit code 0 means
 * a server start with this configuration gets a usable blob storage, 1 means
 * it does not. Warnings (blobs left on local disk, encryption switched off)
 * do not change the exit code.
 *
 * It writes one test object and removes it. It never writes the key check
 * object and never touches a stored blob. Like a server start, it creates
 * `contents/.encryption-key` when encryption is on and no master key exists.
 *
 * @module storage/commands/storageCheck
 */
import { blobErrorHint, blobProbeStepLabel } from '../blobOperatorGuide.js';
import {
  DEFAULT_BLOB_BACKEND,
  findLocalBlobLeftovers,
  probeBlobStorage,
  runBlobProbe
} from '../index.js';
import { checkMasterKey } from '../localBlobBackend.js';
import {
  formatNumber,
  loadKeys,
  loadPlatformConfigFromDisk,
  openLocalBlobs,
  parseFlags,
  quietServerLog
} from './commandSupport.js';

const USAGE = `Usage: npm run storage:check [-- --json] [-- --verbose]

Checks the blob storage configured in contents/config/platform.json and the
environment, without the server. Exit code 0: usable. Exit code 1: not usable.

  --json     print the result as one JSON object
  --verbose  also print the server's own log lines
`;

/**
 * One line of the check as the command reports it.
 *
 * @typedef {Object} StorageCheckStep
 * @property {string} name - `config`, `key`, `connect`, `keycheck`, `detect`,
 *   `roundtrip`, `leftovers`.
 * @property {string} label - What the step verifies.
 * @property {'ok'|'failed'|'skipped'|'warning'} status
 * @property {number} latencyMs
 * @property {string} [code] - Operator code, when failed or a warning.
 * @property {string} [detail] - One sentence.
 * @property {string} [hint] - What to do, when failed or a warning.
 */

/**
 * The result of {@link runStorageCheck}.
 *
 * @typedef {Object} StorageCheckReport
 * @property {'ok'|'error'} status
 * @property {string} provider - Blob backend: `default` or `s3`.
 * @property {string} storageProvider - Provider of documents, logs and locks.
 * @property {string} source - `environment`, `platform.json` or `default`.
 * @property {Object} [location] - Endpoint host, bucket, region and prefix.
 * @property {{enabled: boolean}} encryption
 * @property {StorageCheckStep[]} steps
 * @property {{code: string, detail: string, step: string, hint: string}|null} error
 * @property {string[]} warnings
 * @property {Array<{namespace: string, count: number, capped: boolean}>} localLeftovers
 * @property {string} checkedAt
 */

/**
 * Describe a leftover count per namespace: `chat-files: 12, artifacts: 1000+`.
 *
 * @param {Array<{namespace: string, count: number, capped: boolean}>} leftovers
 * @returns {string}
 */
export function describeLeftovers(leftovers) {
  return leftovers
    .map(
      ({ namespace, count, capped }) => `${namespace}: ${formatNumber(count)}${capped ? '+' : ''}`
    )
    .join(', ');
}

/**
 * Run the blob storage check for a configuration.
 *
 * @param {Object} [options]
 * @param {Object} [options.platformConfig] - Platform configuration (raw file).
 * @param {Object} [options.env=process.env]
 * @param {typeof probeBlobStorage} [options.probe] - The check itself (tests).
 * @param {() => Promise<Object>} [options.keys] - Key module loader (tests).
 * @returns {Promise<StorageCheckReport>} Never rejects for a failed check.
 *
 * @example
 * const report = await runStorageCheck({ platformConfig });
 * process.exitCode = report.status === 'ok' ? 0 : 1;
 */
export async function runStorageCheck({
  platformConfig = {},
  env = process.env,
  probe = probeBlobStorage,
  keys = loadKeys
} = {}) {
  let result = await probe({ platformConfig, env, createKeyCheck: false });
  const remote = result.provider !== DEFAULT_BLOB_BACKEND;
  const encryptionEnabled = result.encryption?.enabled === true;

  if (!remote && encryptionEnabled) {
    // The provider's own blobs need the provider, whose check is the start
    // itself. What can be checked without it is the key they are encrypted with.
    const keyCheck = await runBlobProbe({
      provider: DEFAULT_BLOB_BACKEND,
      steps: [{ name: 'key', run: async () => checkMasterKey(await keys()) }]
    });
    result = { ...result, ...keyCheck };
  }

  const steps = result.steps.map(step => ({
    ...step,
    label: blobProbeStepLabel(step.name),
    ...(step.status === 'failed' ? { hint: blobErrorHint(step.code) } : {})
  }));
  if (!steps.some(step => step.name === 'config')) {
    steps.unshift({
      name: 'config',
      label: blobProbeStepLabel('config'),
      status: 'ok',
      latencyMs: 0
    });
  }

  const warnings = [];
  let localLeftovers = [];
  let storageProvider = 'unknown';
  try {
    const local = openLocalBlobs(platformConfig, env);
    storageProvider = local.provider;
    if (remote) {
      const startedAt = Date.now();
      if (result.status !== 'ok') {
        steps.push({
          name: 'leftovers',
          label: blobProbeStepLabel('leftovers'),
          status: 'skipped',
          latencyMs: 0
        });
      } else {
        localLeftovers = local.blobs ? await findLocalBlobLeftovers(local.blobs) : [];
        const found = localLeftovers.length > 0;
        steps.push({
          name: 'leftovers',
          label: blobProbeStepLabel('leftovers'),
          status: found ? 'warning' : 'ok',
          latencyMs: Date.now() - startedAt,
          ...(found
            ? {
                code: 'BLOB_LOCAL_LEFTOVERS',
                detail:
                  `Blobs are still on local disk (${describeLeftovers(localLeftovers)}). ` +
                  `They are not served while blob storage is "${result.provider}".`,
                hint: 'Copy them while the server is stopped: npm run storage:copy-blobs'
              }
            : {})
        });
        if (found) warnings.push('Blobs are still on local disk and are not served.');
      }
    }
  } catch (error) {
    warnings.push(`The local blob store could not be inspected: ${error.message}`);
  }

  if (remote && !encryptionEnabled) {
    warnings.push(
      'Encryption is off (storage.encryption.enabled): blobs are uploaded as they are, and ' +
        'whoever can read the bucket can read the files.'
    );
  }
  if (encryptionEnabled) {
    try {
      const master = (await keys()).describeMasterKey?.();
      if (master?.source === 'generated') {
        warnings.push(
          'A new master key was created in contents/.encryption-key. Back it up: without it ' +
            'no encrypted blob can be read.'
        );
      }
    } catch {
      // The key step has already reported a key that cannot be loaded.
    }
  }

  return {
    status: result.status,
    provider: result.provider,
    storageProvider,
    source: result.source,
    ...(result.location ? { location: result.location } : {}),
    encryption: { enabled: encryptionEnabled },
    steps,
    error: result.error ? { ...result.error, hint: blobErrorHint(result.error.code) } : null,
    warnings,
    localLeftovers,
    checkedAt: result.checkedAt
  };
}

const MARKS = { ok: '[ok]  ', failed: '[FAIL]', skipped: '[skip]', warning: '[warn]' };
const INDENT = ' '.repeat(14);

/**
 * The report as the lines the command prints.
 *
 * @param {StorageCheckReport} report
 * @returns {string}
 */
export function formatStorageCheck(report) {
  const lines = ['Blob storage check (configuration on disk, not the running server)'];
  const remote = report.provider !== DEFAULT_BLOB_BACKEND;
  lines.push(
    `  provider    ${remote ? report.provider : `${report.provider} (kept by the "${report.storageProvider}" storage provider)`}, set by ${report.source}`
  );
  if (report.location) {
    const { endpointHost, bucket, region, prefix } = report.location;
    lines.push(`  endpoint    ${endpointHost}`);
    lines.push(`  bucket      ${bucket}   prefix ${prefix || '(none)'}   region ${region}`);
  }
  lines.push(
    `  encryption  ${
      report.encryption.enabled
        ? 'on: every blob is encrypted before it is stored'
        : 'off: blobs are stored as they are'
    }`,
    ''
  );

  report.steps.forEach((step, index) => {
    const timing =
      step.status === 'ok' && step.latencyMs > 0 ? `  ${formatNumber(step.latencyMs)} ms` : '';
    lines.push(
      `  ${MARKS[step.status]}  ${index + 1}/${report.steps.length} ${step.label}${timing}`
    );
    if (step.status === 'failed' || step.status === 'warning') {
      lines.push(`${INDENT}${step.code}: ${step.detail}`);
      if (step.hint) lines.push(`${INDENT}${step.hint}`);
    } else if (step.detail) {
      lines.push(`${INDENT}${step.detail}`);
    }
  });

  lines.push('');
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  if (report.status === 'ok') {
    const count = report.warnings.length;
    lines.push(
      `Result: usable${count > 0 ? `, ${count} warning${count === 1 ? '' : 's'}` : ''}. ` +
        'A server start with this configuration uses this blob storage; a running server ' +
        'needs a restart to pick up a change.'
    );
  } else {
    lines.push(
      `Result: not usable (${report.error.code}). A server start with this configuration fails.`
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The command.
 *
 * @param {string[]} [argv] - Arguments after the script name.
 * @param {Object} [io]
 * @param {(text: string) => void} [io.out] - Receives the output.
 * @param {Object} [io.env=process.env]
 * @returns {Promise<number>} The exit code: 0 usable, 1 not usable, 2 wrong usage.
 */
export async function main(
  argv = process.argv.slice(2),
  { out = text => process.stdout.write(text), env = process.env } = {}
) {
  const { flags, unknown } = parseFlags(argv, ['json', 'verbose', 'help']);
  if (flags.help || unknown.length > 0) {
    out(unknown.length > 0 ? `Unknown argument: ${unknown.join(' ')}\n\n${USAGE}` : USAGE);
    return flags.help && unknown.length === 0 ? 0 : 2;
  }
  quietServerLog(flags.verbose === true);
  let report;
  try {
    report = await runStorageCheck({ platformConfig: await loadPlatformConfigFromDisk(), env });
  } catch (error) {
    out(
      flags.json
        ? `${JSON.stringify({ status: 'error', error: { code: 'BLOB_STORAGE_ERROR', detail: error.message } })}\n`
        : `The blob storage check could not run: ${error.message}\n`
    );
    return 1;
  }
  out(flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatStorageCheck(report));
  return report.status === 'ok' ? 0 : 1;
}
