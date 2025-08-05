import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import { promptConfigSchema } from '../validators/promptConfigSchema.js';
import { groupConfigSchema } from '../validators/groupConfigSchema.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { userConfigSchema } from '../validators/userConfigSchema.js';

/**
 * Convert Zod schemas to JSON Schema format for client use
 * This utility maintains a single source of truth for validation rules
 * while providing JSON Schema compatibility for Monaco editor and other tools
 */

/**
 * Configuration options for JSON Schema generation
 */
const jsonSchemaOptions = {
  // Use JSON Schema Draft-07 for compatibility
  target: 'jsonSchema7',
  // Generate descriptive titles and descriptions
  title: true,
  // Include examples where available
  markdownDescription: true,
  // Remove Zod-specific annotations
  removeAdditionalStrategy: 'strict',
  // Generate proper error messages
  errorMessages: true,
  // Include pattern properties for localized strings
  patternStrategy: 'union'
};

/**
 * Schema metadata for enhanced JSON Schema output
 */
const schemaMetadata = {
  app: {
    title: 'iHub App Configuration',
    description: 'Configuration schema for iHub applications',
    examples: [
      {
        id: 'example-app',
        name: { en: 'Example App', de: 'Beispiel-App' },
        description: { en: 'An example application', de: 'Eine Beispielanwendung' },
        color: '#4F46E5',
        icon: 'chat-bubbles',
        system: { en: 'You are a helpful assistant.', de: 'Du bist ein hilfreicher Assistent.' },
        tokenLimit: 4096
      }
    ]
  },
  model: {
    title: 'iHub Model Configuration',
    description: 'Configuration schema for iHub model definitions',
    examples: [
      {
        id: 'gpt-4-turbo',
        modelId: 'gpt-4-turbo-preview',
        name: { en: 'GPT-4 Turbo', de: 'GPT-4 Turbo' },
        description: { en: 'Most capable GPT-4 model', de: 'Leistungsfähigstes GPT-4-Modell' },
        url: 'https://api.openai.com/v1',
        provider: 'openai',
        tokenLimit: 128000,
        supportsTools: true,
        enabled: true
      }
    ]
  },
  prompt: {
    title: 'iHub Prompt Configuration',
    description: 'Configuration schema for iHub prompt templates',
    examples: [
      {
        id: 'email-composer',
        name: { en: 'Email Composer', de: 'E-Mail-Verfasser' },
        description: { en: 'Draft professional emails', de: 'Erstelle professionelle E-Mails' },
        prompt: {
          en: 'Write a {{type}} email about {{subject}}.',
          de: 'Schreibe eine {{type}} E-Mail über {{subject}}.'
        },
        icon: 'mail',
        enabled: true
      }
    ]
  },
  group: {
    title: 'iHub Group Configuration',
    description: 'Configuration schema for iHub user groups',
    examples: [
      {
        id: 'editors',
        name: 'Content Editors',
        description: 'Users who can create and edit content',
        permissions: {
          apps: ['content-creator', 'translator'],
          prompts: ['writing', 'editing'],
          models: ['gpt-4', 'claude-3-sonnet'],
          adminAccess: false
        },
        mappings: ['Content-Team', 'Editors-Group']
      }
    ]
  },
  platform: {
    title: 'iHub Platform Configuration',
    description: 'Configuration schema for iHub platform settings',
    examples: [
      {
        auth: {
          mode: 'oidc',
          authenticatedGroup: 'authenticated'
        },
        anonymousAuth: {
          enabled: true,
          defaultGroups: ['anonymous']
        },
        oidcAuth: {
          enabled: true,
          allowSelfSignup: true,
          providers: [
            {
              name: 'google',
              displayName: 'Google',
              clientId: '${GOOGLE_CLIENT_ID}',
              clientSecret: '${GOOGLE_CLIENT_SECRET}',
              authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
              tokenURL: 'https://www.googleapis.com/oauth2/v4/token',
              userInfoURL: 'https://www.googleapis.com/oauth2/v2/userinfo',
              scope: ['openid', 'profile', 'email'],
              groupsAttribute: 'groups',
              defaultGroups: ['google-users'],
              pkce: true,
              enabled: true
            }
          ]
        }
      }
    ]
  },
  user: {
    title: 'iHub User Configuration',
    description: 'Configuration schema for iHub users',
    examples: [
      {
        id: 'user123',
        username: 'john.doe',
        email: 'john.doe@example.com',
        fullName: 'John Doe',
        groups: ['users', 'content-editors'],
        enabled: true,
        preferences: {
          language: 'en',
          theme: 'light',
          timezone: 'UTC'
        }
      }
    ]
  }
};

/**
 * Enhanced JSON Schema generation with additional metadata
 * @param {string} schemaType - Type of schema ('app', 'model', 'prompt')
 * @param {z.ZodSchema} zodSchema - Zod schema to convert
 * @returns {object} Enhanced JSON Schema object
 */
function generateEnhancedJsonSchema(schemaType, zodSchema) {
  const baseJsonSchema = zodToJsonSchema(zodSchema, {
    ...jsonSchemaOptions,
    name: schemaType
  });

  const metadata = schemaMetadata[schemaType] || {};

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...baseJsonSchema,
    title: metadata.title || baseJsonSchema.title,
    description: metadata.description || baseJsonSchema.description,
    examples: metadata.examples || baseJsonSchema.examples
  };
}

/**
 * Get JSON Schema for app configuration
 * @returns {object} JSON Schema object for app configuration
 */
export function getAppJsonSchema() {
  return generateEnhancedJsonSchema('app', appConfigSchema);
}

/**
 * Get JSON Schema for model configuration
 * @returns {object} JSON Schema object for model configuration
 */
export function getModelJsonSchema() {
  return generateEnhancedJsonSchema('model', modelConfigSchema);
}

/**
 * Get JSON Schema for prompt configuration
 * @returns {object} JSON Schema object for prompt configuration
 */
export function getPromptJsonSchema() {
  return generateEnhancedJsonSchema('prompt', promptConfigSchema);
}

/**
 * Get JSON Schema for group configuration
 * @returns {object} JSON Schema object for group configuration
 */
export function getGroupJsonSchema() {
  return generateEnhancedJsonSchema('group', groupConfigSchema);
}

/**
 * Get JSON Schema for platform configuration
 * @returns {object} JSON Schema object for platform configuration
 */
export function getPlatformJsonSchema() {
  return generateEnhancedJsonSchema('platform', platformConfigSchema);
}

/**
 * Get JSON Schema for user configuration
 * @returns {object} JSON Schema object for user configuration
 */
export function getUserJsonSchema() {
  return generateEnhancedJsonSchema('user', userConfigSchema);
}

/**
 * Get all available JSON schemas
 * @returns {object} Object containing all available schemas
 */
export function getAllJsonSchemas() {
  return {
    app: getAppJsonSchema(),
    model: getModelJsonSchema(),
    prompt: getPromptJsonSchema(),
    group: getGroupJsonSchema(),
    platform: getPlatformJsonSchema(),
    user: getUserJsonSchema()
  };
}

/**
 * Get JSON Schema by type
 * @param {string} type - Schema type ('app', 'model', 'prompt', 'group', 'platform', 'user')
 * @returns {object|null} JSON Schema object or null if type not found
 */
export function getJsonSchemaByType(type) {
  switch (type) {
    case 'app':
      return getAppJsonSchema();
    case 'model':
      return getModelJsonSchema();
    case 'prompt':
      return getPromptJsonSchema();
    case 'group':
      return getGroupJsonSchema();
    case 'platform':
      return getPlatformJsonSchema();
    case 'user':
      return getUserJsonSchema();
    default:
      return null;
  }
}

/**
 * Validate that zod-to-json-schema is available
 * This function will throw an error if the required dependency is missing
 */
export function validateDependencies() {
  try {
    // Test that zodToJsonSchema function works
    const testSchema = z.object({ test: z.string() });
    zodToJsonSchema(testSchema);
    return true;
  } catch (error) {
    throw new Error(
      'Missing required dependency: zod-to-json-schema. ' +
        'Please install it with: npm install zod-to-json-schema'
    );
  }
}
