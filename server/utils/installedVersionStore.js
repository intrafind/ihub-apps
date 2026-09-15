import path from 'path';
import { promises as fs } from 'fs';
import { atomicWriteJSON } from './atomicWrite.js';
import logger from './logger.js';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import { compareVersions, normalizeVersion } from './releaseNotes.js';
import { getAppVersion } from './versionHelper.js';

/**
 * Which version this installation ran before the one it is running now.
 *
 * The changelog needs it: an admin who upgrades 5.4.3 → 5.5.1 wants every release in between
 * marked as new, not just the one they happen to be running. Nothing else in the server knows
 * what came before — `getAppVersion()` only ever reports the build that is running — so the
 * version is written down once per boot and the previous one is kept beside it.
 *
 * Stored at `contents/data/installed-version.json`:
 *
 *   {
 *     "version": "5.5.1",           // the version running now
 *     "previousVersion": "5.4.3",   // what it replaced; null on a fresh installation
 *     "firstSeenAt": "2026-09-15T09:12:44.000Z",   // when `version` first started here
 *     "previousFirstSeenAt": "2026-06-02T07:31:10.000Z"
 *   }
 *
 * A downgrade is recorded like any other change: `previousVersion` is simply newer than
 * `version`, and the changelog's upgrade range comes out empty, which is what it should be.
 *
 * @module installedVersionStore
 */

const STORE_PATH = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'installed-version.json');

const EMPTY_RECORD = Object.freeze({
  version: null,
  previousVersion: null,
  firstSeenAt: null,
  previousFirstSeenAt: null
});

/** Set by {@link recordInstalledVersion} so request handlers do not read the file per request. */
let cachedRecord = null;

function normalize(value) {
  const version = normalizeVersion(value);
  return version && version !== 'unknown' ? version : null;
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      version: normalize(parsed.version),
      previousVersion: normalize(parsed.previousVersion),
      firstSeenAt: typeof parsed.firstSeenAt === 'string' ? parsed.firstSeenAt : null,
      previousFirstSeenAt:
        typeof parsed.previousFirstSeenAt === 'string' ? parsed.previousFirstSeenAt : null
    };
  } catch {
    // Missing (a first start) or corrupt (hand-edited, a half-written file from a crashed
    // release): either way this boot writes a fresh record rather than failing.
    return null;
  }
}

/**
 * Record the version that is running and remember the one it replaced.
 *
 * Call once per process at startup. Every cluster worker may call it: the record each one would
 * write is identical — they all read the same file and run the same build — and
 * {@link atomicWriteJSON} replaces the file by rename, so concurrent callers cannot interleave
 * into a partial file. Whoever writes second writes the same bytes.
 *
 * Never throws: an installation whose `contents/data` is read-only keeps running, it just cannot
 * tell the changelog what it upgraded from.
 *
 * @param {string} [version] the running version; defaults to {@link getAppVersion}
 * @returns {Promise<{ version: string|null, previousVersion: string|null, firstSeenAt: string|null, previousFirstSeenAt: string|null }>}
 */
export async function recordInstalledVersion(version = getAppVersion()) {
  const current = normalize(version);
  const stored = await readStore();

  if (!current) {
    // No usable version to record — keep whatever is on disk.
    cachedRecord = stored ?? { ...EMPTY_RECORD };
    return cachedRecord;
  }

  if (stored?.version === current) {
    cachedRecord = stored;
    return cachedRecord;
  }

  const record = {
    version: current,
    previousVersion: stored?.version ?? null,
    firstSeenAt: new Date().toISOString(),
    previousFirstSeenAt: stored?.firstSeenAt ?? null
  };

  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await atomicWriteJSON(STORE_PATH, record);
    if (record.previousVersion) {
      logger.info('Version changed since the last start', {
        component: 'InstalledVersion',
        previousVersion: record.previousVersion,
        version: record.version
      });
    }
  } catch (error) {
    // The in-memory record still describes this boot; only the memory across restarts is lost.
    logger.warn('Could not persist the installed version', {
      component: 'InstalledVersion',
      error
    });
  }

  cachedRecord = record;
  return record;
}

/**
 * The record {@link recordInstalledVersion} produced at startup, or the file's contents when this
 * process never recorded one (a test, a script). Never throws.
 *
 * @returns {Promise<{ version: string|null, previousVersion: string|null, firstSeenAt: string|null, previousFirstSeenAt: string|null }>}
 */
export async function getInstalledVersionRecord() {
  if (cachedRecord) return cachedRecord;
  return (await readStore()) ?? { ...EMPTY_RECORD };
}

/** Test seam: forget what this process recorded. */
export function resetInstalledVersionCache() {
  cachedRecord = null;
}

/**
 * The releases an upgrade brought in: everything newer than the version that was installed
 * before, up to and including the one running now. Empty when nothing is known about the
 * previous version (a fresh installation) and on a downgrade.
 *
 * @param {string} candidate a release version
 * @param {{ version?: string|null, previousVersion?: string|null }} record
 * @returns {boolean}
 */
export function isWithinUpgrade(candidate, record) {
  const version = normalize(candidate);
  const previous = normalize(record?.previousVersion);
  const current = normalize(record?.version);
  if (!version || !previous) return false;
  if (compareVersions(version, previous) <= 0) return false;
  return !current || compareVersions(version, current) <= 0;
}

export const INSTALLED_VERSION_STORE_PATH = STORE_PATH;
