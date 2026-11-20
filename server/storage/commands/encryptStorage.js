#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `npm run storage:encrypt`: encrypt the stored data of an installation in
 * place (documents, append logs with their spill blobs, blobs, and the files
 * of agent artifacts, agent memory, agent inboxes, tool-job results and short
 * links), with the server stopped. It is the conversion a server start runs when
 * `storage.encryption.enabled` is switched on, run ahead of time so that
 * start is fast.
 *
 *     node server/storage/commands/encryptStorage.js --dry-run
 *     node server/storage/commands/encryptStorage.js
 *
 * `--dry-run` changes nothing: it counts what is still plaintext, checks the
 * master key and the free space and gives an estimate. Run it before
 * switching encryption on.
 *
 * **Stop the server first.** The conversion replaces every plaintext object
 * by its encrypted form; a server writing at the same time can lose a write.
 * The command is idempotent and resumable: interrupted, it is run again and
 * skips what is done.
 *
 * It works whatever the switch says. With the switch still off, the next
 * server start writes plaintext again and keeps reading what is encrypted;
 * switch it on before that start to keep everything encrypted.
 *
 * Exit code 0: done, or the dry run found the preconditions met. 1: a
 * precondition does not hold or plaintext is left. 2: a wrong argument.
 *
 * @module storage/commands/encryptStorage
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plaintextRemaining } from '../atRest/convert.js';
import { prepareStorageEncryption } from '../atRest/prepare.js';
import {
  formatByteSize,
  formatNumber,
  loadPlatformConfigFromDisk,
  parseFlags,
  quietServerLog
} from './commandSupport.js';

const USAGE = `Usage: npm run storage:encrypt -- [--dry-run] [--json] [--verbose]

Encrypts the stored data (documents, append logs, blobs, agent and
short-link files) in place. With the blobs in an S3 bucket
(storage.blobs.provider) it also encrypts the blobs in that bucket and
writes its key check object.
Stop every server that uses this data directory or bucket first: a server
that keeps running writes plaintext that the conversion does not see.
Safe to interrupt and to run again. A second run at the same time refuses.

  --dry-run   count what is still plaintext, check key and free space, change nothing
  --json      print the result as JSON
  --verbose   also print the server's log lines (to stderr)
`;

/**
 * The result as text.
 *
 * @param {Object} result - What `prepareStorageEncryption` returned.
 * @returns {string}
 */
export function formatEncryptResult(result) {
  const lines = [];
  if (result.action === 'unsupported') {
    return 'The configured storage provider does not encrypt documents and append logs.\n';
  }
  lines.push(`Data directory  ${result.baseDir}`);
  lines.push(`Switch          storage.encryption.enabled is ${result.enabled ? 'on' : 'off'}`);
  if (result.action === 'verified') {
    lines.push('Everything is encrypted already; the master key matches. Nothing to do.');
    return `${lines.join('\n')}\n`;
  }
  const report = result.report;
  if (result.action === 'dry-run' && report) {
    const left = plaintextRemaining(report);
    lines.push('Still in plaintext:');
    lines.push(
      `  documents     ${formatNumber(report.documents.plaintext)} of ${formatNumber(report.documents.scanned)} (${formatByteSize(report.documents.plaintextBytes)})`
    );
    lines.push(
      `  log streams   ${formatNumber(report.streams.plaintext)} of ${formatNumber(report.streams.scanned)} (${formatNumber(report.records)} records, ${formatByteSize(report.streams.plaintextBytes)})`
    );
    lines.push(
      `  spill blobs   ${formatNumber(report.spillBlobs.plaintext)} of ${formatNumber(report.spillBlobs.scanned)} (${formatByteSize(report.spillBlobs.plaintextBytes)})`
    );
    lines.push(
      `  blobs         ${formatNumber(report.blobs.plaintext)} of ${formatNumber(report.blobs.scanned)}`
    );
    lines.push(
      `  files         ${formatNumber(report.files.plaintext)} of ${formatNumber(report.files.scanned)} (${formatByteSize(report.files.plaintextBytes)}; agent artifacts, memory, inboxes, tool-job results, short links)`
    );
    if (report.documents.unreadable > 0) {
      lines.push(
        `  unreadable    ${formatNumber(report.documents.unreadable)} documents are not readable in any form and would be left as they are`
      );
    }
    lines.push(
      `Free space      ${result.freeBytes === null ? 'unknown' : formatByteSize(result.freeBytes)} free, about ${formatByteSize(result.neededBytes)} needed`
    );
    lines.push(
      `Estimate        about ${formatNumber(result.estimateSeconds)} s on a local disk; 10 to 20 times that on a network volume`
    );
    if (report.blobs.plaintextBytes > 0) {
      lines.push(`  blob bytes    ${formatByteSize(report.blobs.plaintextBytes)}`);
    }
    if (result.remoteBlobs && result.remoteBlobs.status !== 'recorded') {
      lines.push(
        `  bucket blobs  ${formatNumber(result.remoteBlobs.plaintext || 0)} of ${formatNumber(result.remoteBlobs.scanned || 0)} (${formatByteSize(result.remoteBlobs.plaintextBytes || 0)}) in ${result.remoteBlobs.target}`
      );
    }
    if (result.localPlaintextBlobs > 0) {
      lines.push(
        `  local blobs   ${formatNumber(result.localPlaintextBlobs)} plaintext blob files left in the data directory are not used any more and are not encrypted`
      );
    }
    lines.push(
      result.masterKey === 'absent'
        ? 'Master key      none yet; nothing was created. The first start, or this command without --dry-run, creates contents/.encryption-key'
        : 'Master key      present and usable'
    );
    if (result.stateRecordMissing) {
      lines.push(
        'State record    missing although encrypted data exists; it is written again when no plaintext is found'
      );
    }
    if (result.plaintextStores?.length > 0) {
      lines.push(`Not covered     ${result.plaintextStores.join(', ')} (stay in plaintext)`);
    }
    const total =
      left.blobs + left.documents + left.logs + left.files + (result.remoteBlobs?.plaintext || 0);
    lines.push(
      total === 0
        ? 'Nothing is left to encrypt. Nothing was changed.'
        : 'Dry run: nothing was changed. Run without --dry-run, with the server stopped, to encrypt.'
    );
    return `${lines.join('\n')}\n`;
  }
  if (result.action === 'aborted') {
    lines.push(
      'Interrupted. What was encrypted stays encrypted; run the command again to continue.'
    );
    return `${lines.join('\n')}\n`;
  }
  const converted = result.state?.converted || {};
  lines.push('Encrypted now:');
  lines.push(`  documents     ${formatNumber(converted.documents || 0)}`);
  lines.push(`  log streams   ${formatNumber(converted.streams || 0)}`);
  lines.push(`  spill blobs   ${formatNumber(converted.spillBlobs || 0)}`);
  lines.push(`  blobs         ${formatNumber(converted.blobs || 0)}`);
  lines.push(`  files         ${formatNumber(converted.files || 0)}`);
  if (result.remoteBlobs) {
    lines.push(
      `  bucket blobs  ${formatNumber(result.remoteBlobs.converted || 0)} (${result.remoteBlobs.target}; key check object ${result.remoteBlobs.keyCheck || 'checked before'})`
    );
  }
  if (result.localPlaintextBlobs > 0) {
    lines.push(
      `  local blobs   ${formatNumber(result.localPlaintextBlobs)} plaintext blob files left in the data directory were NOT encrypted: they are not used any more; remove contents/data/blobs once the copy in the bucket is checked`
    );
  }
  if (result.state?.skipped > 0) {
    lines.push(
      `  unreadable    ${formatNumber(result.state.skipped)} objects were left as they are (see the log)`
    );
  }
  if (result.plaintextStores?.length > 0) {
    lines.push(`Not covered     ${result.plaintextStores.join(', ')} (stay in plaintext)`);
  }
  lines.push(
    result.enabled
      ? 'Done. The stored data is encrypted; start the server.'
      : 'Done. Set storage.encryption.enabled to true in contents/config/platform.json before the next start; with the switch off the server writes plaintext again.'
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The command.
 *
 * @param {string[]} [argv] - Arguments after the script name.
 * @param {Object} [io]
 * @param {(text: string) => void} [io.out] - Receives the output.
 * @param {Object} [io.env]
 * @param {AbortSignal} [io.signal]
 * @param {() => Promise<Object>} [io.loadKeys] - Key module (tests).
 * @param {Object} [io.platformConfig] - Platform configuration (tests).
 * @returns {Promise<number>} Exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  {
    out = text => process.stdout.write(text),
    env = process.env,
    signal,
    loadKeys,
    platformConfig
  } = {}
) {
  const { flags, unknown } = parseFlags(argv, ['dry-run', 'json', 'verbose', 'help']);
  if (flags.help || unknown.length > 0) {
    out(unknown.length > 0 ? `Unknown argument: ${unknown.join(' ')}\n\n${USAGE}` : USAGE);
    return flags.help && unknown.length === 0 ? 0 : 2;
  }
  quietServerLog(flags.verbose === true);
  let result;
  try {
    result = await prepareStorageEncryption({
      platformConfig: platformConfig || (await loadPlatformConfigFromDisk()),
      env,
      dryRun: flags['dry-run'] === true,
      force: true,
      // The command, not a server start, is what encrypts blobs in a bucket,
      // and it does not wait for another process that is converting.
      convertRemoteBlobs: true,
      leaseWaitMs: 0,
      signal,
      ...(loadKeys ? { loadKeys } : {}),
      onLog: flags.json ? undefined : line => out(`${line}\n`)
    });
  } catch (error) {
    out(
      flags.json
        ? `${JSON.stringify({ status: 'error', error: { code: error.code || 'ERROR', detail: error.message } })}\n`
        : `The stored data could not be encrypted: ${error.message}\n`
    );
    return 1;
  }
  out(flags.json ? `${JSON.stringify(result, null, 2)}\n` : formatEncryptResult(result));
  return result.action === 'aborted' || result.action === 'unsupported' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { runAtRestCommand } = await import('./atRestCli.js');
  await runAtRestCommand(main);
}
