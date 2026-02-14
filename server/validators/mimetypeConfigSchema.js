import { z } from 'zod';
import logger from '../utils/logger.js';

// Localized string schema
const localizedStringSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

// Category schema - defines groups of related MIME types
const categorySchema = z.object({
  name: localizedStringSchema,
  description: localizedStringSchema.optional(),
  mimeTypes: z.array(z.string()).min(1, 'Category must have at least one MIME type')
});

// MIME type detail schema - defines properties for each MIME type
const mimeTypeDetailSchema = z.object({
  extensions: z.array(z.string()).min(1, 'MIME type must have at least one extension'),
  displayName: z.string().min(1, 'Display name is required'),
  category: z.string().min(1, 'Category is required')
});

/**
 * Mimetype configuration schema
 * Defines the structure for MIME type categories and details
 */
export const mimetypeConfigSchema = z.object({
  // Categories organize MIME types into logical groups (images, audio, documents, text)
  categories: z.record(z.string(), categorySchema).default({}),

  // Detailed information for each MIME type
  mimeTypes: z.record(z.string(), mimeTypeDetailSchema).default({})
});

/**
 * Validation helper function for mimetype configuration
 * @param {Object} config - Mimetype configuration to validate
 * @returns {Object} - { success: boolean, data?: Object, errors?: Array }
 */
export function validateMimetypeConfig(config) {
  try {
    const validated = mimetypeConfigSchema.parse(config);

    // Validate that all MIME types in categories exist in mimeTypes
    const allMimeTypesInDetails = new Set(Object.keys(validated.mimeTypes));
    const missingMimeTypes = [];

    for (const [categoryId, category] of Object.entries(validated.categories)) {
      for (const mimeType of category.mimeTypes) {
        if (!allMimeTypesInDetails.has(mimeType)) {
          missingMimeTypes.push({
            category: categoryId,
            mimeType
          });
        }
      }
    }

    if (missingMimeTypes.length > 0) {
      logger.warn('Some MIME types in categories lack detailed definitions:', {
        component: 'MimetypeConfig',
        missingMimeTypes
      });
    }

    // Validate that all MIME types reference valid categories
    const allCategories = new Set(Object.keys(validated.categories));
    const invalidCategories = [];

    for (const [mimeType, details] of Object.entries(validated.mimeTypes)) {
      if (!allCategories.has(details.category)) {
        invalidCategories.push({
          mimeType,
          category: details.category
        });
      }
    }

    if (invalidCategories.length > 0) {
      logger.warn('Some MIME types reference non-existent categories:', {
        component: 'MimetypeConfig',
        invalidCategories
      });
    }

    return { success: true, data: validated };
  } catch (error) {
    logger.error('Mimetype validation error:', { component: 'ConfigLoader', error });
    return {
      success: false,
      errors: error.errors || [{ message: error.message }]
    };
  }
}

/**
 * Get default mimetype configuration
 * @returns {Object} - Default mimetype configuration
 */
export function getDefaultMimetypeConfig() {
  return {
    categories: {},
    mimeTypes: {}
  };
}
