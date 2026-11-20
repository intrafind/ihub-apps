#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Entry point of the storage commands, for `npm run storage:check` and
 * `npm run storage:copy-blobs` and for an installation that ships only the
 * `server/` directory (the container image):
 *
 *     node server/storage/commands/run.js check [--json]
 *     node server/storage/commands/run.js copy-blobs [--dry-run]
 *
 * @module storage/commands/run
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Command name → module that exports `main(argv, io)`. */
const COMMANDS = Object.freeze({
  check: './storageCheck.js',
  'copy-blobs': './copyBlobs.js'
});

/**
 * Run one storage command and end the process with its exit code.
 *
 * The process is ended explicitly: modules the commands load keep timers and
 * connections that would otherwise hold it open.
 *
 * @param {string} name - `check` or `copy-blobs`.
 * @param {string[]} argv - Arguments of the command.
 * @returns {Promise<never>}
 */
export async function runCommand(name, argv) {
  // The report goes to stdout and nothing else does: the server's logger
  // prints to stdout, so its lines are sent to stderr for this process.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = stderrWrite;

  let code = 2;
  if (!Object.hasOwn(COMMANDS, name)) {
    stderrWrite(
      `Usage: node server/storage/commands/run.js <${Object.keys(COMMANDS).join('|')}> [options]\n`
    );
  } else {
    const interrupt = new AbortController();
    // Ctrl+C stops after the blob in flight, so the summary is still printed.
    process.once('SIGINT', () => interrupt.abort());
    try {
      const { main } = await import(COMMANDS[name]);
      code = await main(argv, { out: text => stdoutWrite(text), signal: interrupt.signal });
    } catch (error) {
      stderrWrite(`The command failed: ${error?.message || error}\n`);
      code = 1;
    }
  }
  // Let both streams drain before leaving: a pipe may still hold the report.
  await new Promise(resolve => stdoutWrite('', resolve));
  await new Promise(resolve => stderrWrite('', resolve));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCommand(process.argv[2], process.argv.slice(3));
}
