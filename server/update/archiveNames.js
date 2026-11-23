// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Release archive names, shared by the release workflow
 * (`.github/workflows/build-binaries.yml` runs `scripts/update-archive-name.js`)
 * and the updater. The updater before 5.6.2 looked for `-windows.tar.gz`, which
 * the workflow did not publish (it publishes `-win.zip`), so a Windows install
 * could not find its own update. {@link getLegacyUpdaterArchiveName} names that
 * archive, which the workflow still publishes for those installations.
 *
 * @module update/archiveNames
 */

/**
 * Per updater platform: the suffix the workflow's build matrix uses and the
 * archive format it publishes.
 */
export const RELEASE_ARCHIVES = Object.freeze({
  linux: Object.freeze({ suffix: 'linux', extension: '.tar.gz' }),
  macos: Object.freeze({ suffix: 'macos', extension: '.tar.gz' }),
  windows: Object.freeze({ suffix: 'win', extension: '.zip' })
});

/**
 * Archives published for installations whose updater predates 5.6.2. That
 * updater only looks for `ihub-apps-<tag>-<platform>.tar.gz`, with the updater's
 * own platform name, so a platform whose current archive is named differently
 * needs a second archive with the same files. Linux and macOS already match.
 *
 * Remove an entry once no supported installation updates from a version older
 * than 5.6.2 any more.
 */
const LEGACY_UPDATER_ARCHIVES = Object.freeze({
  windows: Object.freeze({ suffix: 'windows', extension: '.tar.gz' })
});

/** The workflow's matrix value (`win`) → the updater's platform (`windows`). */
const PLATFORM_BY_SUFFIX = Object.freeze(
  Object.fromEntries(Object.entries(RELEASE_ARCHIVES).map(([platform, a]) => [a.suffix, platform]))
);

/** File names the updater accepts as an archive (the base64 variants included). */
export const ARCHIVE_EXTENSIONS = Object.freeze([
  '.tar.gz',
  '.tgz',
  '.zip',
  '.tar.gz.base64.txt',
  '.zip.base64.txt'
]);

/**
 * Normalize a release tag or version to the tag form the release uses (`v5.6.0`).
 * @param {string} tagOrVersion
 * @returns {string}
 */
export function toReleaseTag(tagOrVersion) {
  const value = String(tagOrVersion || '').trim();
  return value.startsWith('v') ? value : `v${value}`;
}

/**
 * Name of the release archive for a platform.
 *
 * @param {string} tagOrVersion - `v5.6.0` or `5.6.0`
 * @param {string} platform - Updater platform (`linux`, `macos`, `windows`) or
 *   the workflow's matrix suffix (`win`)
 * @returns {string} e.g. `ihub-apps-v5.6.0-win.zip`
 */
export function getUpdateArchiveName(tagOrVersion, platform) {
  const resolved = RELEASE_ARCHIVES[platform] ? platform : PLATFORM_BY_SUFFIX[platform];
  if (!resolved) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  const { suffix, extension } = RELEASE_ARCHIVES[resolved];
  return `ihub-apps-${toReleaseTag(tagOrVersion)}-${suffix}${extension}`;
}

/**
 * Name of the extra archive the release publishes for installations that
 * update with the updater of a version before 5.6.2, or `null` when the
 * platform's regular archive is already one that updater finds.
 *
 * @param {string} tagOrVersion - `v5.6.0` or `5.6.0`
 * @param {string} platform - Updater platform or the workflow's matrix suffix
 * @returns {string|null} e.g. `ihub-apps-v5.6.0-windows.tar.gz`
 */
export function getLegacyUpdaterArchiveName(tagOrVersion, platform) {
  const resolved = RELEASE_ARCHIVES[platform] ? platform : PLATFORM_BY_SUFFIX[platform];
  if (!resolved) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  const legacy = LEGACY_UPDATER_ARCHIVES[resolved];
  if (!legacy) return null;
  return `ihub-apps-${toReleaseTag(tagOrVersion)}-${legacy.suffix}${legacy.extension}`;
}

/**
 * Archive format of a file, from its name.
 * @param {string} fileName
 * @returns {{ format: 'tar.gz'|'zip', base64: boolean } | null}
 */
export function detectArchiveFormat(fileName) {
  const name = String(fileName || '').toLowerCase();
  const base64 = name.endsWith('.base64.txt');
  const bare = base64 ? name.slice(0, -'.base64.txt'.length) : name;
  if (bare.endsWith('.tar.gz') || bare.endsWith('.tgz')) return { format: 'tar.gz', base64 };
  if (bare.endsWith('.zip')) return { format: 'zip', base64 };
  return null;
}

/**
 * The platform and version a release archive's name claims, if it follows the
 * release naming. Only a hint: the manifest inside the archive is authoritative.
 *
 * @param {string} fileName
 * @returns {{ platform: string, version: string } | null}
 */
export function parseUpdateArchiveName(fileName) {
  const match =
    /^ihub-apps-v?(.+)-(linux|macos|win|windows)\.(?:tar\.gz|tgz|zip)(?:\.base64\.txt)?$/i.exec(
      String(fileName || '')
    );
  if (!match) return null;
  const suffix = match[2].toLowerCase();
  return { version: match[1], platform: PLATFORM_BY_SUFFIX[suffix] || suffix };
}
