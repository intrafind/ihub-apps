/**
 * Theme CSS Route
 *
 * Generates dynamic CSS with theme variables based on ui.json configuration.
 * Endpoint: GET /api/theme.css
 *
 * Features:
 * - Generates CSS custom properties from theme configuration
 * - Supports light and dark mode variables
 * - Cache-Control: no-cache for real-time updates
 * - ETag based on theme configuration hash
 */

import crypto from 'crypto';
import configCache from '../configCache.js';
import { buildServerPath } from '../utils/basePath.js';

/**
 * Generate CSS from theme configuration
 * @param {Object} theme - Theme configuration object
 * @returns {string} Generated CSS
 */
function generateThemeCSS(theme) {
  if (!theme || typeof theme !== 'object') {
    return getDefaultThemeCSS();
  }

  const css = [];

  // Root variables (light mode)
  css.push(':root {');
  css.push(`  --ih-primary: ${theme.primaryColor || '#4f46e5'};`);
  css.push(
    `  --ih-primary-dark: ${theme.primaryDark || darkenColor(theme.primaryColor || '#4f46e5')};`
  );
  css.push(`  --ih-accent: ${theme.accentColor || '#10b981'};`);
  css.push(`  --ih-bg: ${theme.backgroundColor || '#f5f7f8'};`);
  css.push(`  --ih-surface: ${theme.surfaceColor || '#ffffff'};`);
  css.push(`  --ih-text: ${theme.textColor || '#1a1a2e'};`);
  css.push(`  --ih-text-muted: ${theme.textMutedColor || '#6b7280'};`);

  // Add any additional CSS variables from the theme
  if (theme.cssVariables && typeof theme.cssVariables === 'object') {
    for (const [name, value] of Object.entries(theme.cssVariables)) {
      if (typeof value === 'string') {
        const sanitizedName = sanitizeCSSName(name);
        if (sanitizedName) {
          css.push(`  --${sanitizedName}: ${sanitizeCSSValue(value)};`);
        }
      }
    }
  }

  css.push('}');
  css.push('');

  // Dark mode variables
  css.push('[data-theme="dark"] {');
  const darkMode = theme.darkMode || {};
  css.push(`  --ih-primary: ${darkMode.primaryColor || theme.primaryColor || '#4f46e5'};`);
  css.push(
    `  --ih-primary-dark: ${darkMode.primaryDark || darkenColor(darkMode.primaryColor || theme.primaryColor || '#4f46e5')};`
  );
  css.push(`  --ih-accent: ${darkMode.accentColor || theme.accentColor || '#10b981'};`);
  css.push(`  --ih-bg: ${darkMode.backgroundColor || '#1a1a2e'};`);
  css.push(`  --ih-surface: ${darkMode.surfaceColor || '#16213e'};`);
  css.push(`  --ih-text: ${darkMode.textColor || '#f5f5f5'};`);
  css.push(`  --ih-text-muted: ${darkMode.textMutedColor || '#a0a0a0'};`);

  // Add dark mode specific CSS variables
  if (darkMode.cssVariables && typeof darkMode.cssVariables === 'object') {
    for (const [name, value] of Object.entries(darkMode.cssVariables)) {
      if (typeof value === 'string') {
        const sanitizedName = sanitizeCSSName(name);
        if (sanitizedName) {
          css.push(`  --${sanitizedName}: ${sanitizeCSSValue(value)};`);
        }
      }
    }
  }

  css.push('}');

  return css.join('\n');
}

/**
 * Get default theme CSS when no theme is configured
 * @returns {string} Default CSS
 */
function getDefaultThemeCSS() {
  return `:root {
  --ih-primary: #4f46e5;
  --ih-primary-dark: #4338ca;
  --ih-accent: #10b981;
  --ih-bg: #f5f7f8;
  --ih-surface: #ffffff;
  --ih-text: #1a1a2e;
  --ih-text-muted: #6b7280;
}

[data-theme="dark"] {
  --ih-primary: #4f46e5;
  --ih-primary-dark: #4338ca;
  --ih-accent: #10b981;
  --ih-bg: #1a1a2e;
  --ih-surface: #16213e;
  --ih-text: #f5f5f5;
  --ih-text-muted: #a0a0a0;
}`;
}

/**
 * Darken a hex color by a percentage
 * @param {string} hex - Hex color (e.g., #4f46e5 or #fff)
 * @param {number} percent - Percentage to darken (default: 10)
 * @returns {string} Darkened hex color
 */
function darkenColor(hex, percent = 10) {
  if (!hex || typeof hex !== 'string') return '#4338ca';

  // Remove # if present
  hex = hex.replace(/^#/, '');

  // Expand 3-character shorthand to 6-character format
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  // Validate hex length
  if (hex.length !== 6) {
    return '#4338ca'; // Return default if invalid
  }

  // Parse RGB values
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);

  // Handle NaN from invalid hex
  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return '#4338ca';
  }

  // Darken each component
  r = Math.max(0, Math.floor(r * (1 - percent / 100)));
  g = Math.max(0, Math.floor(g * (1 - percent / 100)));
  b = Math.max(0, Math.floor(b * (1 - percent / 100)));

  // Convert back to hex
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Sanitize CSS variable name to prevent injection
 * @param {string} name - Variable name
 * @returns {string|null} Sanitized name or null if invalid
 */
function sanitizeCSSName(name) {
  // Only allow alphanumeric, hyphens, and underscores
  const sanitized = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  // Return null if sanitized name is empty
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Sanitize CSS value to prevent injection
 * @param {string} value - CSS value
 * @returns {string} Sanitized value
 */
function sanitizeCSSValue(value) {
  // Remove potentially dangerous characters and patterns
  return String(value)
    .replace(/[;{}]/g, '') // Remove CSS structural characters
    .replace(/\\/g, '') // Remove backslashes
    .replace(/<|>/g, '') // Remove angle brackets
    .trim();
}

/**
 * Generate ETag from theme configuration
 * @param {Object} theme - Theme configuration
 * @returns {string} ETag value
 */
function generateETag(theme) {
  const content = JSON.stringify(theme || {});
  const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 16);
  return `"theme-${hash}"`;
}

/**
 * Register theme routes
 * @param {Express} app - Express application instance
 */
export default function registerThemeRoutes(app) {
  /**
   * GET /api/theme.css
   * Returns dynamically generated CSS based on theme configuration
   */
  app.get(buildServerPath('/api/theme.css'), (req, res) => {
    try {
      // Get UI configuration
      const uiConfig = configCache.getUI();
      const theme = uiConfig?.data?.theme || {};

      // Generate CSS content
      const cssContent = generateThemeCSS(theme);

      // Add custom CSS if provided
      let fullCSS = cssContent;
      const customCSS = uiConfig?.data?.customStyles?.css;
      if (customCSS && typeof customCSS === 'string') {
        fullCSS += '\n\n/* Custom CSS */\n' + customCSS;
      }

      // Generate ETag for caching
      const etag = generateETag({ theme, customCSS: customCSS || '' });

      // Check If-None-Match header
      const ifNoneMatch = req.get('If-None-Match');
      if (ifNoneMatch === etag) {
        return res.status(304).end();
      }

      // Set response headers
      res.set({
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff'
      });

      res.send(fullCSS);
    } catch (error) {
      console.error('Error generating theme CSS:', error);

      // Return default CSS on error
      res.set({
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.send(getDefaultThemeCSS());
    }
  });
}
