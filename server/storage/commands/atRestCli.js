// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Runs one of the encryption commands (`npm run storage:encrypt`,
 * `npm run storage:show`) as a process: the command's output goes to stdout,
 * the server's log lines to stderr, and the process ends with the command's
 * exit code.
 *
 * @module storage/commands/atRestCli
 */

/**
 * Run a command's `main` and end the process.
 *
 * @param {(argv: string[], io: {out: Function, signal: AbortSignal}) => Promise<number>} main
 * @param {string[]} [argv] - Arguments after the script name.
 * @returns {Promise<never>}
 */
export async function runAtRestCommand(main, argv = process.argv.slice(2)) {
  // The logger prints to stdout; keep stdout for the command's own output.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = stderrWrite;
  const interrupt = new AbortController();
  // Ctrl+C stops after the object in flight; the next run continues.
  process.once('SIGINT', () => interrupt.abort());
  let code = 1;
  try {
    code = await main(argv, { out: text => stdoutWrite(text), signal: interrupt.signal });
  } catch (error) {
    stderrWrite(`The command failed: ${error?.message || error}\n`);
  }
  await new Promise(resolve => stdoutWrite('', resolve));
  await new Promise(resolve => stderrWrite('', resolve));
  process.exit(code);
}
