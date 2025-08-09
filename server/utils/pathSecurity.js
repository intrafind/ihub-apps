/**
 * Path Security Utilities
 *
 * This module provides utilities to prevent path traversal attacks
 * by validating user-controlled data used in file paths.
 */

/**
 * Regular expression that allows only safe characters for IDs:
 * - Letters (a-z, A-Z)
 * - Numbers (0-9)
 * - Underscores (_)
 * - Hyphens (-)
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

  return SAFE_ID_PATTERN.test(id);
}

/**
 * Validates an ID and throws an error with appropriate HTTP status if invalid.
 * This is a helper function for Express route handlers.
 *
 * @param {string} id - The ID to validate
 * @param {string} idType - The type of ID (e.g., 'app', 'model', 'prompt') for error messages
 * @param {object} res - Express response object
 * @returns {boolean} - True if valid, false if invalid (and response has been sent)
 */
export function validateIdForPath(id, idType, res) {
  if (!isValidId(id)) {
    res.status(400).json({
      error: `Invalid ${idType} ID. Only alphanumeric characters, underscores, and hyphens are allowed.`
    });
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
        error: `Invalid ${idType} ID '${id}'. Only alphanumeric characters, underscores, and hyphens are allowed.`
      });
      return false;
    }
  }

  return idArray;
}
