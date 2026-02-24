/**
 * Path Security Utilities
 *
 * Centralized module for validating and sanitizing user-controlled data
 * used in file paths, IDs, and other security-sensitive contexts.
 * All route handlers should use these functions instead of inline validation.
 */

import path from 'path';
import { promises as fs } from 'fs';

/**
 * Regular expression that allows only safe characters for IDs:
 * - Letters (a-z, A-Z)
 * - Numbers (0-9)
 * - Underscores (_)
 * - Hyphens (-)
 * - Dots (.) - for version numbers like "2.5" in model names
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Language code pattern: "en", "de", "en-US", "pt-BR", etc.
 * Also allows simple base languages with numeric suffixes for flexibility.
 */
const LANGUAGE_CODE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

/**
 * Validates that an ID contains only safe characters and cannot be used for path traversal.
 *
 * @param {string} id - The ID to validate
 * @returns {boolean} - True if the ID is safe, false otherwise
 */
export function isValidId(id) {
  if (!id || typeof id !== 'string') {
    return false;
  }

  // Check length to prevent extremely long IDs
  if (id.length === 0 || id.length > 100) {
    return false;
  }

  // Prevent path traversal sequences like ".." or "/.."
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return false;
  }

  return SAFE_ID_PATTERN.test(id);
}

/**
 * Validates an ID and throws an error with appropriate HTTP status if invalid.
 * This is a helper function for Express route handlers.
 *
 * @param {string} id - The ID to validate
 * @param {string} idType - The type of ID (e.g., 'app', 'model', 'prompt') for error messages
 * @param {object} res - Express response object (optional; when omitted only returns boolean)
 * @returns {boolean} - True if valid, false if invalid (and response has been sent when res provided)
 */
export function validateIdForPath(id, idType, res) {
  if (!isValidId(id)) {
    if (res) {
      res.status(400).json({
        error: `Invalid ${idType} ID. Only alphanumeric characters, dots, underscores, and hyphens are allowed.`
      });
    }
    return false;
  }
  return true;
}

/**
 * Validates multiple IDs (e.g., for batch operations).
 *
 * @param {string|string[]} ids - Single ID, comma-separated string, or array of IDs
 * @param {string} idType - The type of ID for error messages
 * @param {object} res - Express response object
 * @returns {string[]|boolean} - Array of valid IDs if all are valid, false if any are invalid
 */
export function validateIdsForPath(ids, idType, res) {
  // Handle special case for '*' (all items)
  if (ids === '*') {
    return ['*'];
  }

  // Convert to array
  let idArray;
  if (typeof ids === 'string') {
    idArray = ids.split(',').map(id => id.trim());
  } else if (Array.isArray(ids)) {
    idArray = ids;
  } else {
    res.status(400).json({
      error: `Invalid ${idType} IDs format. Expected string or array.`
    });
    return false;
  }

  // Validate each ID
  for (const id of idArray) {
    if (!isValidId(id)) {
      res.status(400).json({
        error: `Invalid ${idType} ID '${id}'. Only alphanumeric characters, dots, underscores, and hyphens are allowed.`
      });
      return false;
    }
  }

  return idArray;
}

/**
 * Validates a language code (e.g., "en", "de", "en-US").
 *
 * @param {string} lang - The language code to validate
 * @returns {boolean} - True if valid, false otherwise
 */
export function isValidLanguageCode(lang) {
  if (!lang || typeof lang !== 'string') {
    return false;
  }
  if (lang.length > 11) {
    return false;
  }
  return LANGUAGE_CODE_PATTERN.test(lang);
}

/**
 * Validates a language code for use in Express route handlers.
 * Returns the validated language code or a fallback.
 *
 * @param {string} lang - The language code to validate
 * @param {string} fallback - Fallback language code (default: 'en')
 * @returns {string} - The validated language code or the fallback
 */
export function sanitizeLanguageCode(lang, fallback = 'en') {
  if (isValidLanguageCode(lang)) {
    return lang;
  }
  return fallback;
}

/**
 * Validates that a resolved file path stays within the expected base directory.
 * Prevents path traversal by ensuring the resolved path starts with the base.
 *
 * @param {string} filePath - The file path to validate (can be relative)
 * @param {string} baseDir - The base directory that the path must stay within
 * @returns {string|null} - The resolved absolute path if safe, null if traversal detected
 */
export function resolveAndValidatePath(filePath, baseDir) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedFull = path.resolve(resolvedBase, filePath);

  // Ensure the resolved path is within the base directory
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(baseWithSep)) {
    return null;
  }

  return resolvedFull;
}

/**
 * Validates an object's keys as language codes.
 * Used when processing request bodies where keys represent languages (e.g., content per language).
 *
 * @param {object} obj - The object whose keys to validate
 * @returns {boolean} - True if all keys are valid language codes
 */
export function validateLanguageKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  return Object.keys(obj).every(key => isValidLanguageCode(key));
}

/**
 * Async variant of resolveAndValidatePath that follows symlinks via fs.realpath()
 * before checking the boundary. Prevents symlink-based path traversal attacks.
 *
 * @param {string} filePath - The file path to validate (can be relative)
 * @param {string} baseDir - The base directory that the real path must stay within
 * @returns {Promise<string|null>} - The real resolved path if safe, null if traversal detected or target missing
 */
export async function resolveAndValidateRealPath(filePath, baseDir) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedFull = path.resolve(resolvedBase, filePath);

  let realBase;
  let realFull;
  try {
    realBase = await fs.realpath(resolvedBase);
    realFull = await fs.realpath(resolvedFull);
  } catch {
    // Target doesn't exist or symlink target is missing
    return null;
  }

  const baseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
  if (realFull !== realBase && !realFull.startsWith(baseWithSep)) {
    return null;
  }

  return realFull;
}

/**
 * Strips leading slashes from a relative path to prevent it from being treated
 * as absolute by path.resolve(). Replaces the repeated `.replace(/^\/+/, '')` pattern.
 *
 * @param {string} filePath - The relative path to sanitize
 * @returns {string} - The cleaned path with leading slashes removed
 */
export function sanitizeRelativePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }
  return filePath.replace(/^[/\\]+/, '');
}
