// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Environment-driven changes to a config entry as it is loaded: `IHUB_*`
 * variables that override single settings, and the fields that opt out of
 * `${VAR}` substitution.
 */

import logger from './logger.js';

/**
 * Convert an UPPER_SNAKE_CASE segment to camelCase
 * Example: SESSION_TIMEOUT_MINUTES → sessionTimeoutMinutes
 */
function toCamelCase(segment) {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Parse an environment variable string value to the most appropriate type.
 * Numbers and booleans are coerced; JSON arrays/objects are parsed; otherwise string.
 */
function parseEnvValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Set a value at a nested path inside an object.
 * Intermediate objects are created as needed.
 */
function setNestedValue(obj, pathParts, value) {
  if (!obj || typeof obj !== 'object' || pathParts.length === 0) return;

  let current = obj;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const key = pathParts[i];
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[pathParts[pathParts.length - 1]] = value;
}

/**
 * Mapping from config cache keys to IHUB_* environment variable prefixes.
 * Double underscores (__) separate nested path segments.
 * Each segment is UPPER_SNAKE_CASE and is converted to camelCase before use.
 *
 * Examples:
 *   IHUB_PLATFORM__AUTH__MODE=anonymous         → platform.json  auth.mode
 *   IHUB_PLATFORM__DEFAULT_LANGUAGE=de          → platform.json  defaultLanguage
 *   IHUB_PLATFORM__RATE_LIMIT__DEFAULT__LIMIT=200 → platform.json rateLimit.default.limit
 *   IHUB_UI__THEME__PRIMARY_COLOR=#ff0000       → ui.json        theme.primaryColor
 */
const IHUB_ENV_PREFIXES = {
  'config/platform.json': 'IHUB_PLATFORM__',
  'config/ui.json': 'IHUB_UI__'
};

/**
 * Per-cache-key config paths that must NOT be passed through env var
 * substitution. Used by `setCacheEntry` to opt specific fields out.
 *
 * Add an entry here when a config field is a *user-data* template
 * (e.g. `${user.username}` placeholder) rather than an env var reference.
 * Without this, `${name}` would be eaten by `resolveEnvVars` when an OS
 * env var of the same name exists (notably Windows `process.env.username`
 * = the OS user running the server) — silently leaking that value into
 * the templated field.
 */
export const ENV_VAR_SKIP_PATHS_BY_KEY = {
  // The iFinder installation's JWT subject may be a `${user.x}` template.
  'config/integrations.json': ['installed[].values.jwtSubjectField']
};

/**
 * Scan process.env for IHUB_* overrides and apply them to the given config object.
 * Only configs listed in IHUB_ENV_PREFIXES are processed.
 * Returns the (potentially mutated) data object.
 */
export function applyIhubEnvOverrides(configPath, data) {
  const prefix = IHUB_ENV_PREFIXES[configPath];
  if (!prefix || !data || typeof data !== 'object' || Array.isArray(data)) return data;

  for (const [envKey, envValue] of Object.entries(process.env)) {
    const pathParts = envOverridePath(envKey, prefix);
    if (!pathParts) continue;

    const parsedValue = parseEnvValue(envValue);
    setNestedValue(data, pathParts, parsedValue);

    logger.info(
      `Applied IHUB env override: ${envKey} → ${pathParts.join('.')} = ${JSON.stringify(parsedValue)}`,
      { component: 'ConfigCache' }
    );
  }

  return data;
}

/**
 * The config path an `IHUB_*` variable overrides, in camelCase segments:
 * `IHUB_PLATFORM__AUTH__MODE` with the prefix `IHUB_PLATFORM__` gives
 * `['auth', 'mode']`. Null for a variable of another prefix, one with
 * nothing after the prefix, or a malformed one (an empty segment).
 *
 * @param {string} envKey - the variable's name
 * @param {string} prefix - the config's prefix (`IHUB_ENV_PREFIXES`)
 * @returns {string[]|null}
 */
export function envOverridePath(envKey, prefix) {
  if (!envKey.startsWith(prefix)) return null;
  const pathStr = envKey.slice(prefix.length);
  if (!pathStr) return null;
  const pathParts = pathStr.split('__').map(toCamelCase);
  return pathParts.some(p => !p) ? null : pathParts;
}
