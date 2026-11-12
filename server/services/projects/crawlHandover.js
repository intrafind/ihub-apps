// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The pages a site crawl read, handed to the add step (#3622).
 *
 * The URL picker's crawl fetches every page it lists. Without a hand-over,
 * adding a picked page fetched it twice more: once to check what it is, once
 * in its ingest job. Instead the crawl keeps each page it read — the HTML,
 * its content type and version (ETag, Last-Modified) — and the add request
 * names the crawl (`crawlId`): the `url` kind's `prepare` takes the kept page
 * and the ingest job stores it without a request to the website.
 *
 * The crawl and the adds are separate requests that may reach different
 * workers, so a kept page lives in the project blob store, not in memory:
 * encrypted like an item's text (a data key per page, wrapped by the project
 * key provider), under a key that names the crawling user, the crawl and the
 * page, so nobody else's add can take it. A page is taken once. Pages nobody
 * adds are swept with the orphan blobs an hour after the crawl started: the
 * key ends in the crawl id, a time-ordered version id the sweep reads the age
 * from (`ProjectIngestService._sweepOrphans`).
 *
 * @module services/projects/crawlHandover
 */
import crypto from 'node:crypto';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { PROJECT_FILES_NAMESPACE, getProjectRepository } from './ProjectRepository.js';
import { projectSettings } from './projectSettings.js';
import { mintVersionId } from './ItemTextStore.js';
import { getKeyProvider } from './crypto/KeyProvider.js';
import { DEFAULT_SEGMENT_BYTES, decrypt, encrypt, newDataKey } from './crypto/streamingAead.js';

const COMPONENT = 'crawlHandover';

/** A crawl id: a version id (`ItemTextStore.mintVersionId`), base36 time and random hex. */
export const CRAWL_ID_PATTERN = /^[0-9a-z]{9}[0-9a-f]{8}$/;

/** The key prefix of kept pages; no project id is `crawl` followed by a 40-hex item id. */
const KEY_PREFIX = 'crawl';

/** A fresh crawl id; its first part is the crawl's start time. */
export function newCrawlId() {
  return mintVersionId();
}

function normalized(url) {
  try {
    return new URL(String(url)).href;
  } catch {
    return null;
  }
}

/** The blob key and associated data of one page of one user's crawl. */
function addressOf({ ownerId, crawlId, url }) {
  const page = normalized(url);
  if (!ownerId || !page || !CRAWL_ID_PATTERN.test(String(crawlId || ''))) return null;
  const scope = crypto
    .createHash('sha256')
    .update(`${ownerId}\n${crawlId}\n${page}`)
    .digest('hex')
    .slice(0, 40);
  return {
    key: `${KEY_PREFIX}__${scope}__${crawlId}`,
    aad: `ihub/project-crawls/${scope}/${crawlId}`
  };
}

function keyProvider() {
  return getKeyProvider(projectSettings(configCache.getPlatform?.() || {}).encryption.keyProvider);
}

/**
 * Keep one page a crawl read, for the add step.
 *
 * @param {Object} page
 * @param {string} page.ownerId - The user who crawled.
 * @param {string} page.crawlId - From {@link newCrawlId}.
 * @param {string} page.url - The address the page is listed by.
 * @param {string} page.html - The page, decoded.
 * @param {string} [page.contentType]
 * @param {string|null} [page.etag]
 * @param {string|null} [page.lastModified]
 * @param {Object} [options]
 * @param {Object} [options.repository]
 * @returns {Promise<boolean>} Whether it was kept.
 */
export async function keepCrawledPage(
  { ownerId, crawlId, url, html, contentType, etag = null, lastModified = null },
  { repository = getProjectRepository() } = {}
) {
  const address = addressOf({ ownerId, crawlId, url });
  if (!address || typeof html !== 'string' || !repository.hasBlobs()) return false;
  const payload = Buffer.from(
    JSON.stringify({
      url: normalized(url),
      contentType: contentType || 'text/html',
      etag: etag || null,
      lastModified: lastModified || null,
      html
    }),
    'utf8'
  );
  const dataKey = newDataKey();
  const provider = keyProvider();
  const { keyId, wrapped } = await provider.wrap(dataKey, address.aad);
  const header = Buffer.from(
    JSON.stringify({ provider: provider.id, keyId, wrapped: wrapped.toString('base64') }),
    'utf8'
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const ciphertext = encrypt(payload, dataKey, address.aad, {
    segmentBytes: DEFAULT_SEGMENT_BYTES
  });
  await repository.blobs.put(
    PROJECT_FILES_NAMESPACE,
    address.key,
    Buffer.concat([length, header, ciphertext])
  );
  return true;
}

/**
 * Take a page the caller's crawl kept: read it and drop it.
 *
 * @param {{ownerId: string, crawlId: string, url: string}} request
 * @param {Object} [options]
 * @param {Object} [options.repository]
 * @returns {Promise<{bytes: Buffer, contentType: string, etag: string|null,
 *   lastModified: string|null, finalUrl: string, notModified: false}|null>} The page as
 *   `downloadWebPage` returns one (UTF-8 HTML), or null when this crawl kept none
 *   for this user and address (another user's crawl, an expired or taken page).
 */
export async function takeCrawledPage(
  { ownerId, crawlId, url },
  { repository = getProjectRepository() } = {}
) {
  const address = addressOf({ ownerId, crawlId, url });
  if (!address || !repository.hasBlobs()) return null;
  try {
    const blob = await repository.blobs.get(PROJECT_FILES_NAMESPACE, address.key);
    if (!blob?.data) return null;
    // Only the take whose delete removed the page may use it: two adds of the
    // same page at once store it once, the other fetches it.
    const claimed = await repository.blobs.delete(PROJECT_FILES_NAMESPACE, address.key);
    if (claimed !== true) return null;
    const data = blob.data;
    const headerLength = data.readUInt32BE(0);
    const header = JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8'));
    const dataKey = await getKeyProvider(header.provider).unwrap(
      Buffer.from(header.wrapped, 'base64'),
      header.keyId,
      address.aad
    );
    const payload = JSON.parse(
      decrypt(data.subarray(4 + headerLength), dataKey, address.aad, {
        segmentBytes: DEFAULT_SEGMENT_BYTES
      }).toString('utf8')
    );
    if (typeof payload?.html !== 'string') return null;
    return {
      notModified: false,
      bytes: Buffer.from(payload.html, 'utf8'),
      contentType: 'text/html',
      etag: payload.etag || null,
      lastModified: payload.lastModified || null,
      finalUrl: payload.url || normalized(url)
    };
  } catch (error) {
    // Unreadable: the page is fetched instead.
    logger.warn('Could not take a page a crawl kept', {
      component: COMPONENT,
      error: error.message
    });
    return null;
  }
}
