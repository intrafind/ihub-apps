// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The npm CLI script the check scripts run, with `process.execPath`. Found
 * next to the running Node installation (or at `NPM_CLI_JS`), never through
 * `PATH`, so a writable directory earlier on `PATH` cannot substitute another
 * program.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Where npm's `npm-cli.js` sits relative to a Node binary: under
 * `lib/node_modules` on Unix installs, next to `node.exe` on Windows.
 *
 * @param {string} nodePath - The Node binary (`process.execPath`)
 * @returns {string[]}
 */
export function npmCliLocations(nodePath) {
  const bin = path.dirname(nodePath);
  return [
    path.join(path.dirname(bin), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
}

export function npmCli() {
  const locations = npmCliLocations(process.execPath);
  const found = [process.env.NPM_CLI_JS, ...locations].find(p => p && fs.existsSync(p));
  if (!found) {
    throw new Error(`npm not found in ${locations.join(', ')}; set NPM_CLI_JS to npm-cli.js`);
  }
  return found;
}
