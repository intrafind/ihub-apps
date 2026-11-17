// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Environment-driven changes to a config entry as it is loaded: `IHUB_*`
 * variables that override single settings, and the fields that opt out of
 * `${VAR}` substitution.
 */

import logger from './logger.js';
import { isSecretName, REDACTED } from './secretNames.js';

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
 * Whether a config setting holds a credential: a name `isSecretName` knows
 * (`jwtSecret`, `clientSecret`, `apiKey`, `password`, …) or a camelCase name
 * ending in `Key` (`subscriptionKey`, `encryptionKey`), which platform.json
 * uses for keys that `isSecretName` alone would let through.
 *
 * @param {string} name - A config key, camelCase.
 * @returns {boolean}
 */
function isSecretSetting(name) {
  return isSecretName(name) || /(^k|[a-z0-9]K)ey$/.test(name);
}

/**
 * A copy of a JSON override value with the values of credential-like keys
 * masked, at any depth.
 *
 * @param {unknown} value - A parsed override value.
 * @param {number} [depth] - Recursion depth, bounded.
 * @returns {unknown}
 */
function maskSecretKeys(value, depth = 0) {
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) return value.map(item => maskSecretKeys(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretSetting(key) ? REDACTED : maskSecretKeys(item, depth + 1)
      ])
    );
  }
  return value;
}

/**
 * The value of an override as the startup log shows it. The path is always
 * logged; the value is masked when the overridden setting looks like a
 * credential (`IHUB_PLATFORM__LOCAL_AUTH__JWT_SECRET`), and a JSON object or
 * array value has its credential-like keys masked, so a secret never reaches
 * the log.
 *
 * @param {string[]} pathParts - The overridden config path, camelCase segments.
 * @param {unknown} value - The parsed override value.
 * @returns {string} The value to log.
 *
 * @example
 * overrideValueForLog(['localAuth', 'jwtSecret'], 'abc'); // => '[redacted]'
 * overrideValueForLog(['auth', 'mode'], 'local'); // => '"local"'
 */
export function overrideValueForLog(pathParts, value) {
  if (isSecretSetting(pathParts[pathParts.length - 1])) return REDACTED;
  return JSON.stringify(maskSecretKeys(value));
}

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
      `Applied IHUB env override: ${envKey} → ${pathParts.join('.')} = ${overrideValueForLog(pathParts, parsedValue)}`,
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
