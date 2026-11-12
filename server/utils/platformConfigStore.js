// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one way to change `config/platform.json`.
 *
 * Reading the file, changing a section and writing the whole file back is
 * last-write-wins: two admins saving different sections within a moment (or two
 * workers) lose one of the sections. {@link updatePlatform} does the read, the
 * change and the write as one step through `configStore.updateJson`.
 *
 * Two rules the callers rely on:
 *
 * - It changes the STORED file, never the runtime cache. The cache holds
 *   resolved data (`${ENV}` placeholders expanded, `IHUB_*` overrides applied,
 *   secrets decrypted) and can lag behind another worker's save; writing it
 *   back would bake literal values onto disk and revert other changes.
 * - It encrypts the secrets platform.json keeps encrypted at rest on the way
 *   out, exactly as `ConfigStore.writeJson` does. Values already encrypted, and
 *   `${ENV}` placeholders, stay as they are.
 *
 * `mutate` may run more than once (a conflicting write by another worker
 * re-runs it on a fresh read), so it must derive everything from the body it is
 * handed and have no side effect. Validate before calling.
 */

import configStore from '../services/config/ConfigStore.js';

export const PLATFORM_FILE = 'config/platform.json';

/** Return this from `mutate` to leave the file untouched. */
export const SKIP = Symbol('platform-update-skip');

/**
 * @param {Object|((draft: Object) => Object|void|symbol|Promise<Object|void|symbol>)} change -
 *   Either a patch of top-level keys to overwrite, or a function that gets a
 *   private copy of the stored file and either changes it in place or returns
 *   the replacement. Return {@link SKIP} to write nothing.
 * @param {Object} [options]
 * @param {boolean} [options.create=false] - Allow starting from nothing when the
 *   file does not exist (first run). By default a missing file is an error: every
 *   admin save assumes the installation's platform.json is there, and a stub
 *   built from `{}` would hide a lost file.
 * @returns {Promise<{data: Object, written: boolean}>} The body now stored (as
 *   stored: secrets encrypted) and whether this call wrote it
 */
export async function updatePlatform(change, { create = false } = {}) {
  const mutate =
    typeof change === 'function'
      ? change
      : draft => {
          Object.assign(draft, change);
        };

  // Loaded on demand, as ConfigStore.writeJson does: it pulls in TokenStorageService,
  // which resolves the contents directory when first imported.
  const { encryptPlatformSecrets } = await import('./configSecrets.js');

  const { data, written } = await configStore.updateJson(PLATFORM_FILE, async current => {
    if (current === null || current === undefined) {
      if (!create) throw new Error(`${PLATFORM_FILE} is missing`);
    }
    const draft = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const returned = await mutate(draft);
    if (returned === SKIP) return undefined;
    const next = returned === undefined ? draft : returned;
    return encryptPlatformSecrets(next);
  });
  return { data: data ?? {}, written };
}

export default updatePlatform;
