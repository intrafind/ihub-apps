/**
 * Image generation configuration utilities
 * Translates user-friendly settings (aspect ratio + quality) to model-specific parameters
 */

/**
 * Aspect ratio and resolution mapping table based on Google Gemini documentation
 * https://ai.google.dev/gemini-api/docs/image-generation#aspect_ratios_and_image_size
 */
const RESOLUTION_TABLE = {
  '1:1': {
    Low: { width: 1024, height: 1024, tokens: 1120, size: '1K' },
    Medium: { width: 2048, height: 2048, tokens: 1120, size: '2K' },
    High: { width: 4096, height: 4096, tokens: 2000, size: '4K' }
  },
  '2:3': {
    Low: { width: 848, height: 1264, tokens: 1120, size: '1K' },
    Medium: { width: 1696, height: 2528, tokens: 1120, size: '2K' },
    High: { width: 3392, height: 5056, tokens: 2000, size: '4K' }
  },
  '3:2': {
    Low: { width: 1264, height: 848, tokens: 1120, size: '1K' },
    Medium: { width: 2528, height: 1696, tokens: 1120, size: '2K' },
    High: { width: 5056, height: 3392, tokens: 2000, size: '4K' }
  },
  '3:4': {
    Low: { width: 896, height: 1200, tokens: 1120, size: '1K' },
    Medium: { width: 1792, height: 2400, tokens: 1120, size: '2K' },
    High: { width: 3584, height: 4800, tokens: 2000, size: '4K' }
  },
  '4:3': {
    Low: { width: 1200, height: 896, tokens: 1120, size: '1K' },
    Medium: { width: 2400, height: 1792, tokens: 1120, size: '2K' },
    High: { width: 4800, height: 3584, tokens: 2000, size: '4K' }
  },
  '4:5': {
    Low: { width: 928, height: 1152, tokens: 1120, size: '1K' },
    Medium: { width: 1856, height: 2304, tokens: 1120, size: '2K' },
    High: { width: 3712, height: 4608, tokens: 2000, size: '4K' }
  },
  '5:4': {
    Low: { width: 1152, height: 928, tokens: 1120, size: '1K' },
    Medium: { width: 2304, height: 1856, tokens: 1120, size: '2K' },
    High: { width: 4608, height: 3712, tokens: 2000, size: '4K' }
  },
  '9:16': {
    Low: { width: 768, height: 1376, tokens: 1120, size: '1K' },
    Medium: { width: 1536, height: 2752, tokens: 1120, size: '2K' },
    High: { width: 3072, height: 5504, tokens: 2000, size: '4K' }
  },
  '16:9': {
    Low: { width: 1376, height: 768, tokens: 1120, size: '1K' },
    Medium: { width: 2752, height: 1536, tokens: 1120, size: '2K' },
    High: { width: 5504, height: 3072, tokens: 2000, size: '4K' }
  },
  '21:9': {
    Low: { width: 1584, height: 672, tokens: 1120, size: '1K' },
    Medium: { width: 3168, height: 1344, tokens: 1120, size: '2K' },
    High: { width: 6336, height: 2688, tokens: 2000, size: '4K' }
  }
};

/**
 * Valid aspect ratios
 */
export const VALID_ASPECT_RATIOS = Object.keys(RESOLUTION_TABLE);

/**
 * Valid quality levels
 */
export const VALID_QUALITY_LEVELS = ['Low', 'Medium', 'High'];

/**
 * Translate user-friendly quality and aspect ratio to model-specific parameters
 *
 * @param {string} aspectRatio - Aspect ratio (e.g., '1:1', '16:9')
 * @param {string} quality - Quality level ('Low', 'Medium', 'High')
 * @param {string} provider - Model provider ('google', etc.)
 * @returns {Object} Model-specific image configuration
 */
export function translateImageConfig(aspectRatio, quality, provider = 'google') {
  // Validate inputs
  if (!aspectRatio || !VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    aspectRatio = '1:1'; // Default to square
  }

  if (!quality || !VALID_QUALITY_LEVELS.includes(quality)) {
    quality = 'Medium'; // Default to medium quality
  }

  const config = RESOLUTION_TABLE[aspectRatio][quality];

  // For Google provider, return aspectRatio and size
  if (provider === 'google') {
    return {
      aspectRatio,
      imageSize: config.size
    };
  }

  // For other providers, return exact pixel dimensions
  return {
    width: config.width,
    height: config.height,
    aspectRatio,
    quality
  };
}

/**
 * Get the resolution details for a specific aspect ratio and quality
 *
 * @param {string} aspectRatio - Aspect ratio
 * @param {string} quality - Quality level
 * @returns {Object} Resolution details (width, height, tokens, size)
 */
export function getResolutionDetails(aspectRatio, quality) {
  if (!aspectRatio || !VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    aspectRatio = '1:1';
  }

  if (!quality || !VALID_QUALITY_LEVELS.includes(quality)) {
    quality = 'Medium';
  }

  return RESOLUTION_TABLE[aspectRatio][quality];
}
