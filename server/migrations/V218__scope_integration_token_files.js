// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V218 — rename single-slot integration token files to the
 * per-provider layout
 *
 * Release 5.3.13 scoped the stored tokens of the cloud-storage providers per
 * provider: `contents/integrations/<service>/<userId>.json` became
 * `<userId>__<providerId>.json`, so one user can connect two tenants of the
 * same service. The server renamed the old files on every start. That rename
 * now happens once, here: an installation that last ran 5.3.0–5.3.12 can still
 * hold single-slot files, an installation at 5.3.13 or later cannot.
 *
 * What is renamed: a `<service>/<userId>.json` whose payload names its
 * `providerId` (in plaintext, or only inside the encrypted blob on older
 * files). What is not touched, on purpose:
 *
 * - Files without a `providerId`. Jira keeps its tokens in one unscoped slot
 *   (`jira/<userId>.json`), and the connection layer adopts an unscoped file of
 *   any other service while it has exactly one installation.
 * - Files that cannot be parsed or decrypted (another key). They are logged so
 *   an operator can decide; the connection layer still reads them through the
 *   unscoped path.
 *
 * If the scoped file already exists, the single-slot duplicate is removed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const version = '218';
export const description = 'scope_integration_token_files';

/** The same safe-name rule `TokenStorageService` applies to file names. */
const SAFE_NAME = /^[A-Za-z0-9._@+-]+$/;

function isSafeName(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && SAFE_NAME.test(value)
  );
}

async function isDirectory(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rename every single-slot token file whose payload names its provider.
 *
 * @param {Object} params
 * @param {string} params.baseDir - Absolute `contents/integrations` directory.
 * @param {(tokenData: Object, userId: string, service: string) => Object} params.decrypt -
 *   Decrypts an encrypted token envelope.
 * @param {{info: Function, warn: Function}} params.log
 * @returns {Promise<{migrated: number, skipped: number}>}
 */
export async function scopeTokenFiles({ baseDir, decrypt, log }) {
  let migrated = 0;
  let skipped = 0;
  let services;
  try {
    services = await fs.readdir(baseDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { migrated, skipped };
    throw error;
  }

  for (const service of services) {
    if (!isSafeName(service)) {
      log.warn(`Skipping integration directory with unsafe name: ${service}`);
      skipped += 1;
      continue;
    }
    const serviceDir = path.join(baseDir, service);
    if (!(await isDirectory(serviceDir))) continue;

    for (const entry of await fs.readdir(serviceDir)) {
      // Scoped files contain the `__` separator already.
      if (!entry.endsWith('.json') || entry.includes('__')) continue;
      const userId = entry.slice(0, -'.json'.length);
      if (!isSafeName(userId)) {
        log.warn(`Skipping legacy token file with unsafe name: ${service}/${entry}`);
        skipped += 1;
        continue;
      }
      const oldPath = path.join(serviceDir, entry);

      let tokenData;
      try {
        tokenData = JSON.parse(await fs.readFile(oldPath, 'utf8'));
      } catch (error) {
        log.warn(`Skipping unparseable token file ${service}/${entry}: ${error.message}`);
        skipped += 1;
        continue;
      }

      let providerId = tokenData?.providerId || null;
      if (!providerId) {
        try {
          providerId = decrypt(tokenData, userId, service)?.providerId || null;
        } catch (error) {
          log.warn(`Skipping token file ${service}/${entry}: ${error.message}`);
          skipped += 1;
          continue;
        }
      }
      // No providerId: an intentionally unscoped slot (Jira), left as it is.
      if (!providerId || !isSafeName(providerId)) {
        if (providerId) log.warn(`Skipping token file ${service}/${entry}: unsafe providerId`);
        skipped += 1;
        continue;
      }

      const newPath = path.join(serviceDir, `${userId}__${providerId}.json`);
      if (path.dirname(path.resolve(newPath)) !== path.resolve(serviceDir)) {
        skipped += 1;
        continue;
      }
      try {
        await fs.access(newPath);
        // The scoped file exists (a partial earlier rename): converge.
        await fs.unlink(oldPath);
        migrated += 1;
        continue;
      } catch {
        // scoped path does not exist yet
      }
      await fs.rename(oldPath, newPath);
      migrated += 1;
    }
  }
  return { migrated, skipped };
}

export async function precondition(ctx) {
  return (await ctx.listFiles('integrations')).length > 0;
}

export async function up(ctx) {
  // Loaded here, not at the top of the file: the runner imports every
  // migration module to read its version, and most installs never get here.
  const { default: tokenStorage } = await import('../services/TokenStorageService.js');
  await tokenStorage.initializeEncryptionKey();
  const result = await scopeTokenFiles({
    baseDir: path.join(ctx.contentsDir, 'integrations'),
    decrypt: (data, userId, service) => tokenStorage.decryptTokens(data, userId, service),
    log: { info: ctx.log, warn: ctx.warn }
  });
  if (result.migrated || result.skipped) {
    ctx.log(
      `Integration token files: ${result.migrated} renamed to the per-provider layout, ` +
        `${result.skipped} left as they are`
    );
  }
}
