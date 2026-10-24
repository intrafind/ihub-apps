// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Gemini's Google Search grounding links every source through
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/<token>`, with only
 * the site's domain as its title. Resolving the redirect gives the sources
 * panel the real page address.
 */
import logger from './logger.js';

const REDIRECT_PREFIX = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';
const TIMEOUT_MS = 1000;
const CACHE_LIMIT = 500;
const FAILED_TTL_MS = 60 * 1000;

// `{ target, expiresAt }` by redirect URL. A failed lookup (`target: null`) is
// kept briefly so a dead link is not retried on every streamed payload, but
// not for good: the endpoint may recover.
const cache = new Map();

export function isGroundingRedirect(url) {
  return typeof url === 'string' && url.startsWith(REDIRECT_PREFIX);
}

async function resolveOne(url) {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.target;
  let resolved = null;
  try {
    // Loaded on first use: the converter imports this file on every Gemini call.
    // Loaded before the timer starts, so a cold start does not eat the budget.
    const { httpFetch } = await import('./httpConfig.js');
    const controller = new AbortController();
    let timer;
    // The race, not just the abort, bounds the wait: a stalled proxy tunnel
    // can ignore the signal.
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
    const response = await Promise.race([
      httpFetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 iHub-Apps' }
      }),
      timedOut
    ]).finally(() => clearTimeout(timer));
    const location = response.headers.get('location');
    if (/^https?:\/\//i.test(location || '') && !isGroundingRedirect(location)) {
      resolved = location;
    }
  } catch (error) {
    logger.debug('Grounding redirect resolution failed', {
      component: 'groundingRedirects',
      error: error.message
    });
  }
  if (!cache.has(url) && cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(url, {
    target: resolved,
    expiresAt: resolved ? Infinity : Date.now() + FAILED_TTL_MS
  });
  return resolved;
}

/**
 * Replace Gemini's grounding redirect links in a `groundingMetadata` payload
 * (`groundingChunks[].web.uri` and `webSupports[].urls`) with their targets.
 * A link that cannot be resolved stays as it is: it still opens the page.
 *
 * @param {Object|undefined} metadata
 * @returns {Promise<Object|undefined>} the metadata, with resolved links
 */
export async function resolveGroundingMetadataLinks(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
  const supports = Array.isArray(metadata.webSupports) ? metadata.webSupports : [];

  const redirects = new Set();
  for (const chunk of chunks) {
    if (isGroundingRedirect(chunk?.web?.uri)) redirects.add(chunk.web.uri);
  }
  for (const support of supports) {
    for (const url of Array.isArray(support?.urls) ? support.urls : []) {
      if (isGroundingRedirect(url)) redirects.add(url);
    }
  }
  if (!redirects.size) return metadata;

  const targets = new Map();
  await Promise.all(
    [...redirects].map(async url => {
      const target = await resolveOne(url);
      if (target) targets.set(url, target);
    })
  );
  if (!targets.size) return metadata;

  const swap = url => targets.get(url) || url;
  return {
    ...metadata,
    ...(chunks.length && {
      groundingChunks: chunks.map(chunk =>
        chunk?.web?.uri && targets.has(chunk.web.uri)
          ? { ...chunk, web: { ...chunk.web, uri: swap(chunk.web.uri) } }
          : chunk
      )
    }),
    ...(supports.length && {
      webSupports: supports.map(support => ({
        ...support,
        urls: Array.isArray(support?.urls) ? support.urls.map(swap) : support?.urls
      }))
    })
  };
}
