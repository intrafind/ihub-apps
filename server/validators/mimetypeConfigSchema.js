import { z } from 'zod';
import logger from '../utils/logger.js';

/**
 * Mimetype configuration schema
 * Defines the structure for MIME type mappings and display names
 */
export const mimetypeConfigSchema = z.object({
  // Array of supported text format MIME types
  supportedTextFormats: z.array(z.string()).default([]),

  // Mapping from MIME type to file extension(s)
  // Extensions can be comma-separated (e.g., ".jpeg,.jpg")
  mimeToExtension: z.record(z.string(), z.string()).default({}),

  // Mapping from MIME type to display name
  // Used for UI labels (e.g., "application/pdf" -> "PDF")
  typeDisplayNames: z.record(z.string(), z.string()).default({})
});

/**
 * Validation helper function for mimetype configuration
 * @param {Object} config - Mimetype configuration to validate
 * @returns {Object} - { success: boolean, data?: Object, errors?: Array }
 */
export function validateMimetypeConfig(config) {
  try {
    const validated = mimetypeConfigSchema.parse(config);

    // Validate that all supported text formats have extension mappings
    const missingExtensions = validated.supportedTextFormats.filter(
      mimeType => !validated.mimeToExtension[mimeType]
    );

    if (missingExtensions.length > 0) {
      logger.warn('Some MIME types lack extension mappings:', {
        component: 'MimetypeConfig',
        missingExtensions
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
    supportedTextFormats: [],
    mimeToExtension: {},
    typeDisplayNames: {}
  };
}
