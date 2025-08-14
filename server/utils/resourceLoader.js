import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../pathUtils.js';

/**
 * Generic Resource Loader Factory
 *
 * Creates a resource loader that can load resources from both individual files
 * and legacy JSON array files for backward compatibility.
 *
 * This eliminates the duplication between appsLoader, modelsLoader, and promptsLoader.
 */

/**
 * Create a resource loader with the specified configuration
 * @param {Object} config - Loader configuration
 * @param {string} config.resourceName - Name of the resource (for logging)
 * @param {string} config.legacyPath - Path to legacy JSON file (relative to contents/)
 * @param {string} config.individualPath - Path to individual files directory (relative to contents/)
 * @param {Function} config.schema - Optional validation schema function
 * @param {Function} config.validateItem - Optional item validation function
 * @param {Function} config.processItem - Optional item processing function
 * @param {Function} config.postProcess - Optional post-processing function for all items
 * @param {Function} config.sortComparator - Optional custom sort function
 * @returns {Object} Resource loader object with loadAll() method
 */
export function createResourceLoader({
  resourceName,
  legacyPath,
  individualPath,
  validateItem,
  processItem,
  postProcess,
  sortComparator
}) {
  if (!resourceName || !legacyPath || !individualPath) {
    throw new Error('resourceName, legacyPath, and individualPath are required');
  }

  /**
   * Load resources from individual files
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadFromFiles(verbose = true) {
    const rootDir = getRootDir();
    const resourceDir = join(rootDir, 'contents', individualPath);

    if (!existsSync(resourceDir)) {
      if (verbose) {
        console.log(
          `📁 ${resourceName} directory not found, skipping individual ${resourceName.toLowerCase()} files`
        );
      }
      return [];
    }

    const resources = [];
    const dirContents = await fs.readdir(resourceDir);
    const files = dirContents.filter(file => file.endsWith('.json'));

    if (verbose && files.length > 0) {
      console.log(`\n━━━ Loading ${resourceName} ━━━`);
      console.log(`📱 Found ${files.length} ${resourceName.toLowerCase()} files`);
    }

    const loadedItems = [];
    const errorItems = [];

    for (const file of files) {
      try {
        const filePath = join(resourceDir, file);
        const fileContent = await fs.readFile(filePath, 'utf8');
        let resource = JSON.parse(fileContent);

        // Add enabled field if it doesn't exist (defaults to true)
        if (resource.enabled === undefined) {
          resource.enabled = true;
        }

        // Process item if processor is provided
        if (processItem) {
          resource = processItem(resource, filePath);
        }

        // Validate item if validator is provided
        if (validateItem) {
          validateItem(resource, filePath);
        }

        resources.push(resource);
        if (verbose) {
          const icon = resource.enabled ? '✅' : '⏸️';
          loadedItems.push(`   ${icon} ${resource.id}`);
        }
      } catch (error) {
        errorItems.push(`   ❌ ${file}: ${error.message}`);
      }
    }

    // Log all items together for better clustering
    if (verbose && loadedItems.length > 0) {
      console.log(loadedItems.join('\n'));
    }
    if (errorItems.length > 0) {
      console.log(errorItems.join('\n'));
    }

    return resources;
  }

  /**
   * Load resources from legacy JSON file
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadFromLegacyFile(verbose = true) {
    const rootDir = getRootDir();
    const legacyFilePath = join(rootDir, 'contents', legacyPath);

    if (!existsSync(legacyFilePath)) {
      if (verbose) {
        console.log(`📄 Legacy ${legacyPath} not found, skipping`);
      }
      return [];
    }

    try {
      const fileContent = await fs.readFile(legacyFilePath, 'utf8');
      let resources = JSON.parse(fileContent);

      if (!Array.isArray(resources)) {
        console.warn(`⚠️  Legacy ${legacyPath} is not an array`);
        return [];
      }

      if (verbose) {
        console.log(
          `📄 Loading ${resources.length} ${resourceName.toLowerCase()}s from legacy ${legacyPath}...`
        );
      }

      // Process each resource
      resources = resources.map((resource, idx) => {
        // Add enabled field if it doesn't exist (defaults to true)
        if (resource.enabled === undefined) {
          resource.enabled = true;
        }

        // Process item if processor is provided
        let processedResource = resource;
        if (processItem) {
          processedResource = processItem(resource, `${legacyFilePath}[${idx}]`);
        }

        // Validate item if validator is provided
        if (validateItem) {
          validateItem(processedResource, `${legacyFilePath}[${idx}]`);
        }

        return processedResource;
      });

      return resources;
    } catch (error) {
      console.error(`❌ Error loading legacy ${legacyPath}:`, error.message);
      return [];
    }
  }

  /**
   * Default sort comparator
   * @param {Object} a - First item
   * @param {Object} b - Second item
   * @returns {number} Sort comparison result
   */
  function defaultSort(a, b) {
    // Sort by order field first (items without order go to the end)
    const orderA = a.order ?? 999;
    const orderB = b.order ?? 999;
    if (orderA !== orderB) {
      return orderA - orderB;
    }

    // Then by name (handle both string and object names)
    const getNameString = item => {
      if (typeof item.name === 'object' && item.name) {
        return item.name.en || item.name[Object.keys(item.name)[0]] || '';
      }
      return item.name || item.id || '';
    };

    const nameA = getNameString(a);
    const nameB = getNameString(b);
    return nameA.localeCompare(nameB);
  }

  /**
   * Load all resources from both sources
   * Individual files take precedence over legacy file
   * @param {boolean} includeDisabled - Whether to include disabled resources
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadAll(includeDisabled = false, verbose = true) {
    const individualResources = await loadFromFiles(verbose);
    const legacyResources = await loadFromLegacyFile(verbose);

    // Create a map to track resources by ID
    const resourcesMap = new Map();

    // Add legacy resources first
    legacyResources.forEach(resource => {
      resourcesMap.set(resource.id, resource);
    });

    // Individual files override legacy resources
    individualResources.forEach(resource => {
      resourcesMap.set(resource.id, resource);
    });

    // Convert map to array and filter resources
    const allResources = Array.from(resourcesMap.values());
    let filteredResources = allResources.filter(
      resource => resource.enabled === true || includeDisabled
    );

    // Apply post-processing if provided
    if (postProcess) {
      filteredResources = postProcess(filteredResources);
    }

    // Sort resources
    const sortFunction = sortComparator || defaultSort;
    filteredResources.sort(sortFunction);

    if (verbose) {
      const enabledCount = allResources.filter(r => r.enabled !== false).length;
      const disabledCount = allResources.length - enabledCount;
      console.log(
        `📊 Summary: ${allResources.length} ${resourceName.toLowerCase()}s ` +
          `(${enabledCount} enabled, ${disabledCount} disabled)`
      );
    }

    return filteredResources;
  }

  /**
   * Load resources from individual files only
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadFromFilesOnly(verbose = true) {
    return await loadFromFiles(verbose);
  }

  /**
   * Load resources from legacy file only
   * @param {boolean} verbose - Whether to log verbose output
   * @returns {Array} Array of resource objects
   */
  async function loadFromLegacyOnly(verbose = true) {
    return await loadFromLegacyFile(verbose);
  }

  // Return the resource loader object
  return {
    loadAll,
    loadFromFiles: loadFromFilesOnly,
    loadFromLegacy: loadFromLegacyOnly,
    resourceName,
    legacyPath,
    individualPath
  };
}

/**
 * Helper function to create a simple validation function
 * @param {Array} requiredFields - Array of required field names
 * @returns {Function} Validation function
 */
export function createValidator(requiredFields = []) {
  return function (item, source) {
    const missing = requiredFields.filter(field => !(field in item) || item[field] == null);
    if (missing.length > 0) {
      console.warn(`⚠️  Missing required fields in ${source}: ${missing.join(', ')}`);
    }
  };
}

/**
 * Helper function to extract resource type from file path
 * @param {string} source - File path or source string
 * @returns {string} Resource type (app, model, prompt, tool, source, etc.)
 */
function extractResourceType(source) {
  if (source.includes('/apps/')) return 'app';
  if (source.includes('/models/')) return 'model';
  if (source.includes('/prompts/')) return 'prompt';
  if (source.includes('/tools/')) return 'tool';
  if (source.includes('/sources/')) return 'source';
  if (source.includes('/config/groups')) return 'group';
  if (source.includes('/config/')) return 'config';
  return 'resource';
}

/**
 * Helper function to create a schema validation function
 * @param {Object} schema - Zod schema object
 * @param {Array} knownKeys - Array of known valid keys
 * @returns {Function} Schema validation function
 */
export function createSchemaValidator(schema, knownKeys = []) {
  return function (item, source) {
    const resourceType = extractResourceType(source);
    const resourceId = item.id || 'unknown';

    // Validate with schema if provided
    if (schema) {
      const { success, error } = schema.safeParse(item);
      if (!success && error) {
        const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        console.warn(`⚠️  ${resourceType}: ${resourceId} - validation issues: ${messages}`);
      }
    }

    // Check for unknown keys
    if (knownKeys.length > 0) {
      const unknown = Object.keys(item).filter(key => !knownKeys.includes(key));
      if (unknown.length > 0) {
        console.warn(`⚠️  ${resourceType}: ${resourceId} - unknown keys: ${unknown.join(', ')}`);
      }
    }
  };
}
