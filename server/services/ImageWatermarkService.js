/**
 * Image Watermark Service
 *
 * Adds watermarks and metadata to generated images.
 * Supports installation-specific and user-specific watermarks.
 * Supports text watermarks, SVG logo watermarks, and C2PA-style signing.
 */
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';

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

      // Determine watermark type: logo, text, or both
      const hasLogo = watermarkConfig.logo && watermarkConfig.logo.length > 0;
      const hasText = watermarkConfig.text && watermarkConfig.text.length > 0;

      let watermarkBuffer;
      let watermarkWidth;
      let watermarkHeight;

      if (hasLogo && hasText) {
        // Both logo and text
        const result = await this._createLogoAndTextWatermark(
          watermarkConfig,
          watermarkText,
          fontSize,
          width,
          height
        );
        watermarkBuffer = result.buffer;
        watermarkWidth = result.width;
        watermarkHeight = result.height;
      } else if (hasLogo) {
        // Logo only
        const result = await this._createLogoWatermark(watermarkConfig, width, height);
        watermarkBuffer = result.buffer;
        watermarkWidth = result.width;
        watermarkHeight = result.height;
      } else {
        // Text only (original behavior)
        const svgWatermark = this._createSvgWatermark(
          watermarkText,
          fontSize,
          watermarkConfig.opacity || 0.5,
          watermarkConfig.textColor || '#ffffff'
        );
        watermarkBuffer = Buffer.from(svgWatermark);
        // Rough estimate for positioning
        watermarkWidth = watermarkText.length * fontSize * 0.6;
        watermarkHeight = fontSize * 1.5;
      }

      // Calculate watermark position
      const watermarkPosition = this._calculatePosition(
        position,
        width,
        height,
        padding,
        watermarkWidth,
        watermarkHeight
      );

      // Apply watermark
      let processedImage = sharp(imageBuffer);

      // Composite watermark onto image
      processedImage = processedImage.composite([
        {
          input: watermarkBuffer,
          top: watermarkPosition.top,
          left: watermarkPosition.left
        }
      ]);

      // Add EXIF/IPTC metadata
      let exifMetadata = null;
      if (metadata) {
        exifMetadata = this._buildExifMetadata(metadata, watermarkConfig);
        processedImage = processedImage.withMetadata(exifMetadata);
      }

      // Add C2PA-style provenance if enabled
      if (watermarkConfig.enableC2PA && metadata.jwtSecret) {
        const c2paManifest = await this._createC2PAManifest(
          metadata,
          watermarkConfig,
          imageMetadata,
          exifMetadata
        );
        const signedManifest = this._signManifest(c2paManifest, metadata.jwtSecret);

        // Embed signed manifest in EXIF UserComment
        if (!exifMetadata) {
          exifMetadata = { exif: {} };
        }
        if (!exifMetadata.exif) {
          exifMetadata.exif = {};
        }
        exifMetadata.exif.UserComment = JSON.stringify(signedManifest);
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
        watermarkType: hasLogo ? (hasText ? 'logo+text' : 'logo') : 'text',
        c2paEnabled: watermarkConfig.enableC2PA || false
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
  _calculatePosition(position, imageWidth, imageHeight, padding, watermarkWidth, watermarkHeight) {
    // Ensure positions are valid integers (sharp requires this)
    const ensureInt = val => Math.max(0, Math.floor(val));

    const positions = {
      'top-left': {
        top: ensureInt(padding),
        left: ensureInt(padding)
      },
      'top-right': {
        top: ensureInt(padding),
        left: ensureInt(Math.max(0, imageWidth - watermarkWidth - padding))
      },
      'bottom-left': {
        top: ensureInt(Math.max(0, imageHeight - watermarkHeight - padding)),
        left: ensureInt(padding)
      },
      'bottom-right': {
        top: ensureInt(Math.max(0, imageHeight - watermarkHeight - padding)),
        left: ensureInt(Math.max(0, imageWidth - watermarkWidth - padding))
      },
      center: {
        top: ensureInt(Math.max(0, (imageHeight - watermarkHeight) / 2)),
        left: ensureInt(Math.max(0, (imageWidth - watermarkWidth) / 2))
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

  /**
   * Load and create a logo watermark from SVG file or base64 string
   */
  async _createLogoWatermark(watermarkConfig, imageWidth, imageHeight) {
    try {
      let logoBuffer;

      // Check if logo is base64 encoded (starts with data:image/)
      if (watermarkConfig.logo.startsWith('data:image/')) {
        // Extract base64 data from data URL
        const base64Data = watermarkConfig.logo.split(',')[1];
        logoBuffer = Buffer.from(base64Data, 'base64');
        
        logger.info({
          component: 'ImageWatermarkService',
          message: 'Loading logo from base64 string',
          size: logoBuffer.length
        });
      } else {
        // Load from file system (original behavior)
        const logoPath = path.join(getRootDir(), config.CONTENTS_DIR, 'logos', watermarkConfig.logo);
        logoBuffer = await fs.readFile(logoPath);
        
        logger.info({
          component: 'ImageWatermarkService',
          message: 'Loading logo from file',
          path: logoPath
        });
      }

      // Scale logo to appropriate size (max 20% of image dimensions)
      const maxLogoWidth = Math.floor(imageWidth * 0.2);
      const maxLogoHeight = Math.floor(imageHeight * 0.2);

      const logoMetadata = await sharp(logoBuffer).metadata();
      const logoAspectRatio = logoMetadata.width / logoMetadata.height;

      let targetWidth = maxLogoWidth;
      let targetHeight = Math.floor(targetWidth / logoAspectRatio);

      if (targetHeight > maxLogoHeight) {
        targetHeight = maxLogoHeight;
        targetWidth = Math.floor(targetHeight * logoAspectRatio);
      }

      // Apply opacity to logo
      const opacity = watermarkConfig.opacity || 0.5;
      const processedLogo = await sharp(logoBuffer)
        .resize(targetWidth, targetHeight, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .composite([
          {
            input: Buffer.from(
              `<svg><rect x="0" y="0" width="${targetWidth}" height="${targetHeight}" fill="white" opacity="${1 - opacity}"/></svg>`
            ),
            blend: 'dest-in'
          }
        ])
        .png()
        .toBuffer();

      return {
        buffer: processedLogo,
        width: targetWidth,
        height: targetHeight
      };
    } catch (error) {
      logger.error({
        component: 'ImageWatermarkService',
        message: 'Failed to load logo watermark',
        logo: watermarkConfig.logo,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Create a combined logo and text watermark
   */
  async _createLogoAndTextWatermark(
    watermarkConfig,
    watermarkText,
    fontSize,
    imageWidth,
    imageHeight
  ) {
    try {
      // Load logo
      const logoResult = await this._createLogoWatermark(watermarkConfig, imageWidth, imageHeight);

      // Create text SVG
      const textSvg = this._createSvgWatermark(
        watermarkText,
        fontSize,
        watermarkConfig.opacity || 0.5,
        watermarkConfig.textColor || '#ffffff'
      );
      const textBuffer = Buffer.from(textSvg);
      const textMetadata = await sharp(textBuffer).metadata();

      // Combine logo and text horizontally with some spacing
      const spacing = Math.floor(fontSize * 0.5);
      const combinedWidth = logoResult.width + spacing + textMetadata.width;
      const combinedHeight = Math.max(logoResult.height, textMetadata.height);

      // Create canvas
      const canvas = sharp({
        create: {
          width: combinedWidth,
          height: combinedHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      });

      // Composite logo and text
      const combined = await canvas
        .composite([
          {
            input: logoResult.buffer,
            top: Math.floor((combinedHeight - logoResult.height) / 2),
            left: 0
          },
          {
            input: textBuffer,
            top: Math.floor((combinedHeight - textMetadata.height) / 2),
            left: logoResult.width + spacing
          }
        ])
        .png()
        .toBuffer();

      return {
        buffer: combined,
        width: combinedWidth,
        height: combinedHeight
      };
    } catch (error) {
      logger.error({
        component: 'ImageWatermarkService',
        message: 'Failed to create combined logo and text watermark',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Create C2PA-style provenance manifest
   */
  async _createC2PAManifest(metadata, watermarkConfig, imageMetadata, exifMetadata) {
    const manifest = {
      '@context': 'https://c2pa.org/specifications/1.0/context.jsonld',
      '@type': 'c2pa.manifest',
      version: '1.0',
      created: new Date().toISOString(),
      claim_generator: watermarkConfig.text || 'iHub Apps',
      instance_id: crypto.randomUUID(),

      // Assertion: Image generation details
      assertions: [
        {
          '@type': 'c2pa.actions',
          actions: [
            {
              action: 'c2pa.created',
              when: new Date().toISOString(),
              softwareAgent: {
                name: watermarkConfig.text || 'iHub Apps',
                version: '1.0'
              }
            }
          ]
        }
      ],

      // Image metadata
      image: {
        format: imageMetadata.format,
        width: imageMetadata.width,
        height: imageMetadata.height
      }
    };

    // Add creator information if available
    if (metadata.user) {
      const creator = metadata.user.name || metadata.user.username || metadata.user.id;
      manifest.assertions.push({
        '@type': 'c2pa.creator',
        creator: [
          {
            '@type': 'Person',
            name: creator
          }
        ]
      });
    }

    // Add watermark information
    if (watermarkConfig.text || watermarkConfig.logo) {
      manifest.assertions.push({
        '@type': 'c2pa.watermarking',
        watermark: {
          type: watermarkConfig.logo ? 'logo' : 'text',
          value: watermarkConfig.text || watermarkConfig.logo
        }
      });
    }

    return manifest;
  }

  /**
   * Sign manifest using HMAC-SHA256 with JWT secret
   */
  _signManifest(manifest, jwtSecret) {
    const manifestString = JSON.stringify(manifest, null, 0);
    const signature = crypto
      .createHmac('sha256', jwtSecret)
      .update(manifestString)
      .digest('base64');

    return {
      manifest,
      signature,
      algorithm: 'HS256'
    };
  }
}

export default new ImageWatermarkService();
