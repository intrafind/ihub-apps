/**
 * Integration test for Google Gemini tool schema validation
 * Reproduces the original bug where un-localized tool descriptions caused Google API errors
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguredTools } from '../toolLoader.js';
import { convertToolsFromGeneric } from '../adapters/toolCalling/index.js';

describe('Google Gemini Tool Schema Validation', () => {
  it('should not have object descriptions in Google-formatted tools when language is null', async () => {
    // This reproduces the original bug scenario:
    // 1. User doesn't provide language (language is null)
    // 2. Tools are loaded
    // 3. Tools are converted to Google format
    // 4. Google API should receive valid schemas (descriptions as strings, not objects)

    const tools = await loadConfiguredTools(null);

    // Convert to Google format (same as what the Google adapter does)
    const googleTools = convertToolsFromGeneric(tools, 'google');

    // Validate that all tools have proper schemas
    for (const toolGroup of googleTools) {
      if (toolGroup.functionDeclarations) {
        for (const func of toolGroup.functionDeclarations) {
          // Check function description
          assert.strictEqual(
            typeof func.description,
            'string',
            `Function ${func.name} description should be a string, not an object`
          );

          // Check parameter descriptions
          if (func.parameters?.properties) {
            validateProperties(func.parameters.properties, func.name);
          }
        }
      }
    }
  });

  it('should not have object descriptions in Google-formatted tools when language is undefined', async () => {
    const tools = await loadConfiguredTools(undefined);
    const googleTools = convertToolsFromGeneric(tools, 'google');

    for (const toolGroup of googleTools) {
      if (toolGroup.functionDeclarations) {
        for (const func of toolGroup.functionDeclarations) {
          assert.strictEqual(
            typeof func.description,
            'string',
            `Function ${func.name} description should be a string when language is undefined`
          );

          if (func.parameters?.properties) {
            validateProperties(func.parameters.properties, func.name);
          }
        }
      }
    }
  });

  it('should not have object descriptions in Google-formatted tools when language is empty string', async () => {
    const tools = await loadConfiguredTools('');
    const googleTools = convertToolsFromGeneric(tools, 'google');

    for (const toolGroup of googleTools) {
      if (toolGroup.functionDeclarations) {
        for (const func of toolGroup.functionDeclarations) {
          assert.strictEqual(
            typeof func.description,
            'string',
            `Function ${func.name} description should be a string when language is empty`
          );

          if (func.parameters?.properties) {
            validateProperties(func.parameters.properties, func.name);
          }
        }
      }
    }
  });

  it('should handle ask_user tool with deeply nested schemas', async () => {
    // The ask_user tool has very deeply nested schemas with descriptions at multiple levels
    // This is the most complex test case
    const tools = await loadConfiguredTools(null);

    const askUserTool = tools.find(t => t.id === 'ask_user');
    if (!askUserTool) {
      // Skip if ask_user tool is not in config
      return;
    }

    const googleTools = convertToolsFromGeneric([askUserTool], 'google');

    for (const toolGroup of googleTools) {
      if (toolGroup.functionDeclarations) {
        for (const func of toolGroup.functionDeclarations) {
          // Validate all levels of nested properties
          if (func.parameters?.properties) {
            validatePropertiesDeep(func.parameters.properties, `${func.name}.parameters`, 0);
          }
        }
      }
    }
  });
});

/**
 * Validate that all properties have string descriptions (not objects)
 * @param {Object} properties - Properties object from JSON schema
 * @param {string} context - Context for error messages
 */
function validateProperties(properties, context) {
  for (const [propName, propSchema] of Object.entries(properties)) {
    if (propSchema.description !== undefined) {
      assert.strictEqual(
        typeof propSchema.description,
        'string',
        `${context}.${propName} description should be a string, not an object. Got: ${JSON.stringify(propSchema.description)}`
      );
    }

    // Check nested properties
    if (propSchema.properties) {
      validateProperties(propSchema.properties, `${context}.${propName}`);
    }

    // Check array item properties
    if (propSchema.items?.properties) {
      validateProperties(propSchema.items.properties, `${context}.${propName}[items]`);
    }
  }
}

/**
 * Deep validation with recursion depth tracking to prevent infinite loops
 * @param {Object} properties - Properties object
 * @param {string} path - Current path for error messages
 * @param {number} depth - Current recursion depth
 * @param {number} maxDepth - Maximum recursion depth (default 10)
 */
function validatePropertiesDeep(properties, path, depth, maxDepth = 10) {
  if (depth > maxDepth) {
    console.warn(`Skipping validation at depth ${depth} for path ${path}`);
    return;
  }

  for (const [propName, propSchema] of Object.entries(properties)) {
    const currentPath = `${path}.${propName}`;

    // Validate description if present
    if (propSchema.description !== undefined) {
      assert.strictEqual(
        typeof propSchema.description,
        'string',
        `${currentPath}.description should be a string, not an object. Got: ${JSON.stringify(propSchema.description)}`
      );
    }

    // Recursively validate nested structures
    if (propSchema.properties) {
      validatePropertiesDeep(propSchema.properties, currentPath, depth + 1, maxDepth);
    }

    if (propSchema.items) {
      if (propSchema.items.properties) {
        validatePropertiesDeep(
          propSchema.items.properties,
          `${currentPath}[items]`,
          depth + 1,
          maxDepth
        );
      }
      // Handle array of schemas
      if (Array.isArray(propSchema.items)) {
        propSchema.items.forEach((item, index) => {
          if (item.properties) {
            validatePropertiesDeep(
              item.properties,
              `${currentPath}[items][${index}]`,
              depth + 1,
              maxDepth
            );
          }
        });
      }
    }

    // Validate anyOf/oneOf/allOf if present
    ['anyOf', 'oneOf', 'allOf'].forEach(keyword => {
      if (propSchema[keyword] && Array.isArray(propSchema[keyword])) {
        propSchema[keyword].forEach((schema, index) => {
          if (schema.properties) {
            validatePropertiesDeep(
              schema.properties,
              `${currentPath}.${keyword}[${index}]`,
              depth + 1,
              maxDepth
            );
          }
        });
      }
    });
  }
}
