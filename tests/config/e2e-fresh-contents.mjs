// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `E2E_FRESH_CONTENTS=1` deletes the e2e contents directory before a run. A
 * mistyped `E2E_CONTENTS_DIR` (for example `contents`) would then wipe a
 * developer's real configuration, including `.encryption-key`. Only a
 * directory inside the repository whose name starts with `contents-e2e` is
 * ever deleted.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Prefix every disposable e2e contents directory name carries. */
export const DISPOSABLE_CONTENTS_PREFIX = 'contents-e2e';

/**
 * The absolute path of `contentsDir` when it is safe to delete, or throws.
 *
 * @param {string} root - The repository root
 * @param {string} contentsDir - `E2E_CONTENTS_DIR`, relative to `root`
 * @returns {string} The absolute path
 * @throws {Error} When the directory is outside `root` or not named `contents-e2e*`
 *
 * @example
 * disposableContentsPath('/repo', 'contents-e2e-safety'); // '/repo/contents-e2e-safety'
 * disposableContentsPath('/repo', 'contents'); // throws
 */
export function disposableContentsPath(root, contentsDir) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, contentsDir);
  const fromRoot = path.relative(resolvedRoot, target);
  const inside = fromRoot !== '' && !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot);
  if (!inside || !path.basename(target).startsWith(DISPOSABLE_CONTENTS_PREFIX)) {
    throw new Error(
      `E2E_FRESH_CONTENTS=1 only deletes a directory inside the repository named ${DISPOSABLE_CONTENTS_PREFIX}*; refusing to delete "${contentsDir}".`
    );
  }
  return target;
}

/**
 * Delete the e2e contents directory for a fresh install, after
 * {@link disposableContentsPath} has confirmed it is one.
 *
 * @param {string} root - The repository root
 * @param {string} contentsDir - `E2E_CONTENTS_DIR`, relative to `root`
 * @returns {void}
 */
export function removeDisposableContents(root, contentsDir) {
  fs.rmSync(disposableContentsPath(root, contentsDir), { recursive: true, force: true });
}
