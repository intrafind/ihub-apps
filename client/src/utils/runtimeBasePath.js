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
  let basePath = pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');

  // If we're at a React route (e.g., /ihub/apps/chat), we need to find the base
  // We can detect this by checking if there's a known React route pattern
  // These are top-level application routes, not deployment subpaths
  const knownRoutes = ['/apps', '/admin', '/auth', '/login', '/chat', '/pages', '/s/'];

  // First check if the path starts with any known route
  // If it does, the base path is empty (we're at the application root)
  for (const route of knownRoutes) {
    if (basePath === route || basePath.startsWith(route + '/')) {
      // Path starts with a known route, so we're at application root
      basePath = '';
      return basePath;
    }
  }

  // Otherwise, look for known routes within the path
  // This handles cases like /ihub/apps/chat where /ihub is the base path
  for (const route of knownRoutes) {
    const routeIndex = basePath.indexOf(route);
    if (routeIndex > 0) {
      // Found a route, so everything before it is the base path
      basePath = basePath.substring(0, routeIndex);
      break;
    }
  }

  // In development, we might still have a base path (e.g., when testing subpath deployment)
  // So don't automatically return empty string for dev mode

  return basePath;
};

/**
 * Get the base path - uses runtime detection
 * @returns {string} The base path
 */
export const getBasePath = () => {
  // Cache the detected base path in sessionStorage for performance
  const cacheKey = 'runtime-base-path';
  let basePath = sessionStorage.getItem(cacheKey);

  if (basePath === null) {
    basePath = detectBasePath();
    sessionStorage.setItem(cacheKey, basePath);
  }

  return basePath;
};

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
  return buildPath('api/' + cleanEndpoint);
};

/**
 * Build an asset URL (images, fonts, etc.)
 * @param {string} asset - Asset path
 * @returns {string} Complete asset URL
 */
export const buildAssetUrl = asset => {
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
