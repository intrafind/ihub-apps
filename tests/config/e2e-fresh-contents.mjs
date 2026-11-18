// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The e2e server rewrites its contents directory (rate limits, the AI notice,
 * registries) and, with `E2E_FRESH_CONTENTS=1`, deletes it before a run. A
 * mistyped `E2E_CONTENTS_DIR` (for example `contents`) would then change or
 * wipe a developer's real configuration, including `.encryption-key`. Only a
 * directory inside the repository whose name starts with `contents-e2e` is
 * ever used, also when a parent on the way is a symlink out of the repository
 * or the directory itself is a symlink to `contents/`.
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
 * @throws {Error} When the directory is outside `root` (also through a
 *   symlinked parent), not named `contents-e2e*` (by its own name and by the
 *   real name a symlink points to), or is or lies in the real `contents/`
 *
 * @example
 * disposableContentsPath('/repo', 'contents-e2e-safety'); // '/repo/contents-e2e-safety'
 * disposableContentsPath('/repo', 'contents'); // throws
 */
export function disposableContentsPath(root, contentsDir) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, contentsDir);
  const canonicalRoot = canonicalPath(resolvedRoot);
  const canonicalTarget = canonicalPath(target);
  // The real `contents/`, also reached through a symlink such as
  // `contents-e2e -> contents`: the name alone would let that through.
  const realContents = canonicalPath(path.join(resolvedRoot, 'contents'));
  if (
    !isStrictlyInside(resolvedRoot, target) ||
    !isStrictlyInside(canonicalRoot, canonicalTarget) ||
    !path.basename(target).startsWith(DISPOSABLE_CONTENTS_PREFIX) ||
    !path.basename(canonicalTarget).startsWith(DISPOSABLE_CONTENTS_PREFIX) ||
    canonicalTarget === realContents ||
    isStrictlyInside(realContents, canonicalTarget)
  ) {
    throw new Error(
      `E2E_CONTENTS_DIR must be a directory inside the repository named ${DISPOSABLE_CONTENTS_PREFIX}*, which the e2e run rewrites and may delete; refusing to delete or rewrite "${contentsDir}".`
    );
  }
  return target;
}

/**
 * The validated `E2E_CONTENTS_DIR` of an environment (default `contents-e2e`).
 * The e2e server calls it before it touches the directory, whether or not
 * `E2E_FRESH_CONTENTS` is set.
 *
 * @param {string} root - The repository root
 * @param {Record<string, string|undefined>} env - Usually `process.env`
 * @returns {string} The directory name, relative to `root`
 * @throws {Error} See {@link disposableContentsPath}
 */
export function e2eContentsDir(root, env) {
  const contentsDir = env.E2E_CONTENTS_DIR || DISPOSABLE_CONTENTS_PREFIX;
  disposableContentsPath(root, contentsDir);
  return contentsDir;
}

/** @returns {boolean} Whether `target` lies below `base` (not equal to it) */
function isStrictlyInside(base, target) {
  const fromBase = path.relative(base, target);
  return fromBase !== '' && !fromBase.startsWith('..') && !path.isAbsolute(fromBase);
}

/**
 * The path with every symlink in its existing part resolved: the real path of
 * the deepest existing ancestor, plus the segments that do not exist yet. A
 * directory that is still to be created is therefore fine, while a parent
 * that links out of the repository is seen for where it points.
 *
 * @param {string} absolutePath
 * @returns {string}
 */
function canonicalPath(absolutePath) {
  const missing = [];
  let existing = absolutePath;
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(existing);
      if (error.code !== 'ENOENT' || parent === existing) throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
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
