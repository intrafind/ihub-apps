// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for update-restart.test.js: mirrors how server.js wires
 * utils/processRestart.js, in single-process mode ("single") and as a cluster
 * whose worker asks for the restart ("cluster").
 */
import cluster from 'node:cluster';
import {
  RESTART_MESSAGE_KEY,
  getShutdownExitCode,
  requestServerRestart,
  setShutdownExitCode
} from '../../utils/processRestart.js';

const mode = process.argv[2];

if (mode === 'single') {
  process.on('SIGTERM', () => {
    // server.js drains here, then exits with the shutdown exit code.
    setTimeout(() => process.exit(getShutdownExitCode()), 10);
  });
  requestServerRestart({ delayMs: 0 });
  setTimeout(() => process.exit(1), 10_000);
} else if (cluster.isPrimary) {
  const workers = [cluster.fork(), cluster.fork()];
  let shuttingDown = false;
  cluster.on('exit', () => {
    if (shuttingDown && workers.every(w => w.isDead())) process.exit(getShutdownExitCode());
  });
  cluster.on('message', (_worker, message) => {
    if (!message || typeof message !== 'object' || !(RESTART_MESSAGE_KEY in message)) return;
    setShutdownExitCode(Number(message[RESTART_MESSAGE_KEY]));
    shuttingDown = true;
    for (const w of workers) w.kill('SIGTERM');
  });
  setTimeout(() => process.exit(1), 10_000);
} else {
  process.on('SIGTERM', () => process.exit(0));
  if (cluster.worker.id === 1) requestServerRestart({ delayMs: 50 });
  setInterval(() => {}, 1000);
}
