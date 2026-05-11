/**
 * Runtime base path detection utilities
 *
 * This module detects the base path at runtime from the current URL,
 * eliminating the need for build-time configuration. This allows the same
 * build to work at any subpath.
 */

/**
 * Detect the base path from the current window location
 * This works by finding where the app is served from
 * @returns {string} The detected base path (e.g., "", "/ihub", "/tools/ai")
 */
export const detectBasePath = () => {
  // Get the current pathname
  const pathname = window.location.pathname;

  // Find the base path by looking for where index.html is served
  // The app's root is where we are now, before any React routing
  // Remove any trailing /index.html or just trailing slash
  const cleanPath = pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');

  // Known React routes - these are app routes, not deployment subpaths
  //
  // ⚠️ IMPORTANT: When adding new top-level routes to App.jsx, you MUST update this array!
  // Also update the matching array in index.html for consistency.
  // This includes any new routes like:
  // - New feature routes (e.g., /reports, /analytics)
  // - New page routes (e.g., /help, /docs)
  // - New API endpoint prefixes that need special handling
  //
  // Failure to update this array will cause base path detection to fail for subpath
  // deployments (e.g., /ihub/newroute will incorrectly detect /ihub/newroute as base path
  // instead of /ihub).
  const knownRoutes = [
    'apps', // App listing and individual app routes
    'admin', // Admin panel routes
    'auth', // Authentication routes
    'login', // Login page
    'chat', // Direct chat routes
    'pages', // Dynamic pages
    'prompts', // Prompts listing
    'settings', // Settings pages (integrations, etc.)
    'teams', // Microsoft Teams routes
    'workflows', // Workflow management and execution
    's', // Short links
    'setup', // First-run setup wizard
    'tools', // Tool pages (AI OCR, etc.)
    'office', // Office add-in pages
    'nextcloud' // Nextcloud embed pages
  ];

  // Split path into segments and find the first known route
  // This correctly handles paths like /admin/apps (route 'admin' at segment 0)
  // vs /ihub/admin/apps (route 'admin' at segment 1, base path is '/ihub')
  const segments = cleanPath.split('/').filter(s => s); // Remove empty strings

  // Find the index of the first segment that matches a known route
  let routeSegmentIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (knownRoutes.includes(segments[i])) {
      routeSegmentIndex = i;
      break;
    }
  }

  // Determine base path from segment analysis
  if (routeSegmentIndex === 0) {
    // Route is at root (e.g., /admin/apps) - no subpath deployment
    return '';
  } else if (routeSegmentIndex > 0) {
    // Route found after subpath (e.g., /ihub/admin/apps) - base is /ihub
    return '/' + segments.slice(0, routeSegmentIndex).join('/');
  }

  // No known routes found in URL path.
  // Fall back to window.__BASE_PATH__ set by index.html's inline script,
  // which uses the same detection logic but runs before React mounts.
  // This handles the case where the user lands on the subpath root (e.g., /ihub/).
  if (typeof window !== 'undefined' && window.__BASE_PATH__) {
    return window.__BASE_PATH__;
  }

  return '';
};

/**
 * Get the base path - uses runtime detection
 * @returns {string} The base path
 */
export const getBasePath = () => {
  // Cache the detected base path in sessionStorage for performance
  const cacheKey = 'runtime-base-path';

  // Check if we're on a logout page - if so, clear the cache to force fresh detection
  // This prevents stale cache from causing routing issues after logout redirects
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('logout') === 'true') {
    sessionStorage.removeItem(cacheKey);
  }

  let basePath = sessionStorage.getItem(cacheKey);

  // Validate cached base path against current URL
  // This prevents issues when navigating between different deployments
  if (basePath !== null) {
    const currentPath = window.location.pathname;

    // Check if cached base path is actually a known route (invalid - routes are not base paths)
    const knownRoutes = [
      'apps',
      'admin',
      'auth',
      'login',
      'chat',
      'pages',
      'prompts',
      'settings',
      'teams',
      'workflows',
      's',
      'setup',
      'tools',
      'office',
      'nextcloud'
    ];
    const isKnownRoute = knownRoutes.some(route => basePath === '/' + route);

    if (isKnownRoute) {
      // Cached base path is a React route, not a deployment path - invalid!
      sessionStorage.removeItem(cacheKey);
      basePath = null;
    }
    // If base path is not empty, current path should start with it
    else if (
      basePath !== '' &&
      !currentPath.startsWith(basePath + '/') &&
      currentPath !== basePath
    ) {
      // Cached base path doesn't match current URL - clear and re-detect
      sessionStorage.removeItem(cacheKey);
      basePath = null;
    }
    // If base path is empty (root deployment), make sure we're not actually in a subpath
    else if (basePath === '') {
      // Detect fresh to see if we should have a base path
      const freshDetection = detectBasePath();
      if (freshDetection !== '') {
        // We detected a base path but cache says root - cache is stale
        sessionStorage.removeItem(cacheKey);
        basePath = null;
      }
    }
  }

  if (basePath === null) {
    basePath = detectBasePath();
    sessionStorage.setItem(cacheKey, basePath);
  }

  return basePath;
};

/**
 * Override the API origin used by `buildApiUrl()`.
 *
 * When the iHub UI runs from a non-iHub origin (e.g. a chrome-extension://
 * side panel), relative `/api/...` URLs resolve against the wrong host.
 * Hosts in that situation call `setApiBaseUrlOverride('https://ihub.example.com')`
 * once at entry time so every subsequent `buildApiUrl(...)` returns an
 * absolute URL pointing at the iHub server.
 *
 * Pass `null` to clear the override.
 */
let apiBaseUrlOverride = null;
export const setApiBaseUrlOverride = baseUrl => {
  apiBaseUrlOverride = baseUrl ? String(baseUrl).replace(/\/$/, '') : null;
};
export const getApiBaseUrlOverride = () => apiBaseUrlOverride;

/**
 * Build a complete URL relative to the base path
 * @param {string} path - The path to append (e.g., "/api/health", "logo.svg")
 * @returns {string} The complete path
 */
export const buildPath = path => {
  const basePath = getBasePath();

  // Handle absolute URLs
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  // Remove leading slash from path if present
  const cleanPath = path.startsWith('/') ? path.substring(1) : path;

  // Build the complete path
  if (!basePath) {
    return '/' + cleanPath;
  }

  return basePath + '/' + cleanPath;
};

/**
 * Build an API endpoint URL
 * @param {string} endpoint - API endpoint (e.g., "/health", "/chat")
 * @returns {string} Complete API URL relative to base
 */
export const buildApiUrl = endpoint => {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.substring(1) : endpoint;
  // When the host has set an absolute API base URL (e.g. the browser
  // extension's side panel running from chrome-extension://<id>), return
  // a fully-qualified URL so callers like `fetch()` and `new EventSource()`
  // don't resolve relative paths against the wrong origin.
  if (apiBaseUrlOverride) {
    return apiBaseUrlOverride + '/api/' + cleanEndpoint;
  }
  return buildPath('api/' + cleanEndpoint);
};

/**
 * Build an asset URL (images, fonts, etc.)
 * @param {string} asset - Asset path
 * @returns {string} Complete asset URL
 */
export const buildAssetUrl = asset => {
  // When the host has set an absolute API base URL (e.g. the browser
  // extension's side panel running from chrome-extension://<id>), assets
  // such as `/icons/<app-icon>.svg` live on the iHub server, NOT on the
  // current origin. Return a fully-qualified URL so <img src> etc. fetch
  // them from the right place.
  if (apiBaseUrlOverride) {
    const cleanAsset = asset.startsWith('/') ? asset.substring(1) : asset;
    return apiBaseUrlOverride + '/' + cleanAsset;
  }

  // For Vite dev server, use root paths
  if (import.meta.env.DEV) {
    return asset.startsWith('/') ? asset : '/' + asset;
  }

  const cleanAsset = asset.startsWith('/') ? asset.substring(1) : asset;
  return buildPath(cleanAsset);
};

/**
 * Build upload URL
 * @param {string} path - Upload path
 * @returns {string} Complete upload URL
 */
export const buildUploadUrl = path => {
  const cleanPath = path.startsWith('/') ? path.substring(1) : path;
  if (apiBaseUrlOverride) {
    return apiBaseUrlOverride + '/uploads/' + cleanPath;
  }
  return buildPath('uploads/' + cleanPath);
};

/**
 * Get the relative path from a full pathname
 * @param {string} fullPath - The full pathname
 * @returns {string} The relative path without base
 */
export const getRelativePath = fullPath => {
  const basePath = getBasePath();

  if (!basePath) {
    return fullPath;
  }

  if (fullPath.startsWith(basePath + '/')) {
    return fullPath.substring(basePath.length);
  }

  if (fullPath === basePath) {
    return '/';
  }

  return fullPath;
};

/**
 * Check if we're running at a subpath
 * @returns {boolean} True if running at subpath
 */
export const isSubpathDeployment = () => {
  return getBasePath() !== '';
};

/**
 * Clear the cached base path (useful for testing or after navigation)
 */
export const clearBasePathCache = () => {
  sessionStorage.removeItem('runtime-base-path');
};

/**
 * Initialize base path detection on app start
 * This should be called early in the app lifecycle
 */
export const initializeBasePath = () => {
  const basePath = getBasePath();

  // Store in window for debugging
  window.__BASE_PATH__ = basePath;

  return basePath;
};
