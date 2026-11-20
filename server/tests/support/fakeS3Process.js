// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The in-repo fake S3 server (`./fakeS3Server.js`) in a process of its own.
 *
 * For measurements that must not count what the server holds: in the same
 * process the server's copy of a 100 MiB object is indistinguishable from
 * memory the code under test keeps.
 *
 * @module tests/support/fakeS3Process
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_S3_ACCESS_KEY_ID, FAKE_S3_SECRET_ACCESS_KEY } from './fakeS3Server.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakeS3Server.js');

/** A port nothing listens on at the moment. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the server as a child process and wait until it listens.
 *
 * @param {Object} options
 * @param {string} options.dataDir - Directory the server keeps its objects in.
 * @param {string} [options.bucket='ihub-test'] - The one bucket it has.
 * @returns {Promise<{endpoint: string, bucket: string, accessKeyId: string,
 *   secretAccessKey: string, close: () => Promise<void>}>}
 */
export async function startFakeS3Process({ dataDir, bucket = 'ihub-test' }) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      IHUB_S3_DEV_PORT: String(port),
      IHUB_S3_DEV_BUCKET: bucket,
      IHUB_S3_DEV_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The fake S3 server did not start: ${output}`)),
      15_000
    );
    const onData = chunk => {
      output += chunk;
      if (!output.includes('Press Ctrl+C')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`The fake S3 server exited with code ${code}: ${output}`));
    });
  });
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId: FAKE_S3_ACCESS_KEY_ID,
    secretAccessKey: FAKE_S3_SECRET_ACCESS_KEY,
    close: () =>
      new Promise(resolve => {
        if (child.exitCode !== null) return void resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      })
  };
}
