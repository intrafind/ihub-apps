/**
 * Schema Service - Client-side utility for fetching JSON schemas from server
 * Replaces local JSON schema files with server-side Zod schema conversion
 */

import { makeAdminApiCall } from '../api/adminApi';

/**
 * Cache for fetched schemas to avoid repeated API calls
 */
const schemaCache = new Map();

/**
 * Cache TTL in milliseconds (5 minutes)
 */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Cache entry structure
 * @typedef {Object} CacheEntry
 * @property {Object} schema - The cached schema
 * @property {number} timestamp - When the schema was cached
 */

/**
 * Check if a cached schema is still valid
 * @param {CacheEntry} entry - Cache entry to check
 * @returns {boolean} True if cache entry is still valid
 */
function isCacheValid(entry) {
  return entry && Date.now() - entry.timestamp < CACHE_TTL;
}

/**
 * Fetch JSON schema from server with caching
 * @param {string} type - Schema type ('app', 'model', 'prompt', 'group', 'platform', 'user')
 * @returns {Promise<Object>} JSON Schema object
 * @throws {Error} If schema type is invalid or fetch fails
 */
export async function fetchJsonSchema(type) {
  const validTypes = ['app', 'model', 'prompt', 'group', 'platform', 'user'];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid schema type: ${type}. Must be one of: ${validTypes.join(', ')}`);
  }

  // Check cache first
  const cacheKey = `schema_${type}`;
  const cachedEntry = schemaCache.get(cacheKey);

  if (isCacheValid(cachedEntry)) {
    return cachedEntry.schema;
  }

  try {
    // Fetch schema from server
    const response = await makeAdminApiCall(`/admin/schemas/${type}`, {
      method: 'GET'
    });
    const schema = response.data;

    // Cache the schema
    schemaCache.set(cacheKey, {
      schema,
      timestamp: Date.now()
    });

    return schema;
  } catch (error) {
    console.error(`Failed to fetch ${type} schema:`, error);

    // If we have a stale cached version, use it as fallback
    if (cachedEntry) {
      console.warn(`Using stale cached schema for ${type}`);
      return cachedEntry.schema;
    }

    throw new Error(`Failed to fetch ${type} schema: ${error.message}`);
  }
}

/**
 * Fetch all available JSON schemas
 * @returns {Promise<Object>} Object containing all schemas
 * @throws {Error} If fetch fails
 */
export async function fetchAllJsonSchemas() {
  const cacheKey = 'schemas_all';
  const cachedEntry = schemaCache.get(cacheKey);

  if (isCacheValid(cachedEntry)) {
    return cachedEntry.schema;
  }

  try {
    const response = await makeAdminApiCall('/admin/schemas', {
      method: 'GET'
    });
    const schemas = response.data;

    // Cache individual schemas as well
    Object.entries(schemas).forEach(([type, schema]) => {
      schemaCache.set(`schema_${type}`, {
        schema,
        timestamp: Date.now()
      });
    });

    // Cache the combined result
    schemaCache.set(cacheKey, {
      schema: schemas,
      timestamp: Date.now()
    });

    return schemas;
  } catch (error) {
    console.error('Failed to fetch all schemas:', error);

    // If we have a stale cached version, use it as fallback
    if (cachedEntry) {
      console.warn('Using stale cached schemas');
      return cachedEntry.schema;
    }

    throw new Error(`Failed to fetch schemas: ${error.message}`);
  }
}

/**
 * Clear schema cache
 * Useful for testing or when schemas are updated
 */
export function clearSchemaCache() {
  schemaCache.clear();
}

/**
 * Get cached schema without making network request
 * @param {string} type - Schema type ('app', 'model', 'prompt', 'group', 'platform', 'user')
 * @returns {Object|null} Cached schema or null if not cached
 */
export function getCachedSchema(type) {
  const cacheKey = `schema_${type}`;
  const cachedEntry = schemaCache.get(cacheKey);

  return cachedEntry ? cachedEntry.schema : null;
}

/**
 * Get schema by type - alias for fetchJsonSchema for consistency with other services
 * @param {string} type - Schema type ('app', 'model', 'prompt', 'group', 'platform', 'user')
 * @returns {Promise<Object>} JSON Schema object
 * @throws {Error} If schema type is invalid or fetch fails
 */
export async function getSchemaByType(type) {
  return fetchJsonSchema(type);
}

/**
 * Preload schemas for better performance
 * Call this during app initialization to cache commonly used schemas
 * @param {string[]} types - Schema types to preload (defaults to all)
 * @returns {Promise<void>}
 */
export async function preloadSchemas(
  types = ['app', 'model', 'prompt', 'group', 'platform', 'user']
) {
  try {
    await Promise.all(types.map(type => fetchJsonSchema(type)));
    console.log('Schemas preloaded successfully:', types);
  } catch (error) {
    console.warn('Failed to preload some schemas:', error);
  }
}

/**
 * Get validation error formatter for a schema type
 * This provides consistent error formatting across the application
 * @returns {Function} Error formatter function
 */
export function getSchemaErrorFormatter() {
  return errors => {
    if (!errors || !Array.isArray(errors)) return [];

    return errors.map(error => {
      const { instancePath, keyword, message, params } = error;
      const field = instancePath.replace('/', '') || 'root';

      switch (keyword) {
        case 'required':
          return `Missing required field: ${params?.missingProperty || field}`;
        case 'type':
          return `Field "${field}" must be of type ${params?.type}`;
        case 'pattern':
          return `Field "${field}" must match the required format`;
        case 'enum':
          return `Field "${field}" must be one of: ${params?.allowedValues?.join(', ')}`;
        case 'minimum':
          return `Field "${field}" must be at least ${params?.limit}`;
        case 'maximum':
          return `Field "${field}" must be at most ${params?.limit}`;
        case 'format':
          return `Field "${field}" must be a valid ${params?.format}`;
        case 'minLength':
          return `Field "${field}" must be at least ${params?.limit} characters long`;
        case 'maxLength':
          return `Field "${field}" must be at most ${params?.limit} characters long`;
        default:
          return `Field "${field}": ${message}`;
      }
    });
  };
}
