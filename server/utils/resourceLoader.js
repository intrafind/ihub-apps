// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../services/config/ConfigStore.js';
import logger from './logger.js';

/**
 * Generic Resource Loader Factory
 *
 * Creates a resource loader that loads resources from individual files.
 *
 * `server/resourceLoaders.js` holds the table of what is loaded this way.
 *
 * The files are read through {@link module:services/config/ConfigStore}, so
 * apps, models, prompts and the rest go through the storage provider like every
 * other configuration file. That also gives them the `CONTENTS_DIR` setting,
 * which the hardcoded `contents/` path this loader used to build ignored: an
 * installation with a relocated contents directory silently loaded no
 * resources at all.
 */

/**
 * The display name of a resource: its `name` (the English text of a localized
 * one, else the first), else its id.
 *
 * @param {Object} item
 * @returns {string}
 */
export function nameOf(item) {
  if (item.name && typeof item.name === 'object') {
    return item.name.en || item.name[Object.keys(item.name)[0]] || '';
  }
  return item.name || item.id || '';
}

/**
 * The default order of a resource list: by `order` (items without one last),
 * then by name.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
export function compareByOrderThenName(a, b) {
  const orderA = a.order ?? 999;
  const orderB = b.order ?? 999;
  if (orderA !== orderB) return orderA - orderB;
  return nameOf(a).localeCompare(nameOf(b));
}

/**
 * Create a resource loader with the specified configuration
 * @param {Object} config - Loader configuration
 * @param {string} config.resourceName - Name of the resource (for logging)
 * @param {string} config.individualPath - Path to individual files directory (relative to contents/)
 * @param {Function} config.schema - Optional validation schema function
 * @param {Function} config.validateItem - Optional item validation function
 * @param {Function} config.processItem - Optional item processing function
 * @param {Function} config.postProcess - Optional post-processing function for all items
 * @param {Function} config.sortComparator - Optional custom sort function (default: `order`, then name)
 * @param {Function} config.inspect - Optional diagnostic run on every loaded item list; must not throw
 * @returns {Object} Resource loader object with loadAll() method
 */
export function createResourceLoader({
  resourceName,
  individualPath,
  validateItem,
  processItem,
  postProcess,
  sortComparator,
  inspect
}) {
  if (!resourceName || !individualPath) {
    throw new Error('resourceName and individualPath are required');
  }

  /**
   * Load resources from individual files
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadFromFiles(verbose = true) {
    // Files that do not parse never reach here: the store skips them and logs
    // them itself, the same outcome as the per-file catch this loop used to do.
    const documents = await configStore.listDocuments(individualPath);

    if (documents.length === 0) {
      if (verbose) {
        logger.info('No individual resource files found, skipping', {
          component: 'ResourceLoader',
          resourceName,
          individualPath
        });
      }
      return [];
    }

    if (verbose) {
      logger.info('Loading resource', {
        component: 'ResourceLoader',
        resourceName,
        count: documents.length
      });
    }

    const resources = [];
    const loadedItems = [];
    const errorItems = [];

    for (const document of documents) {
      const source = document.path;
      try {
        let resource = document.data;

        // Add enabled field if it doesn't exist (defaults to true)
        if (resource.enabled === undefined) {
          resource.enabled = true;
        }

        // Process item if processor is provided
        if (processItem) {
          resource = processItem(resource, source);
        }

        // Validate item if validator is provided
        if (validateItem) {
          resource = validateItem(resource, source);
        }

        resources.push(resource);
        if (verbose) {
          const icon = resource.enabled ? '✅' : '⏸️';
          loadedItems.push({ id: resource.id, enabled: resource.enabled !== false, icon });
        }
      } catch (error) {
        errorItems.push({ file: source, error: error.message });
      }
    }

    // Log each item individually for better filtering
    if (verbose && loadedItems.length > 0) {
      for (const item of loadedItems) {
        logger.info('Resource loaded', {
          component: 'ResourceLoader',
          resourceId: item.id,
          enabled: item.enabled
        });
      }
    }
    if (errorItems.length > 0) {
      for (const item of errorItems) {
        logger.error('Failed to load resource file', {
          component: 'ResourceLoader',
          file: item.file,
          error: item.error
        });
      }
    }

    return resources;
  }

  /**
   * Load all resources from the individual files
   * @param {boolean} includeDisabled - Whether to include disabled resources
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadAll(includeDisabled = false, verbose = true) {
    const allResources = await loadFromFiles(verbose);
    if (inspect) inspect(allResources);
    let filteredResources = allResources.filter(
      resource => includeDisabled || resource.enabled !== false
    );

    // Apply post-processing if provided
    if (postProcess) {
      filteredResources = postProcess(filteredResources);
    }

    // Sort resources
    const sortFunction = sortComparator || compareByOrderThenName;
    filteredResources.sort(sortFunction);

    if (verbose) {
      const enabledCount = allResources.filter(r => r.enabled !== false).length;
      const disabledCount = allResources.length - enabledCount;
      logger.info('Resource loading summary', {
        component: 'ResourceLoader',
        resourceName,
        total: allResources.length,
        enabled: enabledCount,
        disabled: disabledCount
      });
    }

    return filteredResources;
  }

  // Return the resource loader object
  return {
    loadAll,
    loadFromFiles,
    resourceName,
    individualPath
  };
}

/**
 * Helper function to create a simple validation function
 * @param {Array} requiredFields - Array of required field names
 * @returns {Function} Validation function that returns the validated item
 */
export function createValidator(requiredFields = []) {
  return function (item, source) {
    const missing = requiredFields.filter(field => !(field in item) || item[field] == null);
    if (missing.length > 0) {
      logger.warn('Missing required fields in resource', {
        component: 'ResourceLoader',
        source,
        missing
      });
    }
    return item;
  };
}

/**
 * Directory a source path sits in, mapped to the resource type it holds.
 * Ordered: `config/groups` has to be recognized before the wider `config/`.
 */
const RESOURCE_TYPES_BY_DIRECTORY = [
  ['apps/', 'app'],
  ['models/', 'model'],
  ['prompts/', 'prompt'],
  ['sources/', 'source'],
  ['config/groups', 'group'],
  ['config/', 'config']
];

/**
 * Helper function to extract resource type from file path
 *
 * Sources are contents-relative (`apps/chat.json`) since resources are loaded
 * through the config store, so the directory is matched at the start of the
 * path as well as after a separator.
 *
 * @param {string} source - File path or source string
 * @returns {string} Resource type (app, model, prompt, tool, source, etc.)
 */
function extractResourceType(source) {
  const match = RESOURCE_TYPES_BY_DIRECTORY.find(
    ([directory]) => source.startsWith(directory) || source.includes(`/${directory}`)
  );
  return match ? match[1] : 'resource';
}

/**
 * Helper function to create a schema validation function
 * @param {Object} schema - Zod schema object
 * @param {Array} knownKeys - Array of known valid keys
 * @returns {Function} Schema validation function that returns the validated/parsed item
 */
export function createSchemaValidator(schema, knownKeys = []) {
  return function (item, source) {
    const resourceType = extractResourceType(source);
    const resourceId = item.id || 'unknown';

    let validatedItem = item;

    // Validate with schema if provided
    if (schema) {
      const result = schema.safeParse(item);
      if (!result.success) {
        const messages = result.error.issues
          .map(e => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        logger.warn('Resource validation issues', {
          component: 'ResourceLoader',
          resourceType,
          resourceId,
          messages
        });
      } else {
        // Apply the parsed data which includes Zod defaults
        validatedItem = result.data;
      }
    }

    // Check for unknown keys
    if (knownKeys.length > 0) {
      const unknown = Object.keys(validatedItem).filter(key => !knownKeys.includes(key));
      if (unknown.length > 0) {
        logger.warn('Resource has unknown keys', {
          component: 'ResourceLoader',
          resourceType,
          resourceId,
          unknown
        });
      }
    }

    return validatedItem;
  };
}
