import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError, sendNotFound } from '../../utils/responseHelpers.js';
import { getAppVersion } from '../../utils/versionHelper.js';
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
 * Every release that has at least one entry, newest first, with `next/` (the notes for changes
 * that have not shipped in a tagged release yet) ahead of the numbered releases. Directories
 * without a single entry are left out, so the empty `next/` scaffold that follows a release
 * does not show up as an unreleased version with nothing in it.
 *
 * @param {string} releasesDir
 * @returns {Promise<Array<{ version: string, unreleased: boolean, counts: Record<string, number> }>>}
 */
export async function loadChangelogIndex(releasesDir) {
  let names;
  try {
    const dirents = await fs.readdir(releasesDir, { withFileTypes: true });
    names = dirents
      .filter(dirent => dirent.isDirectory() && isReleaseVersionName(dirent.name))
      .map(dirent => dirent.name);
  } catch {
    // No docs/releases/ next to the server (a build that did not ship it): an empty changelog,
    // not an error.
    return [];
  }

  const releases = await Promise.all(
    sortVersionsNewestFirst(names).map(async version => {
      const versionDir = join(releasesDir, version);
      const counts = countEntries(await readReleaseSections(versionDir));
      return { version, unreleased: version === UNRELEASED_VERSION, counts };
    })
  );
  return releases.filter(release => release.counts.total > 0);
}

/**
 * The entries of one release, per section. `null` when the name is not a release directory or the
 * directory has no entries — the caller answers 404 either way, and a name that is not a version
 * never reaches the filesystem.
 *
 * @param {string} releasesDir
 * @param {string} version directory name: `next` or a semver version
 * @returns {Promise<null | { version: string, unreleased: boolean, sections: Record<string, Array<{ id: string, title: string, body: string }>> }>}
 */
export async function loadChangelogVersion(releasesDir, version) {
  if (!isReleaseVersionName(version)) return null;

  const versionDir = join(releasesDir, version);
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
  return { version, unreleased: version === UNRELEASED_VERSION, sections };
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
   * The list of releases that have release notes, newest first, with entry counts per section,
   * plus the version this server is running so the UI can mark it.
   */
  app.get(buildServerPath('/api/admin/changelog'), adminAuth, async (req, res) => {
    try {
      const versions = await loadChangelogIndex(releasesDir);
      res.json({ currentVersion: currentVersion(), versions });
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
