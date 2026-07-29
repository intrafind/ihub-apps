/**
 * Version Check Service
 *
 * Single place for "is a newer release available?" lookups against the GitHub
 * Releases API. Every caller (Admin UI, update service, update CLI) goes
 * through here so the outbound request is always bounded by a timeout and
 * answered from a short-lived cache.
 *
 * Why (issue #2150): the Admin Overview blocked on
 * `/api/admin/version/check-update`, which fetched api.github.com with no
 * timeout. In deployments without outbound internet access packets are usually
 * dropped rather than refused, so the connection never completes and the
 * request hung until the OS TCP timeout — minutes — leaving the dashboard
 * showing nothing but loading skeletons. The fetch now aborts after a few
 * seconds, both results and failures are cached, and the Admin endpoint answers
 * from that cache while refreshing in the background.
 */
import { publish, subscribe } from '../clusterBus.js';
import { httpFetch } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';

export const GITHUB_REPO = 'intrafind/ihub-apps';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Cluster bus channel carrying a completed check to the other workers. */
const CLUSTER_CHANNEL = 'versionCheck:result';

/** Abort deadline for the GitHub request when not overridden by env. */
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60000;

/** How long a successful lookup is served from cache before it is refreshed. */
export const SUCCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Failures are retried sooner, but not on every single admin page load. */
export const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Last completed check: `{ release, error, checkedAt, expiresAt }`.
 * `null` until the first check completes.
 */
let cacheEntry = null;

/** Promise of the check currently running, so concurrent callers share one request. */
let inFlight = null;

/**
 * Check if remote version checks against GitHub are disabled.
 *
 * Opt-in via `NO_VERSION_CHECK` (or `IHUB_NO_VERSION_CHECK`) for air-gapped
 * deployments, environments where outbound traffic to api.github.com is
 * blocked, or admins who simply don't want the Admin UI to phone home.
 * Not set by default.
 */
export function isVersionCheckDisabled() {
  const value = process.env.NO_VERSION_CHECK || process.env.IHUB_NO_VERSION_CHECK;
  return !!value && /^(1|true|yes|on)$/i.test(value);
}

/**
 * Abort deadline for the GitHub request, in milliseconds.
 *
 * Override with `VERSION_CHECK_TIMEOUT_MS` (or `IHUB_VERSION_CHECK_TIMEOUT_MS`)
 * for slow links or strict proxies. Clamped so a typo can't reintroduce the
 * effectively-unbounded wait this service exists to prevent.
 */
export function getVersionCheckTimeoutMs() {
  const raw = process.env.VERSION_CHECK_TIMEOUT_MS || process.env.IHUB_VERSION_CHECK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;

  const cleanV1 = v1.split('-')[0];
  const cleanV2 = v2.split('-')[0];

  const parts1 = cleanV1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = cleanV2.split('.').map(p => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * An aborted request surfaces differently depending on the fetch implementation:
 * node-fetch raises an `AbortError`, while `AbortSignal.timeout()` itself
 * rejects with a `TimeoutError` DOMException.
 */
function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * Keep only the release fields this codebase reads. GitHub's payload carries the
 * full release notes and a verbose entry per asset; the trimmed shape is what
 * gets cached and relayed to the other workers, so nothing downstream should
 * reach for a field that is not listed here.
 */
function normalizeRelease(release) {
  return {
    tag_name: release.tag_name,
    name: release.name ?? null,
    html_url: release.html_url ?? null,
    published_at: release.published_at ?? null,
    assets: Array.isArray(release.assets)
      ? release.assets.map(asset => ({
          name: asset.name,
          browser_download_url: asset.browser_download_url,
          size: asset.size
        }))
      : []
  };
}

/**
 * Perform the actual GitHub request. Never throws — network problems, HTTP
 * errors and timeouts all come back as `{ error }` so a failed check is just
 * another cacheable outcome.
 *
 * @param {number} timeoutMs
 * @returns {Promise<{ release?: object, error?: string }>}
 */
async function fetchLatestRelease(timeoutMs) {
  try {
    const response = await httpFetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ihub-apps'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return {
        error:
          response.status === 404 ? 'No releases found' : `GitHub API error: ${response.status}`
      };
    }

    const release = await response.json();
    if (!release?.tag_name) {
      return { error: 'Invalid release data from GitHub' };
    }

    return { release: normalizeRelease(release) };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        error: `Version check timed out after ${timeoutMs}ms (api.github.com unreachable?)`
      };
    }
    return { error: `Failed to check for updates: ${error.message}` };
  }
}

/**
 * Run a check (or join the one already running) and cache its outcome.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force] - Ignore a still-valid cache entry.
 * @returns {Promise<{ release: object|null, error: string|null, checkedAt: number, expiresAt: number }>}
 */
export function refreshVersionCheck({ force = false } = {}) {
  if (!force && cacheEntry && cacheEntry.expiresAt > Date.now()) {
    return Promise.resolve(cacheEntry);
  }
  if (inFlight) return inFlight;

  const timeoutMs = getVersionCheckTimeoutMs();
  inFlight = fetchLatestRelease(timeoutMs)
    .then(outcome => {
      const checkedAt = Date.now();
      cacheEntry = {
        release: outcome.release ?? null,
        error: outcome.error ?? null,
        checkedAt,
        expiresAt: checkedAt + (outcome.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS)
      };

      if (outcome.error) {
        logger.warn('Version check failed', {
          component: 'VersionCheck',
          error: outcome.error,
          retryInMs: FAILURE_TTL_MS
        });
      } else {
        logger.debug('Version check completed', {
          component: 'VersionCheck',
          latestTag: outcome.release.tag_name
        });
      }

      // One check warms the whole cluster. Without this each worker would query
      // GitHub separately, and an Admin UI request — distributed round-robin —
      // could keep landing on workers that have not checked yet.
      publish(CLUSTER_CHANNEL, cacheEntry);

      return cacheEntry;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * A relay is adopted only when it is shaped like something this module could
 * have produced: a finite, ordered timestamp pair, and either a release carrying
 * a tag or a non-empty error — never both, never neither.
 *
 * The timestamps carry the sharp edges, and `typeof x === 'number'` is not
 * enough to blunt them, since `NaN` and `Infinity` both pass it:
 *  - `NaN <= Date.now()` is false, as is `undefined <= Date.now()`, so an entry
 *    cached with either expiry would read as fresh forever and that worker would
 *    never check for a new release again.
 *  - `new Date(NaN).toISOString()` throws `RangeError`, which would turn the
 *    admin endpoint's `lastCheckedAt` into a 500.
 *
 * A stale-looking entry is the safe direction — it just triggers a refresh — so
 * `expiresAt` must genuinely follow `checkedAt` to be believed.
 */
function isValidRelay(payload) {
  if (!payload) return false;
  if (!Number.isFinite(payload.checkedAt) || !Number.isFinite(payload.expiresAt)) return false;
  if (payload.expiresAt <= payload.checkedAt) return false;

  const hasRelease = typeof payload.release?.tag_name === 'string';
  const hasError = typeof payload.error === 'string' && payload.error.length > 0;
  return hasRelease !== hasError;
}

/** Adopt a result another worker produced, unless this worker has a newer one. */
subscribe(CLUSTER_CHANNEL, payload => {
  if (!isValidRelay(payload)) {
    logger.debug('Ignoring malformed version-check relay', { component: 'VersionCheck' });
    return;
  }
  if (cacheEntry && cacheEntry.checkedAt >= payload.checkedAt) return;

  cacheEntry = {
    release: payload.release ?? null,
    error: payload.error ?? null,
    checkedAt: payload.checkedAt,
    expiresAt: payload.expiresAt
  };
});

/** Last completed check, or `null` when no check has finished yet. */
export function getVersionCheckEntry() {
  return cacheEntry;
}

/** True when there is no cached check or the cached one has expired. */
export function isVersionCheckStale() {
  return !cacheEntry || cacheEntry.expiresAt <= Date.now();
}

/**
 * Kick off a refresh without waiting for it. Used by request handlers that must
 * answer immediately: they serve whatever is cached (possibly nothing) and let
 * the next request pick up the fresh result.
 *
 * @returns {boolean} True when a check is running after this call, i.e. the
 *   caller's response may be missing or stale and worth re-requesting.
 */
export function startBackgroundVersionCheck() {
  if (inFlight) return true;
  if (!isVersionCheckStale()) return false;

  // fetchLatestRelease() swallows its own failures; catch anyway so an
  // unexpected throw can never become an unhandled rejection.
  refreshVersionCheck().catch(error => {
    logger.debug('Background version check rejected', { component: 'VersionCheck', error });
  });
  return true;
}

/**
 * Shape a cache entry into the update-info payload used by the Admin API, the
 * update service and the CLI.
 *
 * @param {Object|null} entry - Cache entry from `getVersionCheckEntry()`/`refreshVersionCheck()`
 * @param {string} currentVersion - Version this installation is running
 * @param {Object} [options]
 * @param {boolean} [options.checking] - A check is running; the payload may be stale or empty
 */
export function buildUpdateInfo(entry, currentVersion, { checking = false } = {}) {
  const info = {
    updateAvailable: false,
    currentVersion,
    checking,
    lastCheckedAt: entry ? new Date(entry.checkedAt).toISOString() : null
  };

  if (!entry) return info;
  if (entry.error) return { ...info, error: entry.error };
  if (!entry.release?.tag_name) return info; // checked, but nothing usable came back

  const latestVersion = entry.release.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present

  return {
    ...info,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    latestVersion,
    releaseUrl: entry.release.html_url,
    releaseName: entry.release.name,
    publishedAt: entry.release.published_at
  };
}

/** Test seam: drop cached state so each case starts from a cold cache. */
export function resetVersionCheckCache() {
  cacheEntry = null;
  inFlight = null;
}
