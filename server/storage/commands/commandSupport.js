// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the storage commands (`npm run storage:check`,
 * `npm run storage:copy-blobs`) share: reading the configuration the way a
 * server start does, keeping the server's log lines out of their output, and
 * reaching the blobs the storage provider keeps itself.
 *
 * The commands run without the server. They never bring the storage provider
 * up (no timers, no sweeps, no locks); they build it and use its blob facet.
 *
 * @module storage/commands/commandSupport
 */
import { loadJson } from '../../configLoader.js';
import { setLogLevel } from '../../utils/logger.js';
import { createProvider, resolveStorageConfig } from '../index.js';

/** The key module, as the storage registry loads it. */
export const loadKeys = () => import('../../crypto/KeyProvider.js');

/**
 * `contents/config/platform.json` as a server start reads it: the raw file,
 * `{}` when there is none.
 *
 * @returns {Promise<Object>}
 */
export async function loadPlatformConfigFromDisk() {
  const platformConfig = await loadJson('config/platform.json');
  return platformConfig && typeof platformConfig === 'object' ? platformConfig : {};
}

/**
 * Keep the server's own log lines short while a command runs: errors only,
 * unless asked for all of them. The command entry point (`run.js`) sends
 * whatever the logger still prints to stderr, so stdout holds the report only.
 *
 * @param {boolean} [verbose=false] - Keep every log line.
 * @returns {void}
 */
export function quietServerLog(verbose = false) {
  if (!verbose) setLogLevel('error');
}

/**
 * The blob facet of the configured storage provider (`storage.provider`, the
 * filesystem by default), without starting the provider.
 *
 * @param {Object} platformConfig - Platform configuration (raw file).
 * @param {Object} [env=process.env]
 * @returns {{provider: string, blobs: import('../BlobStore.js').BlobStore|null, baseDir: string|null}}
 *   `blobs` is null for a provider without a blob facet, `baseDir` for one
 *   without a data directory.
 * @throws {import('../errors.js').UnknownProviderError} For an unknown provider.
 */
export function openLocalBlobs(platformConfig, env = process.env) {
  const { provider, config } = resolveStorageConfig(platformConfig, env);
  const base = createProvider(provider, config);
  let blobs = null;
  try {
    blobs = base.blobs || null;
  } catch {
    blobs = null;
  }
  const baseDir = typeof base.baseDir === 'string' ? base.baseDir : null;
  return { provider, blobs, baseDir };
}

/**
 * Parse the flags of a command: `--name` (true) and `--name=value`.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @param {string[]} known - Flag names the command accepts, without dashes.
 * @returns {{flags: Record<string, string|boolean>, unknown: string[]}}
 *
 * @example
 * parseFlags(['--dry-run', '--namespace=chat-files'], ['dry-run', 'namespace']);
 * // { flags: { 'dry-run': true, namespace: 'chat-files' }, unknown: [] }
 */
export function parseFlags(argv, known) {
  const flags = {};
  const unknown = [];
  for (const argument of argv) {
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(argument);
    if (!match || !known.includes(match[1])) {
      unknown.push(argument);
      continue;
    }
    flags[match[1]] = match[2] === undefined ? true : match[2];
  }
  return { flags, unknown };
}

/**
 * A number with thousands separators, the same on every machine.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

/**
 * A byte count for people: `3.1 GB`.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatByteSize(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}
