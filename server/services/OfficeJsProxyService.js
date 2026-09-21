/**
 * Office.js pull-through cache.
 *
 * Serves the Office.js library from this server by fetching it from Microsoft's
 * CDN on first request and caching it on disk. Only the server needs outbound
 * access; the Office client never contacts Microsoft. Unlike bundling the
 * (unmaintained) `@microsoft/office-js` npm package, the cached copy refreshes
 * itself, so deployments do not freeze on the snapshot that shipped with a
 * release.
 *
 * Office.js resolves every file it loads against the base path of its own
 * `<script src>` (see `utils/officeJsSource.js`), so proxying the whole
 * directory at one path is enough — nothing in the library refers to a
 * Microsoft hostname.
 *
 * For air-gapped installs the same cache directory can be pre-populated at
 * install time: when upstream is unreachable, cached files are served
 * regardless of age, so a pre-warmed cache keeps working with no egress at all.
 */

import path from 'path';
import { promises as fs } from 'fs';
import config from '../config.js';
import { getRootDir } from '../pathUtils.js';
import { httpFetch } from '../utils/httpConfig.js';
import { atomicWriteFile } from '../utils/atomicWrite.js';
import { resolveAndValidatePath } from '../utils/pathSecurity.js';
import logger from '../utils/logger.js';

/** Matches the CDN's own `cache-control: max-age=14400`. */
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

/** The largest Office.js payload is well under 1 MB; this is a sanity bound. */
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 30_000;

/** Reachability probes answer an operator waiting on a button, so they are short. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Office.js requests at most two path segments (`en-us/outlook_strings.js`);
 * three leaves headroom without opening the proxy up to arbitrary fetches.
 */
const MAX_PATH_SEGMENTS = 3;
const MAX_SEGMENT_LENGTH = 128;
const MAX_PATH_LENGTH = 256;

/**
 * Each segment must start alphanumeric, which rejects `.`, `..` and dotfiles
 * without needing a separate traversal check.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

/**
 * Validate a path requested under the Office.js proxy mount.
 *
 * The path is attacker-controlled (it arrives as a URL), and is used both to
 * build an upstream URL and a cache file path, so it is validated against an
 * allowlist rather than sanitized.
 *
 * @param {string} relPath - Path relative to the proxy mount, no leading slash
 * @returns {boolean}
 */
export function isSafeOfficeJsAssetPath(relPath) {
  if (typeof relPath !== 'string') return false;
  if (!relPath || relPath.length > MAX_PATH_LENGTH) return false;
  if (relPath.includes('\\') || relPath.includes('\0') || relPath.includes('..')) return false;

  const segments = relPath.split('/');
  if (segments.length > MAX_PATH_SEGMENTS) return false;

  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return false;
    if (!SEGMENT_PATTERN.test(segment)) return false;
  }

  const filename = segments[segments.length - 1];
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, extension);
}

/**
 * Content type for a validated asset path.
 *
 * @param {string} relPath
 * @returns {string}
 */
export function contentTypeFor(relPath) {
  const extension = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[extension] || 'application/octet-stream';
}

export function getOfficeJsCacheDir() {
  return path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'office-js-cache');
}

/** In-flight upstream fetches, keyed by cache path, to collapse stampedes. */
const inFlight = new Map();

/**
 * Read a cached asset and report whether it is still fresh.
 *
 * @param {string} cachePath
 * @param {number} ttlMs
 * @returns {Promise<{ body: Buffer, fresh: boolean }|null>}
 */
async function readCache(cachePath, ttlMs) {
  try {
    const [stat, body] = await Promise.all([fs.stat(cachePath), fs.readFile(cachePath)]);
    return { body, fresh: Date.now() - stat.mtimeMs < ttlMs };
  } catch {
    return null;
  }
}

/**
 * Fetch one asset from the upstream CDN and write it to the cache.
 *
 * @param {string} upstreamUrl
 * @param {string|null} cachePath - null skips caching and just returns the body
 * @returns {Promise<Buffer>}
 */
async function fetchAndCache(upstreamUrl, cachePath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    // httpFetch applies the platform's proxy and TLS settings, so the server
    // reaches the CDN through the customer's corporate proxy when one is set.
    response = await httpFetch(upstreamUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Upstream returned ${response.status} for ${upstreamUrl}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_ASSET_BYTES) {
    throw new Error(`Upstream asset exceeds ${MAX_ASSET_BYTES} bytes: ${upstreamUrl}`);
  }

  if (!cachePath) return body;

  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await atomicWriteFile(cachePath, body);
  } catch (error) {
    // A read-only or full disk must not take the add-in down — the response is
    // already in hand, it just will not be cached.
    logger.warn('Could not cache Office.js asset', {
      component: 'OfficeJsProxy',
      cachePath,
      error: error.message
    });
  }

  return body;
}

/**
 * Get one Office.js asset, from cache when fresh and from upstream otherwise.
 *
 * When upstream fails but a cached copy exists, the cached copy is served
 * however old it is. That is what makes a pre-warmed cache work with no
 * outbound access, and what keeps the add-in alive through a CDN outage.
 *
 * @param {string} relPath - Validated path relative to the proxy mount
 * @param {string} upstreamBaseUrl - CDN base URL, ending in `/`
 * @param {Object} [options]
 * @param {number} [options.ttlMs]
 * @returns {Promise<{ body: Buffer, contentType: string, source: 'cache'|'upstream'|'stale' }>}
 */
export async function getOfficeJsAsset(relPath, upstreamBaseUrl, options = {}) {
  if (!isSafeOfficeJsAssetPath(relPath)) {
    throw Object.assign(new Error(`Rejected Office.js asset path: ${relPath}`), { status: 400 });
  }
  if (!upstreamBaseUrl) {
    throw Object.assign(new Error('No upstream Office.js base URL configured'), { status: 500 });
  }

  const ttlMs =
    Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;

  const contentType = contentTypeFor(relPath);
  const upstreamUrl = new URL(relPath, upstreamBaseUrl).toString();

  // `resolveAndValidatePath` canonicalizes against an existing base, so the
  // cache directory has to exist before it can vouch for a path inside it.
  const cacheDir = getOfficeJsCacheDir();
  let cacheDirReady = true;
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    cacheDirReady = false;
    logger.warn('Office.js cache directory unavailable — serving without cache', {
      component: 'OfficeJsProxy',
      cacheDir,
      error: error.message
    });
  }

  // Defence in depth: the path already passed the allowlist above, but the
  // cache path is still resolved and bounds-checked before any write.
  const cachePath = cacheDirReady ? await resolveAndValidatePath(relPath, cacheDir) : null;
  if (cacheDirReady && !cachePath) {
    throw Object.assign(new Error(`Rejected Office.js cache path: ${relPath}`), { status: 400 });
  }

  // No usable cache directory: fetch straight through, every time.
  if (!cachePath) {
    const body = await fetchAndCache(upstreamUrl, null);
    return { body, contentType, source: 'upstream' };
  }

  const cached = await readCache(cachePath, ttlMs);
  if (cached?.fresh) {
    return { body: cached.body, contentType, source: 'cache' };
  }

  let pending = inFlight.get(cachePath);
  if (!pending) {
    pending = fetchAndCache(upstreamUrl, cachePath).finally(() => inFlight.delete(cachePath));
    inFlight.set(cachePath, pending);
  }

  try {
    const body = await pending;
    return { body, contentType, source: 'upstream' };
  } catch (error) {
    if (cached) {
      logger.warn('Serving stale cached Office.js asset — upstream unreachable', {
        component: 'OfficeJsProxy',
        relPath,
        error: error.message
      });
      return { body: cached.body, contentType, source: 'stale' };
    }
    throw error;
  }
}

/**
 * Probe whether an Office.js URL is reachable **from this server**.
 *
 * That qualifier matters: it is the right question for `proxy` mode, where the
 * server does the fetching, and the wrong one for `cdn` and `custom`, where the
 * Office client does. The admin UI therefore pairs this with a check from the
 * operator's own browser and labels both.
 *
 * Never throws for an unreachable target — an unreachable URL is a result, not
 * an error. The response body is not read.
 *
 * @param {string} url - A URL that has passed `validateOfficeJsUrl`
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{url: string, reachable: boolean, status?: number, durationMs: number, error?: string}>}
 */
export async function probeOfficeJsUrl(url, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : PROBE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    // httpFetch is the platform's one outbound path, so the probe is
    // transported exactly like the traffic it diagnoses — same proxy, same TLS
    // decision. Redirects are not followed: the question is what *this* URL
    // does, and Office.js would not follow one to find its base path either.
    const response = await httpFetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'iHub-Apps Office.js reachability test' }
    });
    response.body?.destroy?.();
    return {
      url,
      reachable: response.status >= 200 && response.status < 300,
      status: response.status,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      url,
      reachable: false,
      durationMs: Date.now() - startedAt,
      error: error.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: drop the in-flight map between cases. */
export function _resetInFlight() {
  inFlight.clear();
}
