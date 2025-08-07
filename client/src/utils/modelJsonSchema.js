/**
 * JSON Schema for Model Configuration
 * Derived from server/validators/modelConfigSchema.js
 */

export const modelJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Model Configuration',
  description: 'Schema for iHub Apps model configuration',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Unique identifier for the model',
      pattern: '^[a-z0-9-]+$',
      examples: ['gpt-4', 'claude-sonnet', 'gemini-pro']
    },
    modelId: {
      type: 'string',
      description: 'API model identifier used by the provider',
      examples: ['gpt-4-turbo', 'claude-3-sonnet', 'gemini-1.5-pro']
    },
    name: {
      type: 'object',
      description: 'Localized display names for the model',
      patternProperties: {
        '^[a-z]{2}$': {
          type: 'string',
          minLength: 1
        }
      },
      additionalProperties: false,
      examples: [
        { en: 'GPT-4 Turbo', de: 'GPT-4 Turbo' },
        { en: 'Claude Sonnet', de: 'Claude Sonnet' }
      ]
    },
    description: {
      type: 'object',
      description: 'Localized descriptions for the model',
      patternProperties: {
        '^[a-z]{2}$': {
          type: 'string',
          minLength: 1
        }
      },
      additionalProperties: false,
      examples: [
        {
          en: 'Advanced language model with superior reasoning capabilities',
          de: 'Fortgeschrittenes Sprachmodell mit überlegenen Denkfähigkeiten'
        }
      ]
    },
    url: {
      type: 'string',
      description: 'API endpoint URL for the model',
      format: 'uri',
      examples: [
        'https://api.openai.com/v1',
        'https://api.anthropic.com',
        'https://generativelanguage.googleapis.com/v1'
      ]
    },
    provider: {
      type: 'string',
      description: 'Provider identifier',
      enum: ['openai', 'anthropic', 'google', 'mistral', 'local'],
      examples: ['openai', 'anthropic', 'google']
    },
    tokenLimit: {
      type: 'integer',
      description: 'Maximum number of tokens per request',
      minimum: 1,
      maximum: 1000000,
      examples: [4000, 8000, 128000]
    },
    default: {
      type: 'boolean',
      description: 'Whether this is the default model for new users',
      default: false
    },
    supportsTools: {
      type: 'boolean',
      description: 'Whether the model supports function calling/tools',
      default: false
    },
    concurrency: {
      type: 'integer',
      description: 'Maximum concurrent requests allowed for this model',
      minimum: 1,
      maximum: 100,
      examples: [1, 5, 10]
    },
    requestDelayMs: {
      type: 'integer',
      description: 'Delay between requests in milliseconds',
      minimum: 0,
      maximum: 10000,
      examples: [0, 100, 1000]
    },
    enabled: {
      type: 'boolean',
      description: 'Whether the model is enabled and available for use',
      default: true
    },
    thinking: {
      type: 'object',
      description: 'Configuration for thinking/reasoning features',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Whether thinking mode is enabled',
          default: false
        },
        budget: {
          type: 'integer',
          description: 'Thinking budget: 0=disabled, -1=dynamic, positive=specific budget',
          examples: [0, -1, 1000, 5000]
        },
        thoughts: {
          type: 'boolean',
          description: 'Whether to include thoughts in the response',
          default: false
        }
      },
      required: ['enabled', 'budget', 'thoughts'],
      additionalProperties: false
    }
  },
  required: ['id', 'modelId', 'name', 'description', 'url', 'provider', 'tokenLimit'],
  additionalProperties: true,
  examples: [
    {
      id: 'gpt-4-turbo',
      modelId: 'gpt-4-turbo-preview',
      name: {
        en: 'GPT-4 Turbo',
        de: 'GPT-4 Turbo'
      },
      description: {
        en: 'Most capable GPT-4 model with improved performance',
        de: 'Leistungsfähigstes GPT-4-Modell mit verbesserter Performance'
      },
      url: 'https://api.openai.com/v1',
      provider: 'openai',
      tokenLimit: 128000,
      supportsTools: true,
      enabled: true,
      default: false
    }
  ]
};

/**
 * Get human-readable validation errors for model configuration
 * @param {object} errors - Validation errors from ajv
 * @returns {string[]} Array of formatted error messages
 */
export function getModelValidationErrors(errors) {
  if (!errors || !Array.isArray(errors)) return [];

  return errors.map(error => {
    const { instancePath, keyword, message, params } = error;
    const field = instancePath.replace('/', '') || 'root';

    switch (keyword) {
      case 'required':
        return `Missing required field: ${params?.missingProperty || field}`;
      case 'type':
        return `Field "${field}" must be of type ${params?.type}`;
      case 'pattern':
        return `Field "${field}" must match the required format`;
      case 'enum':
        return `Field "${field}" must be one of: ${params?.allowedValues?.join(', ')}`;
      case 'minimum':
        return `Field "${field}" must be at least ${params?.limit}`;
      case 'maximum':
        return `Field "${field}" must be at most ${params?.limit}`;
      case 'format':
        return `Field "${field}" must be a valid ${params?.format}`;
      default:
        return `Field "${field}": ${message}`;
    }
  });
}
