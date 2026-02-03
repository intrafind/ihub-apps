import logger from './logger.js';
/**
 * Base path utilities for server-side routing and URL generation
 *
 * This module provides utilities to handle subpath deployment scenarios where
 * the application is deployed at a subpath like /ai-hub/ instead of the root.
 *
 * Key features:
 * - Configurable via BASE_PATH environment variable
 * - Auto-detection from reverse proxy headers (optional)
 * - Route path building utilities
 * - Backward compatibility with root path deployments
 */

/**
 * Get the configured base path from environment or configuration
 * @returns {string} Base path
 */
export const getBasePath = () => {
  let basePath = process.env.BASE_PATH || '';

  // Auto-detection from request headers (if enabled)
  if (process.env.AUTO_DETECT_BASE_PATH === 'true' && global.currentRequest) {
    const headerName = process.env.BASE_PATH_HEADER || 'x-forwarded-prefix';
    const detectedPath = global.currentRequest.headers[headerName.toLowerCase()];
    if (detectedPath && isValidBasePath(detectedPath)) {
      basePath = detectedPath;
    }
  }

  // Remove trailing slash except for root path
  return basePath.endsWith('/') && basePath !== '/' ? basePath.slice(0, -1) : basePath;
};

/**
 * Validate base path configuration
 * @param {string} path - Base path to validate
 * @returns {boolean} True if valid
 */
export const isValidBasePath = path => {
  if (!path || path === '/') return true;

  // Must start with /
  if (!path.startsWith('/')) return false;

  // Must not end with / (except root)
  if (path.endsWith('/') && path !== '/') return false;

  // Must not contain dangerous sequences
  if (path.includes('..') || path.includes('//')) return false;

  // Length check
  if (path.length > 100) return false;

  // Valid characters check (alphanumeric, hyphen, underscore, forward slash)
  return /^[\w\-/]+$/.test(path);
};

/**
 * Build server route path with base path. base path is automatically prepended.
 * @param {string} path - Route path
 * @returns {string} Complete route path
 */
export const buildServerPath = path => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  if (!basePath) return cleanPath;
  return `${basePath}${cleanPath}`;
};

/**
 * Build public URL for client consumption
 * @param {string} path - Path to make public
 * @param {Object} req - Express request object (optional)
 * @returns {string} Complete public URL
 */
export const buildPublicUrl = (path, req) => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  if (!basePath) return cleanPath;
  return `${basePath}${cleanPath}`;
};

/**
 * Build API endpoint path with base path
 * @param {string} endpoint - API endpoint
 * @returns {string} Complete API path
 */
export const buildApiPath = endpoint => {
  const basePath = getBasePath();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  if (!basePath) return `/api${cleanEndpoint}`;
  return `${basePath}/api${cleanEndpoint}`;
};

/**
 * Build uploads path with base path
 * @param {string} path - Upload path
 * @returns {string} Complete uploads path
 */
export const buildUploadsPath = (path = '') => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  if (!basePath) return `/uploads${cleanPath}`;
  return `${basePath}/uploads${cleanPath}`;
};

/**
 * Build documentation path with base path
 * @param {string} path - Documentation path
 * @returns {string} Complete documentation path
 */
export const buildDocsPath = (path = '') => {
  const basePath = getBasePath();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  if (!basePath) return `/docs${cleanPath}`;
  return `${basePath}/docs${cleanPath}`;
};

/**
 * Build short link path with base path
 * @param {string} code - Short link code
 * @returns {string} Complete short link path
 */
export const buildShortLinkPath = code => {
  const basePath = getBasePath();

  if (!basePath) return `/s/${code}`;
  return `${basePath}/s/${code}`;
};

/**
 * Extract relative path from request URL
 * @param {string} requestPath - Full request path
 * @returns {string} Path relative to base path
 */
export const getRelativeRequestPath = requestPath => {
  const basePath = getBasePath();
  if (!basePath) return requestPath;

  if (requestPath.startsWith(basePath)) {
    const relativePath = requestPath.substring(basePath.length);
    return relativePath || '/';
  }

  return requestPath;
};

/**
 * Check if current deployment is using a subpath
 * @returns {boolean} True if deployed at subpath
 */
export const isSubpathDeployment = () => {
  return getBasePath() !== '';
};

/**
 * Convert an absolute path to relative by removing base path
 * @param {string} absolutePath - Absolute path including base path
 * @returns {string} Relative path without base path
 */
export const toRelativePath = absolutePath => {
  const basePath = getBasePath();
  if (!basePath) return absolutePath;

  if (absolutePath.startsWith(basePath + '/')) {
    return absolutePath.substring(basePath.length);
  }

  if (absolutePath === basePath) return '/';

  return absolutePath;
};

/**
 * Convert a relative path to absolute by adding base path
 * @param {string} relativePath - Relative path
 * @returns {string} Absolute path with base path
 */
export const toAbsolutePath = relativePath => {
  const basePath = getBasePath();
  if (!basePath) return relativePath;

  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;

  // If path already includes base path, return as-is
  if (cleanPath.startsWith(basePath)) return cleanPath;

  return `${basePath}${cleanPath}`;
};

/**
 * Middleware to detect base path from headers
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
export const basePathDetectionMiddleware = (req, res, next) => {
  if (process.env.AUTO_DETECT_BASE_PATH === 'true') {
    global.currentRequest = req;
  }
  next();
};

/**
 * Middleware to validate base path configuration
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
export const basePathValidationMiddleware = (req, res, next) => {
  const basePath = getBasePath();
  if (basePath && !isValidBasePath(basePath)) {
    logger.warn(`Invalid base path configuration: ${basePath}. Using root path as fallback.`);
    // Override with empty base path for safety
    process.env.BASE_PATH = '';
  }
  next();
};

/**
 * Get base path configuration info for debugging
 * @returns {Object} Configuration information
 */
export const getBasePathInfo = () => {
  const basePath = getBasePath();
  return {
    basePath,
    isSubpath: isSubpathDeployment(),
    isValid: isValidBasePath(basePath),
    envVariable: process.env.BASE_PATH,
    autoDetect: process.env.AUTO_DETECT_BASE_PATH === 'true',
    headerName: process.env.BASE_PATH_HEADER || 'x-forwarded-prefix',
    nodeEnv: process.env.NODE_ENV
  };
};

/**
 * Health check endpoint that includes base path information
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export const healthCheckHandler = (req, res) => {
  const basePathInfo = getBasePathInfo();

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    basePathConfig: basePathInfo,
    requestPath: req.path,
    relativePath: getRelativeRequestPath(req.path)
  });
};
