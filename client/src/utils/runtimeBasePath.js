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

  // Find the first occurrence of any known route at a path boundary
  let firstRouteIndex = -1;
  let foundRoute = null;

  for (const route of knownRoutes) {
    // Check if basePath starts with this route
    if (basePath === route || basePath.startsWith(route + '/')) {
      // Route is at the very beginning
      firstRouteIndex = 0;
      foundRoute = route;
      break;
    }

    // Check if route appears after a slash (e.g., /ihub/apps)
    const searchPattern = route; // e.g., "/apps"
    let searchIndex = basePath.indexOf(searchPattern);

    // Keep searching for valid occurrences
    while (searchIndex > 0) {
      // Check if there's a slash right before this occurrence
      // (there should be since route starts with /)
      // This ensures we match /ihub/apps but not /ihubapps
      const prevChar = basePath[searchIndex - 1];
      if (prevChar === '/' || searchIndex === 0) {
        // This is a false match - route already starts with /
        // so prevChar being / means we have //apps which is wrong
        searchIndex = basePath.indexOf(searchPattern, searchIndex + 1);
        continue;
      }

      // Found a valid route occurrence (not at boundary)
      // This shouldn't happen with our current logic, skip it
      searchIndex = basePath.indexOf(searchPattern, searchIndex + 1);
    }

    // Simpler approach: split by / and check segments
    const segments = basePath.split('/').filter(s => s); // Remove empty strings
    const routeSegment = route.substring(1); // Remove leading / from route

    const segmentIndex = segments.indexOf(routeSegment);
    if (segmentIndex !== -1) {
      // Calculate the actual string index
      let actualIndex = 0;
      for (let i = 0; i < segmentIndex; i++) {
        actualIndex += segments[i].length + 1; // +1 for the /
      }

      if (firstRouteIndex === -1 || actualIndex < firstRouteIndex) {
        firstRouteIndex = actualIndex;
        foundRoute = route;
      }
    }
  }

  // If we found a route at the start (index 0), we're at application root
  if (firstRouteIndex === 0) {
    return '';
  }

  // If we found a route elsewhere, everything before it is the base path
  if (firstRouteIndex > 0) {
    // Build base path from segments
    const segments = basePath.split('/').filter(s => s);
    const routeSegment = foundRoute.substring(1);
    const routeSegmentIndex = segments.indexOf(routeSegment);

    if (routeSegmentIndex > 0) {
      return '/' + segments.slice(0, routeSegmentIndex).join('/');
    }
  }

  // No known routes found, return empty string
  // (in normal operation, we should always find a route)
  return '';
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
