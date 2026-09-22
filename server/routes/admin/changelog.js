import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError, sendNotFound } from '../../utils/responseHelpers.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { getInstalledVersionRecord, isWithinUpgrade } from '../../utils/installedVersionStore.js';
import {
  RELEASE_SECTIONS,
  UNRELEASED_VERSION,
  countEntries,
  isReleaseVersionName,
  normalizeVersion,
  parseReleaseSections,
  sortVersionsNewestFirst
} from '../../utils/releaseNotes.js';

// Next to package.json / version.txt in every layout: the repo root in development, dist/ in a
// production build (build:releases copies the notes there), the binary's directory when packaged.
const defaultReleasesDir = join(getRootDir(), 'docs', 'releases');

/**
 * Read and parse the three section files of one release directory. A directory may lack any of
 * them — a release with no breaking changes has no `breaking-changes.md`.
 */
async function readReleaseSections(versionDir) {
  const files = {};
  await Promise.all(
    RELEASE_SECTIONS.map(async section => {
      files[section.file] = await fs
        .readFile(join(versionDir, section.file), 'utf8')
        .catch(() => '');
    })
  );
  return parseReleaseSections(files);
}

/**
 * The release directories that exist: `next` and semver-named directories, nothing else.
 * Every path this module opens is built from a name in this list — the filesystem's own
 * listing — so a request can only ever select a directory, never spell one.
 *
 * @param {string} releasesDir
 * @returns {Promise<string[]>} unsorted; empty when the directory does not exist
 */
async function listReleaseVersionNames(releasesDir) {
  try {
    const dirents = await fs.readdir(releasesDir, { withFileTypes: true });
    return dirents
      .filter(dirent => dirent.isDirectory() && isReleaseVersionName(dirent.name))
      .map(dirent => dirent.name);
  } catch {
    // No docs/releases/ next to the server (a build that did not ship it): an empty changelog,
    // not an error.
    return [];
  }
}

/**
 * Every release that has at least one entry, newest first, with `next/` (the notes for changes
 * that have not shipped in a tagged release yet) ahead of the numbered releases. Directories
 * without a single entry are left out, so the empty `next/` scaffold that follows a release
 * does not show up as an unreleased version with nothing in it.
 *
 * `installed` marks the release this server is running. `isNew` marks the releases the last
 * upgrade brought in — everything after the version that was installed before, up to and
 * including the running one — so a jump from 5.4.3 to 5.5.1 flags all six releases in between,
 * not just the one being run. Unreleased changes keep changing and are never new.
 *
 * @param {string} releasesDir
 * @param {{ version?: string|null, previousVersion?: string|null }} [installedVersion]
 * @returns {Promise<Array<{ version: string, unreleased: boolean, installed: boolean, isNew: boolean, counts: Record<string, number> }>>}
 */
export async function loadChangelogIndex(releasesDir, installedVersion = {}) {
  const names = await listReleaseVersionNames(releasesDir);

  const releases = await Promise.all(
    sortVersionsNewestFirst(names).map(async version => {
      const versionDir = join(releasesDir, version);
      const counts = countEntries(await readReleaseSections(versionDir));
      const unreleased = version === UNRELEASED_VERSION;
      return {
        version,
        unreleased,
        installed: !unreleased && version === installedVersion?.version,
        isNew: !unreleased && isWithinUpgrade(version, installedVersion),
        counts
      };
    })
  );
  return releases.filter(release => release.counts.total > 0);
}

/**
 * The entries of one release, per section. `null` when the name is not a release directory or the
 * directory has no entries — the caller answers 404 either way. The requested name only selects
 * one of the directories the listing found; the path is built from that listed name, so the
 * request never contributes a path segment.
 *
 * @param {string} releasesDir
 * @param {string} version directory name: `next` or a semver version
 * @returns {Promise<null | { version: string, unreleased: boolean, sections: Record<string, Array<{ id: string, title: string, body: string }>> }>}
 */
export async function loadChangelogVersion(releasesDir, version) {
  if (!isReleaseVersionName(version)) return null;

  const known = (await listReleaseVersionNames(releasesDir)).find(name => name === version);
  if (!known) return null;

  const versionDir = join(releasesDir, known);
  const parsed = await readReleaseSections(versionDir);
  if (countEntries(parsed).total === 0) return null;

  const sections = {};
  for (const section of RELEASE_SECTIONS) {
    sections[section.key] = parsed[section.key].entries.map(({ id, title, body }) => ({
      id,
      title,
      body
    }));
  }
  return { version: known, unreleased: known === UNRELEASED_VERSION, sections };
}

function currentVersion() {
  try {
    const version = normalizeVersion(getAppVersion());
    return version && version !== 'unknown' ? version : null;
  } catch {
    return null;
  }
}

export default function registerAdminChangelogRoutes(
  app,
  { releasesDir = defaultReleasesDir } = {}
) {
  /**
   * GET /api/admin/changelog
   * The list of releases that have release notes, newest first, with entry counts per section
   * and the `installed` / `isNew` flags, plus the version this server is running and the one it
   * was upgraded from so the UI can show the jump.
   */
  app.get(buildServerPath('/api/admin/changelog'), adminAuth, async (req, res) => {
    try {
      // The running build is authoritative for the current version; the store only contributes
      // what it replaced. They disagree for one boot on an installation whose `contents/data` is
      // not writable, and the running build is the one to trust.
      const installedVersion = {
        ...(await getInstalledVersionRecord()),
        version: currentVersion()
      };
      const versions = await loadChangelogIndex(releasesDir, installedVersion);
      res.json({
        currentVersion: installedVersion.version,
        previousVersion: installedVersion.previousVersion || null,
        versions
      });
    } catch (error) {
      return sendInternalError(res, error, 'fetch changelog');
    }
  });

  /**
   * GET /api/admin/changelog/:version
   * The release notes of one release — `next` for unreleased changes — split into
   * breaking changes, features and fixes, each an array of `{ id, title, body }` entries with the
   * body as Markdown.
   */
  app.get(buildServerPath('/api/admin/changelog/:version'), adminAuth, async (req, res) => {
    try {
      const release = await loadChangelogVersion(releasesDir, req.params.version);
      if (!release) return sendNotFound(res, 'Release');
      res.json(release);
    } catch (error) {
      return sendInternalError(res, error, 'fetch changelog version');
    }
  });
}
