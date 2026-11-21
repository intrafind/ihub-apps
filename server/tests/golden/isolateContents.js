// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Point the contents directory of this process at an empty temporary
 * directory. Imported for its effect, as the first import of `harness.js`.
 *
 * Part of what a run writes does not go through the storage provider: the
 * usage event log, for one, is written under `contents/data/`. Without this a
 * recording would read the usage records of earlier runs on the developer's
 * machine, and add its own to them.
 *
 * `server/config.js` reads `CONTENTS_DIR` once, when it is first imported, so
 * this has to run before any module of the server is loaded. `harness.js`
 * checks that it did.
 *
 * @module tests/golden/isolateContents
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The contents directory of this process. Removed when the process ends. */
export const GOLDEN_CONTENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-golden-contents-'));

process.env.CONTENTS_DIR = GOLDEN_CONTENTS_DIR;
process.once('exit', () => fs.rmSync(GOLDEN_CONTENTS_DIR, { recursive: true, force: true }));
