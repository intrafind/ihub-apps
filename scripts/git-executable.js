// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The git binary the check scripts run. Looked up in fixed install locations
 * (or `GIT_EXECUTABLE`), never through `PATH`, so a writable directory earlier on
 * `PATH` cannot substitute another program.
 */

import fs from 'node:fs';

const LOCATIONS = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`
];

export function gitExecutable() {
  const found = [process.env.GIT_EXECUTABLE, ...LOCATIONS].find(p => p && fs.existsSync(p));
  if (!found) {
    throw new Error(`git not found in ${LOCATIONS.join(', ')}; set GIT_EXECUTABLE to its path`);
  }
  return found;
}
