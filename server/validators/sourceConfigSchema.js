import { z } from 'zod';
import logger from '../utils/logger.js';

// Localized string schema - matches client pattern for language codes
const localizedStringSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

/**
 * Base source configuration schema
 * Common fields for all source types
 */
const baseSourceSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      'Source ID must contain only alphanumeric characters, underscores, dots, and hyphens'
    )
    .min(1, 'Source ID cannot be empty')
    .max(50, 'Source ID cannot exceed 50 characters'),
  name: localizedStringSchema,
  description: localizedStringSchema.optional(),
  type: z.enum(['filesystem', 'url', 'ifinder', 'page'], {
    errorMap: () => ({ message: 'Type must be filesystem, url, ifinder, or page' })
  }),
  enabled: z.boolean().default(true),
  exposeAs: z.enum(['prompt', 'tool']).default('prompt'),
  category: z.string().optional(),
  tags: z.array(z.string()).default([]),
  created: z.string().optional(),
  updated: z.string().optional()
});

/**
 * Filesystem source configuration schema
 * Complete schema to match FileSystemHandler expectations and client form
 */
const filesystemConfigSchema = z
  .object({
    path: z.string().min(1, 'File path is required'),
    encoding: z.string().default('utf-8')
  })
  .strict();

/**
 * URL source configuration schema
 * Complete schema to match URLHandler expectations and client form
 */
const urlConfigSchema = z
  .object({
    url: z.string().url('Valid URL is required'),
    method: z.enum(['GET', 'POST']).default('GET'),
    headers: z.record(z.string()).default({}),
    timeout: z.number().min(1000).max(60000).default(10000),
    followRedirects: z.boolean().default(true),
    maxRedirects: z.number().min(0).max(10).default(5),
    retries: z.number().min(0).max(10).default(3),
    maxContentLength: z.number().positive().default(1048576),
    cleanContent: z.boolean().default(true)
  })
  .strict();

/**
 * iFinder source configuration schema
 * Complete schema to match IFinderHandler expectations and client form
 */
const ifinderConfigSchema = z
  .object({
    baseUrl: z.string().url('Valid base URL is required'),
    apiKey: z.string().min(1, 'API key is required'),
    searchProfile: z.string().default('default'),
    maxResults: z.number().min(1).max(100).default(10),
    queryTemplate: z.string().default(''),
    filters: z.record(z.any()).default({}),
    maxLength: z.number().positive().default(10000)
  })
  .strict();

/**
 * Page source configuration schema
 * Complete schema to match PageHandler expectations and client form
 */
const pageConfigSchema = z
  .object({
    pageId: z
      .string()
      .min(1, 'Page ID is required')
      .regex(
        /^[a-zA-Z0-9._-]+$/,
        'Page ID must contain only letters, numbers, underscores, dots, and hyphens'
      ),
    language: z.string().default('en')
  })
  .strict();

/**
 * Caching configuration schema
 */
const cachingConfigSchema = z.object({
  ttl: z.number().positive().default(3600), // 1 hour in seconds
  strategy: z.enum(['static', 'refresh']).default('static'),
  enabled: z.boolean().default(true)
});

/**
 * Complete source configuration schema
 * Uses discriminated union for type-specific config validation
 */
export const sourceConfigSchema = z.discriminatedUnion('type', [
  baseSourceSchema.extend({
    type: z.literal('filesystem'),
    config: filesystemConfigSchema,
    caching: cachingConfigSchema.optional()
  }),
  baseSourceSchema.extend({
    type: z.literal('url'),
    config: urlConfigSchema,
    caching: cachingConfigSchema.optional()
  }),
  baseSourceSchema.extend({
    type: z.literal('ifinder'),
    config: ifinderConfigSchema,
    caching: cachingConfigSchema.optional()
  }),
  baseSourceSchema.extend({
    type: z.literal('page'),
    config: pageConfigSchema,
    caching: cachingConfigSchema.optional()
  })
]);

/**
 * Array of sources schema for configuration files
 */
export const sourcesArraySchema = z.array(sourceConfigSchema);

/**
 * Validation helper function for single source configuration
 * @param {Object} source - Source configuration to validate
 * @returns {Object} - { success: boolean, data?: Object, errors?: Array }
 */
export function validateSourceConfig(source) {
  try {
    // Add validation timestamp if not present
    const sourceWithTimestamp = {
      ...source,
      updated: source.updated || new Date().toISOString()
    };

    const validated = sourceConfigSchema.parse(sourceWithTimestamp);

    // Additional custom validation based on type
    if (validated.type === 'filesystem') {
      validateFilesystemPath(validated.config.path);
    }

    if (validated.type === 'url') {
      validateUrlConfig(validated.config);
    }

    if (validated.type === 'ifinder') {
      validateIFinderConfig(validated.config);
    }

    if (validated.type === 'page') {
      validatePageConfig(validated.config);
    }

    return { success: true, data: validated };
  } catch (error) {
    logger.error('Source validation error:', error);
    return {
      success: false,
      errors: error.errors || [{ message: error.message }]
    };
  }
}

/**
 * Validation helper function for array of sources
 * @param {Array} sources - Array of source configurations
 * @returns {Object} - { success: boolean, data?: Array, errors?: Array }
 */
export function validateSourcesArray(sources) {
  try {
    const validated = sourcesArraySchema.parse(sources);

    // Check for duplicate IDs
    const ids = validated.map(s => s.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

    if (duplicateIds.length > 0) {
      throw new Error(`Duplicate source IDs found: ${duplicateIds.join(', ')}`);
    }

    return { success: true, data: validated };
  } catch (error) {
    logger.error('Sources array validation error:', error);
    return {
      success: false,
      errors: error.errors || [{ message: error.message }]
    };
  }
}

/**
 * Validate filesystem path for security
 * Prevents path traversal and other security issues
 * @param {string} path - File system path to validate
 */
function validateFilesystemPath(path) {
  // Prevent path traversal attacks
  if (path.includes('..') || path.includes('~')) {
    throw new Error('Invalid file path: Path traversal not allowed');
  }

  // Prevent absolute paths that could access system files
  if (path.startsWith('/') && !path.startsWith('/app/') && !path.startsWith('/workspace/')) {
    throw new Error('Invalid file path: Absolute paths to system directories not allowed');
  }

  // Ensure path doesn't start with ./ (should be relative)
  if (path.startsWith('./')) {
    throw new Error('Invalid file path: Use relative paths without ./ prefix');
  }

  // Check for dangerous paths
  const dangerousPaths = ['/etc', '/var', '/usr', '/sys', '/proc', '/root'];
  for (const dangerousPath of dangerousPaths) {
    if (path.startsWith(dangerousPath)) {
      throw new Error(`Invalid file path: Access to ${dangerousPath} not allowed`);
    }
  }
}

/**
 * Validate URL configuration
 * @param {Object} config - URL configuration to validate
 */
function validateUrlConfig(config) {
  const { url } = config;

  // Validate URL protocol
  const urlObj = new URL(url);
  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new Error('Invalid URL: Only HTTP and HTTPS protocols are allowed');
  }

  // Additional validation is handled by the Zod schema
}

/**
 * Validate iFinder configuration
 * @param {Object} config - iFinder configuration to validate
 */
function validateIFinderConfig(config) {
  const { baseUrl } = config;

  // Validate base URL protocol
  const urlObj = new URL(baseUrl);
  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new Error('Invalid iFinder base URL: Only HTTP and HTTPS protocols are allowed');
  }

  // Additional validation is handled by the Zod schema
}

/**
 * Validate Page configuration
 * @param {Object} config - Page configuration to validate
 */
function validatePageConfig(config) {
  const { pageId } = config;

  // Additional page ID validation
  if (pageId && pageId.length > 100) {
    throw new Error('Page ID cannot exceed 100 characters');
  }

  // Additional validation is handled by the Zod schema
}

/**
 * Get default source configuration for a given type
 * @param {string} type - Source type ('filesystem', 'url', 'ifinder', 'page')
 * @returns {Object} - Default source configuration
 */
export function getDefaultSourceConfig(type) {
  const baseConfig = {
    id: '',
    name: { en: '' },
    description: { en: '' },
    type,
    enabled: true,
    exposeAs: 'prompt',
    category: '',
    tags: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };

  switch (type) {
    case 'filesystem':
      return {
        ...baseConfig,
        config: {
          path: '',
          encoding: 'utf-8'
        }
      };

    case 'url':
      return {
        ...baseConfig,
        config: {
          url: '',
          method: 'GET',
          headers: {},
          timeout: 10000,
          followRedirects: true,
          maxRedirects: 5,
          retries: 3,
          maxContentLength: 1048576, // 1MB
          cleanContent: true
        }
      };

    case 'ifinder':
      return {
        ...baseConfig,
        config: {
          baseUrl: '',
          apiKey: '',
          searchProfile: 'default',
          maxResults: 10,
          queryTemplate: '',
          filters: {},
          maxLength: 10000
        }
      };

    case 'page':
      return {
        ...baseConfig,
        config: {
          pageId: '',
          language: 'en'
        }
      };

    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}

export const knownSourceKeys = Object.keys(sourceConfigSchema.options[0].shape);
