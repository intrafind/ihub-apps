/**
 * Shared validation patterns and constants
 * Single source of truth for validation rules used by both client and server
 */

/**
 * App ID validation
 * Must contain only alphanumeric characters, underscores, dots, and hyphens
 * Length: 1-50 characters
 */
export const APP_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const APP_ID_MIN_LENGTH = 1;
export const APP_ID_MAX_LENGTH = 50;
export const APP_ID_ERROR_MESSAGE =
  'App ID can only contain letters, numbers, dots (.), underscores (_), and hyphens (-)';

/**
 * Model ID validation
 * Must contain only alphanumeric characters, underscores, dots, and hyphens
 * Length: 1-100 characters
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const MODEL_ID_MIN_LENGTH = 1;
export const MODEL_ID_MAX_LENGTH = 100;

/**
 * Source ID validation
 * Must contain only alphanumeric characters, underscores, dots, and hyphens
 * Length: 1-50 characters
 */
export const SOURCE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const SOURCE_ID_MIN_LENGTH = 1;
export const SOURCE_ID_MAX_LENGTH = 50;

/**
 * Prompt ID validation
 * Must contain only alphanumeric characters, underscores, dots, and hyphens
 * Length: 1-50 characters
 */
export const PROMPT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const PROMPT_ID_MIN_LENGTH = 1;
export const PROMPT_ID_MAX_LENGTH = 50;

/**
 * Variable name validation
 * Must start with letter or underscore, contain only alphanumeric, underscores, and hyphens
 */
export const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
export const VARIABLE_NAME_ERROR_MESSAGE =
  'Variable name must start with letter/underscore and contain only alphanumeric characters, underscores, and hyphens';

/**
 * Language code validation
 * Format: 'en', 'de', 'en-US', 'en-GB', etc.
 */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
export const LANGUAGE_CODE_ERROR_MESSAGE =
  'Invalid language code format (e.g., "en", "de", "en-US")';

/**
 * Color hex code validation
 * Format: #RRGGBB
 */
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
export const HEX_COLOR_ERROR_MESSAGE = 'Color must be a valid hex code (e.g., #4F46E5)';

/**
 * Token limit validation
 */
export const TOKEN_LIMIT_MIN = 1;
export const TOKEN_LIMIT_MAX = 1000000;

/**
 * Validate app ID format
 * @param {string} id - App ID to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateAppId(id) {
  if (!id || id.trim() === '') {
    return 'App ID is required';
  }
  if (id.length < APP_ID_MIN_LENGTH) {
    return `App ID must be at least ${APP_ID_MIN_LENGTH} character`;
  }
  if (id.length > APP_ID_MAX_LENGTH) {
    return `App ID cannot exceed ${APP_ID_MAX_LENGTH} characters`;
  }
  if (!APP_ID_PATTERN.test(id)) {
    return APP_ID_ERROR_MESSAGE;
  }
  return null;
}

/**
 * Validate model ID format
 * @param {string} id - Model ID to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateModelId(id) {
  if (!id || id.trim() === '') {
    return 'Model ID is required';
  }
  if (id.length < MODEL_ID_MIN_LENGTH) {
    return `Model ID must be at least ${MODEL_ID_MIN_LENGTH} character`;
  }
  if (id.length > MODEL_ID_MAX_LENGTH) {
    return `Model ID cannot exceed ${MODEL_ID_MAX_LENGTH} characters`;
  }
  if (!MODEL_ID_PATTERN.test(id)) {
    return 'Model ID can only contain letters, numbers, dots (.), underscores (_), and hyphens (-)';
  }
  return null;
}

/**
 * Validate hex color format
 * @param {string} color - Hex color to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateHexColor(color) {
  if (!color || color.trim() === '') {
    return 'Color is required';
  }
  if (!HEX_COLOR_PATTERN.test(color)) {
    return HEX_COLOR_ERROR_MESSAGE;
  }
  return null;
}

/**
 * Validate variable name format
 * @param {string} name - Variable name to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateVariableName(name) {
  if (!name || name.trim() === '') {
    return 'Variable name is required';
  }
  if (!VARIABLE_NAME_PATTERN.test(name)) {
    return VARIABLE_NAME_ERROR_MESSAGE;
  }
  return null;
}
