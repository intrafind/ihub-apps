import { createHash } from 'crypto';
import { statSync, readFileSync } from 'fs';
import { getBasePath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';

export const DEFAULT_PWA_CONFIG = {
  enabled: false,
  name: 'iHub Apps',
  shortName: 'iHub',
  description: 'AI-powered applications platform',
  themeColor: '#003557',
  backgroundColor: '#ffffff',
  display: 'standalone',
  icons: {
    icon192: '/icons/icon-192.png',
    icon512: '/icons/icon-512.png',
    iconApple: '/icons/icon-192.png'
  }
};

/**
 * Merge stored pwa config with defaults. Config section may be partial.
 * Returns a fully-populated config object ready to use in manifest/tag builders.
 */
export function resolvePwaConfig(rawPwaConfig) {
  return {
    ...DEFAULT_PWA_CONFIG,
    ...(rawPwaConfig || {}),
    icons: {
      ...DEFAULT_PWA_CONFIG.icons,
      ...(rawPwaConfig?.icons || {})
    }
  };
}

/**
 * Compute a short hash of the pwa config for use as an ETag.
 * Includes the basePath so a deploy-path change also busts the cache.
 */
export function computePwaETag(resolvedConfig) {
  const basePath = getBasePath();
  const payload = JSON.stringify({ basePath, pwa: resolvedConfig });
  return createHash('sha1').update(payload).digest('hex').substring(0, 16);
}

/**
 * Escape a string for safe use in an HTML attribute value (double-quoted).
 */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve an icon path stored in config to a base-path-aware URL.
 * Stored paths are root-relative (/uploads/... or /icons/...).
 * Absolute https:// URLs are passed through unchanged.
 */
function resolveIconUrl(storedPath) {
  if (!storedPath) return null;
  if (storedPath.startsWith('http://') || storedPath.startsWith('https://')) {
    return storedPath;
  }
  const basePath = getBasePath();
  return basePath ? `${basePath}${storedPath}` : storedPath;
}

/**
 * Build the Web App Manifest JSON object.
 * Accepts a RESOLVED pwa config (output of resolvePwaConfig).
 */
export function buildManifest(resolvedConfig) {
  const basePath = getBasePath();

  const startUrl = basePath ? `${basePath}/` : '/';
  const scope = basePath ? `${basePath}/` : '/';

  const icons = [];
  if (resolvedConfig.icons?.icon192) {
    const src = resolveIconUrl(resolvedConfig.icons.icon192);
    if (src) icons.push({ src, sizes: '192x192', type: 'image/png', purpose: 'any' });
  }
  if (resolvedConfig.icons?.icon512) {
    const src = resolveIconUrl(resolvedConfig.icons.icon512);
    if (src) icons.push({ src, sizes: '512x512', type: 'image/png', purpose: 'any' });
  }

  return {
    name: resolvedConfig.name,
    short_name: resolvedConfig.shortName,
    description: resolvedConfig.description,
    theme_color: resolvedConfig.themeColor,
    background_color: resolvedConfig.backgroundColor,
    display: resolvedConfig.display,
    start_url: startUrl,
    scope,
    icons
  };
}

/**
 * Build the HTML tags to inject into index.html before </head>.
 * Accepts a RESOLVED pwa config (output of resolvePwaConfig).
 * All user-controlled values are HTML-attribute-escaped to prevent injection.
 */
export function buildHtmlTags(resolvedConfig) {
  const basePath = getBasePath();
  const manifestUrl = basePath ? `${basePath}/manifest.json` : '/manifest.json';
  const appleTouchIconUrl = resolveIconUrl(resolvedConfig.icons?.iconApple);

  const tags = [
    `  <link rel="manifest" href="${escapeAttr(manifestUrl)}" />`,
    `  <meta name="theme-color" content="${escapeAttr(resolvedConfig.themeColor || '#003557')}" />`,
    `  <meta name="mobile-web-app-capable" content="yes" />`,
    `  <meta name="apple-mobile-web-app-capable" content="yes" />`,
    `  <meta name="apple-mobile-web-app-status-bar-style" content="default" />`,
    `  <meta name="apple-mobile-web-app-title" content="${escapeAttr(resolvedConfig.shortName || resolvedConfig.name || 'iHub')}" />`
  ];

  if (appleTouchIconUrl) {
    tags.push(`  <link rel="apple-touch-icon" href="${escapeAttr(appleTouchIconUrl)}" />`);
  }

  return tags.join('\n');
}

/**
 * Build the service worker source code as a string.
 * Accepts a RESOLVED pwa config (output of resolvePwaConfig).
 * BASE_PATH and CACHE_VERSION are baked in so the SW works correctly
 * for any deployment subpath and auto-updates when config changes.
 */
export function buildServiceWorkerScript(resolvedConfig) {
  const basePath = getBasePath();
  const cacheVersion = computePwaETag(resolvedConfig);

  const precacheUrls = [
    basePath ? `${basePath}/` : '/',
    basePath ? `${basePath}/manifest.json` : '/manifest.json'
  ];

  return `// iHub Apps Service Worker — network-first, minimal pre-cache
// Auto-generated with baked-in base path. Managed via Admin > UI Customization > PWA.
const BASE_PATH = ${JSON.stringify(basePath)};
const CACHE_NAME = 'ihub-sw-v${cacheVersion}';
const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('ihub-sw-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Strip the base path prefix to get the relative path for route matching
  const relativePath = BASE_PATH && url.pathname.startsWith(BASE_PATH)
    ? url.pathname.slice(BASE_PATH.length) || '/'
    : url.pathname;

  // Never intercept non-GET, API, uploads, or docs requests
  if (
    event.request.method !== 'GET' ||
    relativePath.startsWith('/api/') ||
    relativePath.startsWith('/uploads/') ||
    relativePath.startsWith('/docs/')
  ) {
    return;
  }

  // Network-first: try network, fall back to cache for offline resilience
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.status === 200 && PRECACHE_URLS.includes(url.pathname)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match(PRECACHE_URLS[0]);
          }
        })
      )
  );
});
`;
}

// In-memory cache: key = `${indexPath}:${configETag}`, value = { content, mtime }
const indexHtmlCache = new Map();

/**
 * Read index.html, inject PWA <head> tags, and return the modified HTML string.
 * Uses a mtime + config-hash cache to avoid repeated disk reads.
 * Accepts a RESOLVED pwa config (output of resolvePwaConfig).
 * Returns null on failure so the caller can fall back gracefully.
 */
export function buildIndexWithPwaTags(indexPath, resolvedConfig) {
  try {
    const stat = statSync(indexPath);
    const mtime = stat.mtimeMs;
    const etag = computePwaETag(resolvedConfig);
    const cacheKey = `${indexPath}:${etag}`;
    const cached = indexHtmlCache.get(cacheKey);

    if (cached && cached.mtime === mtime) {
      return cached.content;
    }

    const html = readFileSync(indexPath, 'utf8');
    const tags = buildHtmlTags(resolvedConfig);
    const modified = html.replace('</head>', `${tags}\n  </head>`);

    indexHtmlCache.set(cacheKey, { content: modified, mtime });

    // Evict stale entries for the same indexPath to prevent unbounded growth
    for (const [key] of indexHtmlCache) {
      if (key.startsWith(indexPath + ':') && key !== cacheKey) {
        indexHtmlCache.delete(key);
      }
    }

    return modified;
  } catch (err) {
    logger.error('PwaService: failed to build index with PWA tags', {
      component: 'PwaService',
      error: err.message
    });
    return null; // caller falls back to res.sendFile
  }
}
