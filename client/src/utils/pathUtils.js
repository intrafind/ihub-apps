/**
 * Path utilities for handling subpath deployments
 *
 * This module provides utilities for working with pathname checking
 * and path operations that need to be aware of base path configuration.
 */

import { getBasePath, getRelativePath as getRelativePathname } from './runtimeBasePath';

/**
 * Check if current pathname starts with a given path, accounting for base path
 * @param {string} pathname - Current pathname from useLocation
 * @param {string} path - Path to check against (e.g., '/apps/')
 * @returns {boolean} True if pathname starts with path
 */
export const pathnameStartsWith = (pathname, path) => {
  const relativePath = getRelativePathname(pathname);
  return relativePath.startsWith(path);
};

/**
 * Check if current pathname equals a given path, accounting for base path
 * @param {string} pathname - Current pathname from useLocation
 * @param {string} path - Path to check against (e.g., '/')
 * @returns {boolean} True if pathname equals path
 */
export const pathnameEquals = (pathname, path) => {
  const relativePath = getRelativePathname(pathname);
  return relativePath === path;
};

/**
 * Get the active path for navigation highlighting
 * @param {string} pathname - Current pathname from useLocation
 * @param {string} linkUrl - URL from navigation link
 * @returns {boolean} True if link should be highlighted as active
 */
export const isActivePath = (pathname, linkUrl) => {
  // For external URLs, no active state
  if (linkUrl.startsWith('http')) return false;

  const relativePath = getRelativePathname(pathname);

  // Exact match for root
  if (linkUrl === '/') return relativePath === '/';

  // For other paths, check if current path starts with link URL
  return relativePath === linkUrl || relativePath.startsWith(linkUrl + '/');
};

/**
 * Normalize a path for comparison, removing trailing slashes
 * @param {string} path - Path to normalize
 * @returns {string} Normalized path
 */
export const normalizePath = path => {
  if (!path || path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
};
