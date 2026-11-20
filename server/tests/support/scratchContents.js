// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Points the server code under test at a scratch contents directory, as a
 * side effect of being imported.
 *
 * Why it exists: `server/config.js` reads `CONTENTS_DIR` once, when it is first
 * loaded, and almost every server module loads it. Static `import` statements
 * are evaluated before the body of the importing module, so a test that writes
 *
 * ```js
 * import { fixedKeys } from './support/blobTestSupport.js'; // loads config.js
 * process.env.CONTENTS_DIR = scratch;                       // too late
 * ```
 *
 * runs against the real `contents/` of the checkout: it creates or reads the
 * installation's `contents/.encryption-key` and looks at the developer's data.
 *
 * How to use it: make it the **first** import of every test file (and of every
 * support module) that loads server code. Import order is evaluation order, so
 * nothing can load `config.js` before the variable is set:
 *
 * ```js
 * import { contentsDir } from './support/scratchContents.js'; // first
 * import { fixedKeys } from './support/blobTestSupport.js';
 * ```
 *
 * What it does, once per process:
 * 1. creates a temporary directory and sets `CONTENTS_DIR` to `<tmp>/contents`,
 * 2. removes `TOKEN_ENCRYPTION_KEY` and `TOKEN_ENCRYPTION_KEY_PREVIOUS` from
 *    the environment, so that a key from the developer's shell is not used,
 * 3. loads `server/config.js` and fails when the server does not use the
 *    scratch directory (the guard: it means something loaded server code
 *    before this module, and the test would write into the real `contents/`),
 * 4. removes the temporary directory when the process ends.
 *
 * A test that needs more scratch space puts it below `scratchRoot`, or makes a
 * directory of its own; only the contents directory has to be this one.
 *
 * The runner checks the result from the outside as well: see
 * `scripts/lib/realContentsGuard.js`.
 *
 * @module tests/support/scratchContents
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The temporary directory of this process; removed when the process ends. */
export const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-test-contents-'));

/** The contents directory the server code under test uses (`CONTENTS_DIR`). */
export const contentsDir = path.join(scratchRoot, 'contents');

/** Its data directory (`contents/data`), where the storage layer writes. */
export const dataDir = path.join(contentsDir, 'data');

fs.mkdirSync(contentsDir, { recursive: true });
process.env.CONTENTS_DIR = contentsDir;
delete process.env.TOKEN_ENCRYPTION_KEY;
delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

process.once('exit', () => {
  try {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temporary directory is not worth a failed run.
  }
});

// Loaded here, after the variable is set, and on purpose not as a static
// import: a static import would be evaluated before the lines above.
const { default: config } = await import('../../config.js');

/**
 * Fail when the server code does not use the scratch directory.
 *
 * It runs once when this module is imported. A test may call it again after
 * its own imports to document the requirement.
 *
 * @throws {assert.AssertionError} When `server/config.js` was loaded with
 *   another contents directory.
 */
export function assertScratchContents() {
  assert.equal(
    config.CONTENTS_DIR,
    contentsDir,
    'The server configuration was loaded before tests/support/scratchContents.js, so the code ' +
      'under test would use the real contents/ directory. Make scratchContents.js the first ' +
      'import of the test file and of every support module it imports.'
  );
}

assertScratchContents();
