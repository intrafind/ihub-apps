/**
 * `${VAR}` substitution for configuration read off disk.
 *
 * Extracted from `configCache` so the subsystems that must read platform
 * configuration *before* the cache exists can apply the same substitution the
 * rest of the platform expects. Telemetry has always needed it; so does the
 * storage registry, which is constructed from the `storage` block of the very
 * file the cache is not yet able to serve.
 *
 * `configCache` re-exports {@link resolveEnvVarsInObject} under its old name,
 * so existing importers are unaffected.
 *
 * @module utils/envVars
 */
import logger from './logger.js';

/**
 * Resolve environment variables in a string
 * Replaces ${VAR_NAME} with the value of process.env.VAR_NAME
 */
export function resolveEnvVars(value) {
  if (typeof value !== 'string') return value;

  // Support both ${VAR} and the shell-style ${VAR:-default}. The default form
  // is what migrations like V031 write (`${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}`)
  // so without :-default support those placeholders pass through verbatim.
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (match, varName, fallback) => {
      const envValue = process.env[varName];
      if (envValue !== undefined && envValue !== '') {
        return envValue;
      }
      if (fallback !== undefined) {
        return fallback;
      }
      logger.warn('Environment variable not defined, keeping placeholder', {
        component: 'ConfigCache',
        varName,
        placeholder: match
      });
      return match;
    }
  );
}

/**
 * Recursively resolve environment variables in an object. Exported so other
 * subsystems (e.g. server/telemetry.js) that read raw JSON before configCache
 * is up can perform the same `${VAR}` / `${VAR:-default}` substitution the
 * rest of the platform expects.
 *
 * Callers can pass `skipPaths` to opt out specific dot-paths from env var
 * substitution. This matters for fields that contain *user-data* templates
 * (e.g. `${user.username}` is a placeholder for the authenticated user's
 * username, NOT for `process.env.username`) — Windows automatically sets
 * `process.env.username` to the OS user running the process, so without an
 * opt-out the resolver would silently leak the service account into every
 * such template. The skip decision belongs to whoever owns the config
 * schema (e.g. `setCacheEntry` for platform.json); this function is just
 * the mechanism.
 *
 * @param {*} obj - Object/array/primitive to recursively resolve
 * @param {Object} [options]
 * @param {string[]|Set<string>} [options.skipPaths] - Dot-paths to leave verbatim
 * @param {string} [options.path] - Internal: current dot-path used for skip-list checks
 */
export function resolveEnvVarsInObject(obj, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;

  const path = options.path || '';
  const skipPaths =
    options.skipPaths instanceof Set ? options.skipPaths : new Set(options.skipPaths || []);

  if (Array.isArray(obj)) {
    return obj.map((item, idx) =>
      resolveEnvVarsInObject(item, { skipPaths, path: `${path}[${idx}]` })
    );
  }

  const resolved = {};
  for (const [key, value] of Object.entries(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    if (skipPaths.has(childPath)) {
      resolved[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      resolved[key] = resolveEnvVars(value);
    } else if (typeof value === 'object') {
      resolved[key] = resolveEnvVarsInObject(value, { skipPaths, path: childPath });
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
