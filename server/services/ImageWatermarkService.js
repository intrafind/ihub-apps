/**
 * Image Watermark Service
 *
 * Adds watermarks and metadata to generated images.
 * Supports installation-specific and user-specific watermarks.
 */
import sharp from 'sharp';
import logger from '../utils/logger.js';

class ImageWatermarkService {
  /**
   * Add watermark and metadata to an image
   *
   * @param {string} base64ImageData - Base64 encoded image data
   * @param {string} mimeType - Image MIME type (e.g., 'image/png', 'image/jpeg')
   * @param {Object} watermarkConfig - Watermark configuration
   * @param {Object} metadata - Additional metadata (user info, timestamp, etc.)
   * @returns {Promise<Object>} Object with watermarked base64 data and mimeType
   */
  async addWatermark(base64ImageData, mimeType, watermarkConfig = {}, metadata = {}) {
    try {
      // If watermark is disabled, return original image
      if (!watermarkConfig.enabled) {
        return { data: base64ImageData, mimeType };
      }

      // Convert base64 to buffer
      const imageBuffer = Buffer.from(base64ImageData, 'base64');

      // Get image metadata to determine dimensions
      const imageMetadata = await sharp(imageBuffer).metadata();
      const { width, height, format } = imageMetadata;

      logger.info({
        component: 'ImageWatermarkService',
        message: 'Processing image for watermarking',
        dimensions: { width, height },
        format
      });

      // Build watermark text
      const watermarkText = this._buildWatermarkText(watermarkConfig, metadata);

      // Calculate font size based on image dimensions (1-2% of image height)
      const fontSize = Math.max(12, Math.floor(height * 0.015));

      // Calculate position
      const position = watermarkConfig.position || 'bottom-right';
      const padding = Math.floor(height * 0.02); // 2% padding

      // Create SVG watermark
      const svgWatermark = this._createSvgWatermark(
        watermarkText,
        fontSize,
        watermarkConfig.opacity || 0.5,
        watermarkConfig.textColor || '#ffffff'
      );

      // Calculate watermark position
      const watermarkPosition = this._calculatePosition(
        position,
        width,
        height,
        padding,
        watermarkText,
        fontSize
      );

      // Apply watermark
      let processedImage = sharp(imageBuffer);

      // Composite watermark onto image
      processedImage = processedImage.composite([
        {
          input: Buffer.from(svgWatermark),
          top: watermarkPosition.top,
          left: watermarkPosition.left
        }
      ]);

      // Add EXIF/IPTC metadata
      if (metadata) {
        const exifMetadata = this._buildExifMetadata(metadata, watermarkConfig);
        processedImage = processedImage.withMetadata(exifMetadata);
      }

      // Convert back to buffer and base64
      const outputFormat = format === 'png' ? 'png' : 'jpeg';
      const outputBuffer = await processedImage[outputFormat]({ quality: 95 }).toBuffer();
      const outputBase64 = outputBuffer.toString('base64');

      logger.info({
        component: 'ImageWatermarkService',
        message: 'Watermark applied successfully',
        originalSize: imageBuffer.length,
        outputSize: outputBuffer.length,
        watermarkText
      });

      return {
        data: outputBase64,
        mimeType: `image/${outputFormat}`
      };
    } catch (error) {
      logger.error({
        component: 'ImageWatermarkService',
        message: 'Failed to add watermark',
        error: error.message,
        stack: error.stack
      });

      // Return original image on error
      return { data: base64ImageData, mimeType };
    }
  }

  /**
   * Build watermark text from configuration and metadata
   */
  _buildWatermarkText(config, metadata) {
    let text = config.text || 'iHub Apps';

    // Add user information if enabled and available
    if (config.includeUser && metadata.user) {
      const userName = metadata.user.name || metadata.user.username || metadata.user.id;
      if (userName) {
        text = `${text} | ${userName}`;
      }
    }

    // Add timestamp if enabled
    if (config.includeTimestamp) {
      const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      text = `${text} | ${date}`;
    }

    return text;
  }

  /**
   * Create SVG watermark with text
   */
  _createSvgWatermark(text, fontSize, opacity, color) {
    // Estimate text width (rough approximation: 0.6 * fontSize per character)
    const textWidth = Math.ceil(text.length * fontSize * 0.6);
    const textHeight = Math.ceil(fontSize * 1.5);

    // Add shadow for better readability
    const shadow = `<filter id="shadow">
      <feDropShadow dx="1" dy="1" stdDeviation="2" flood-opacity="${opacity * 0.5}" />
    </filter>`;

    return `
      <svg width="${textWidth}" height="${textHeight}" xmlns="http://www.w3.org/2000/svg">
        <defs>${shadow}</defs>
        <text 
          x="0" 
          y="${fontSize}" 
          font-family="Arial, sans-serif" 
          font-size="${fontSize}" 
          fill="${color}" 
          opacity="${opacity}"
          filter="url(#shadow)"
        >${text}</text>
      </svg>
    `;
  }

  /**
   * Calculate watermark position based on configuration
   */
  _calculatePosition(position, imageWidth, imageHeight, padding, text, fontSize) {
    // Rough estimate of text dimensions
    const textWidth = text.length * fontSize * 0.6;
    const textHeight = fontSize * 1.5;

    const positions = {
      'top-left': { top: padding, left: padding },
      'top-right': { top: padding, left: imageWidth - textWidth - padding },
      'bottom-left': { top: imageHeight - textHeight - padding, left: padding },
      'bottom-right': {
        top: imageHeight - textHeight - padding,
        left: imageWidth - textWidth - padding
      },
      center: {
        top: Math.floor((imageHeight - textHeight) / 2),
        left: Math.floor((imageWidth - textWidth) / 2)
      }
    };

    return positions[position] || positions['bottom-right'];
  }

  /**
   * Build EXIF/IPTC metadata
   */
  _buildExifMetadata(metadata, config) {
    const exif = {
      ifd0: {},
      exif: {}
    };

    // Add creator/artist information
    if (metadata.user) {
      const creator = metadata.user.name || metadata.user.username || metadata.user.id;
      exif.ifd0.Artist = creator;
      exif.ifd0.Copyright = `© ${new Date().getFullYear()} ${config.text || 'iHub Apps'}`;
    }

    // Add creation timestamp
    exif.exif.DateTimeOriginal = new Date().toISOString();

    // Add software/generator information
    exif.ifd0.Software = config.text || 'iHub Apps';

    // Add custom description with installation info
    if (config.installationId) {
      exif.ifd0.ImageDescription = `Generated by ${config.text || 'iHub Apps'} (Installation: ${config.installationId})`;
    } else {
      exif.ifd0.ImageDescription = `Generated by ${config.text || 'iHub Apps'}`;
    }

    return { exif };
  }
}

export default new ImageWatermarkService();
