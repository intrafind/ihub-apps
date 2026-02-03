import { z } from 'zod';

/**
 * Content Security Policy (CSP) configuration schema
 */
const cspSchema = z
  .object({
    'default-src': z.array(z.string()).optional(),
    'script-src': z.array(z.string()).optional(),
    'style-src': z.array(z.string()).optional(),
    'img-src': z.array(z.string()).optional(),
    'font-src': z.array(z.string()).optional(),
    'connect-src': z.array(z.string()).optional(),
    'media-src': z.array(z.string()).optional(),
    'object-src': z.array(z.string()).optional(),
    'frame-src': z.array(z.string()).optional(),
    'worker-src': z.array(z.string()).optional(),
    'frame-ancestors': z.array(z.string()).optional(),
    'form-action': z.array(z.string()).optional(),
    'base-uri': z.array(z.string()).optional()
  })
  .optional();

/**
 * MCP App UI metadata schema
 */
const uiMetadataSchema = z.object({
  // Resource URI using ui:// scheme
  resourceUri: z
    .string()
    .regex(/^ui:\/\/[\w-]+\/[\w.-]+$/, 'Resource URI must use ui:// scheme and format: ui://tool-id/resource-path'),

  // Optional permissions for advanced features
  permissions: z.array(z.enum(['microphone', 'camera', 'geolocation', 'notifications'])).optional(),

  // Optional Content Security Policy configuration
  csp: cspSchema,

  // Optional display hints
  displayHints: z
    .object({
      width: z.enum(['compact', 'normal', 'wide', 'full']).optional(),
      height: z.enum(['compact', 'normal', 'tall', 'auto']).optional(),
      resizable: z.boolean().optional()
    })
    .optional()
});

/**
 * Tool metadata schema (extends existing tool schema)
 */
export const toolMetaSchema = z.object({
  ui: uiMetadataSchema.optional()
});

/**
 * Complete tool schema with MCP App support
 */
export const mcpAppToolSchema = z.object({
  id: z.string(),
  name: z.record(z.string()).or(z.string()),
  description: z.record(z.string()).or(z.string()),
  script: z.string().optional(),
  isSpecialTool: z.boolean().optional(),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()).optional(),
    required: z.array(z.string()).optional()
  }),
  _meta: toolMetaSchema.optional()
});

/**
 * Validate tool configuration with MCP App support
 * @param {object} tool - Tool configuration to validate
 * @returns {object} - Validated tool configuration
 * @throws {Error} - If validation fails
 */
export function validateMCPAppTool(tool) {
  return mcpAppToolSchema.parse(tool);
}

/**
 * Validate UI metadata
 * @param {object} uiMeta - UI metadata to validate
 * @returns {object} - Validated UI metadata
 * @throws {Error} - If validation fails
 */
export function validateUIMetadata(uiMeta) {
  return uiMetadataSchema.parse(uiMeta);
}

/**
 * Generate CSP header string from CSP configuration
 * @param {object} csp - CSP configuration object
 * @returns {string} - CSP header value
 */
export function generateCSPHeader(csp) {
  if (!csp) {
    // Default secure CSP
    return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';";
  }

  const directives = [];
  for (const [directive, sources] of Object.entries(csp)) {
    if (Array.isArray(sources) && sources.length > 0) {
      directives.push(`${directive} ${sources.join(' ')}`);
    }
  }

  return directives.join('; ') + ';';
}

/**
 * Extract resource path from ui:// URI
 * @param {string} resourceUri - Full resource URI (e.g., ui://tool-id/app.html)
 * @returns {object} - Parsed resource information
 */
export function parseResourceUri(resourceUri) {
  const match = resourceUri.match(/^ui:\/\/([\w-]+)\/([\w.-]+)$/);
  if (!match) {
    throw new Error(`Invalid resource URI format: ${resourceUri}`);
  }

  return {
    toolId: match[1],
    resourcePath: match[2],
    fullPath: resourceUri
  };
}
