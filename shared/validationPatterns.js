// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Shared validation patterns and constants
 * Single source of truth for validation rules used by both client and server
 */

/**
 * App ID validation
 * Must contain only lowercase alphanumeric characters, underscores, dots, and hyphens
 * (lowercase-only so ids stay unambiguous now that lookups are case-insensitive)
 * Length: 1-50 characters
 */
export const APP_ID_PATTERN = /^[a-z0-9._-]+$/;
export const APP_ID_MAX_LENGTH = 50;

/**
 * Names no ID may have, whatever its kind: used as a key they reach the
 * prototype chain of an object instead of an entry. The server's
 * `isValidId` (`server/utils/pathSecurity.js`) and the app ID rule
 * (`shared/appId.js`) both read this list.
 */
export const UNSAFE_ID_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Variable name validation
 * Must start with letter or underscore, contain only alphanumeric, underscores, and hyphens
 */
export const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Language code validation
 * Format: 'en', 'de', 'en-US', 'en-GB', etc.
 */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Color hex code validation
 * Format: #RRGGBB
 */
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * Context window validation
 * Total input+output tokens supported by a model. Used for fitting documents
 * and showing the user how much capacity is left.
 */
export const CONTEXT_WINDOW_MIN = 1;
export const CONTEXT_WINDOW_MAX = 10000000; // headroom for 1M+ context models

/**
 * Max output tokens validation
 * The provider response cap sent as max_tokens / maxOutputTokens.
 */
export const MAX_OUTPUT_TOKENS_MIN = 1;
export const MAX_OUTPUT_TOKENS_MAX = 200000;
