/**
 * Where things under the contents directory live.
 *
 * `CONTENTS_DIR` renames the contents directory, and everything the server
 * reads and writes there has to agree on it. Spelling `'contents'` out at a
 * call site is how an admin save reported success while landing in a
 * directory the server never reads from, so every path under the contents
 * directory is built here.
 *
 * @module utils/contentsPath
 */
import path from 'path';
import config from '../config.js';
import { getRootDir } from '../pathUtils.js';

/**
 * Absolute path of the contents directory, or of a path inside it.
 *
 * Resolved per call rather than at import time, so a test that points
 * `getRootDir()` somewhere else sees the change.
 *
 * @param {...string} segments - Path segments below the contents directory.
 * @returns {string} Absolute path.
 */
export function getContentsPath(...segments) {
  return path.join(getRootDir(), config.CONTENTS_DIR, ...segments);
}

/**
 * A path inside the contents directory, relative to the installation root.
 *
 * `localAuth.usersFile` and `oauth.clientsFile` are configured relative to the
 * installation root, so their fallbacks have to be too — and they still have
 * to follow `CONTENTS_DIR`.
 *
 * @param {...string} segments - Path segments below the contents directory.
 * @returns {string} `/`-separated root-relative path.
 */
export function contentsRelativePath(...segments) {
  return path
    .relative(getRootDir(), getContentsPath(...segments))
    .split(path.sep)
    .join('/');
}

/**
 * The OAuth client store, as configured or with the shipped default applied.
 *
 * @param {Object} [oauthConfig] - The platform's `oauth` section.
 * @returns {string} Path relative to the installation root, or absolute.
 */
export function oauthClientsFile(oauthConfig) {
  return oauthConfig?.clientsFile || contentsRelativePath('config', 'oauth-clients.json');
}

/**
 * The local user database, as configured or with the shipped default applied.
 *
 * @param {Object} [localAuthConfig] - The platform's `localAuth` section.
 * @returns {string} Path relative to the installation root, or absolute.
 */
export function localUsersFile(localAuthConfig) {
  return localAuthConfig?.usersFile || contentsRelativePath('config', 'users.json');
}
