/**
 * Where a configured configuration file lives — as a cache key, an absolute
 * path, and a contents-relative path when it has one.
 *
 * Two settings name a file by path rather than by id: `localAuth.usersFile`
 * and `oauth.clientsFile`. Both are read through `configCache`, written through
 * `configStore` when they live under `contents/` and written directly when they
 * do not, and both had their own copy of the rule that decides which. Two
 * copies of a four-branch rule is a coin toss on whether they keep agreeing,
 * and a disagreement between the read path and the write path is a file that is
 * written in one place and read from another.
 *
 * @module utils/configFileLocation
 */
import path from 'path';
import serverConfig from '../config.js';
import { getRootDir } from '../pathUtils.js';

/**
 * Resolve a configured configuration file path.
 *
 * A path outside `contents/` is supported — the tests use a temporary
 * directory, and an operator may keep the file on a mounted secret volume — so
 * `relPath` is null for one and the caller writes `fullPath` directly.
 * Relocating such a file into `contents/` would silently strand everything in
 * it.
 *
 * Containment is decided against the **contents directory**, not the
 * installation root. Deciding it against the root is what let a relative path
 * such as `secrets/users.json` be judged contained: `configStore.writeJson`
 * resolves every relative path under `contents/`, so the file was written to
 * `<contents>/secrets/users.json` while it went on being read from
 * `<root>/secrets/users.json` — and after a restart, with the cache cold, an
 * account created or a password reset before it was simply gone. It also
 * honours `CONTENTS_DIR`, so an installation that renamed its contents
 * directory is no longer told that `contents/config/users.json` is inside it.
 *
 * @param {string} configuredPath - The path as configured: relative to the
 *   installation root, or absolute.
 * @returns {{fullPath: string, cacheKey: string, relPath: string|null}}
 *   `fullPath` is absolute; `cacheKey` addresses the file in `configCache`;
 *   `relPath` addresses it in the configuration store, or is null when the file
 *   lives outside `contents/`.
 */
export function locateConfigFile(configuredPath) {
  const rootDir = getRootDir();
  const contentsDir = path.join(rootDir, serverConfig.CONTENTS_DIR);
  const fullPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(rootDir, configuredPath);

  // `path.relative` answers '' for the directory itself, which is not a file.
  const fromContents = path.relative(contentsDir, fullPath);
  const contained =
    !!fromContents && !path.isAbsolute(fromContents) && !fromContents.startsWith('..');
  // Always `/`-separated: it addresses a document in the store, not a path on
  // this host, and the store's keys are the same on every platform.
  const relPath = contained ? fromContents.split(path.sep).join('/') : null;

  // Contained files are cached under the key the store addresses them by, so
  // the preload that warms `config/users.json` and a save that announces it
  // name the same entry. For the rest, the root-relative path is a stable name
  // that the read and the write both derive from the same `fullPath`.
  const cacheKey = relPath ?? path.relative(rootDir, fullPath).split(path.sep).join('/');

  return { fullPath, cacheKey, relPath };
}

export default locateConfigFile;
