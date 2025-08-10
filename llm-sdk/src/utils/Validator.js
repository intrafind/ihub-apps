import { z } from 'zod';
import { ValidationError } from './ErrorHandler.js';

/**
 * Validation schemas for LLM SDK
 */

// Message content schemas
const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string()
});

const imageContentSchema = z.object({
  type: z.literal('image'),
  image: z.union([
    z.object({
      url: z.string().url()
    }),
    z.object({
      base64: z.string(),
      mimeType: z.string().optional()
    })
  ])
});

const toolCallContentSchema = z.object({
  type: z.literal('tool_call'),
  toolCall: z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.any())
  })
});

const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  result: z.any()
});

const contentPartSchema = z.union([
  textContentSchema,
  imageContentSchema,
  toolCallContentSchema,
  toolResultContentSchema
]);

// Message schema
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.any())
  })).optional()
});

// Tool definition schema
const toolParameterSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  items: z.any().optional(),
  properties: z.record(z.any()).optional(),
  required: z.array(z.string()).optional()
});

const toolDefinitionSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().min(1).max(1024),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(toolParameterSchema),
    required: z.array(z.string()).optional()
  }),
  handler: z.function().optional()
});

// Request schema
const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  provider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(100000).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.union([z.string(), toolDefinitionSchema])).optional(),
  toolChoice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() })
    })
  ]).optional(),
  responseFormat: z.object({
    type: z.enum(['text', 'json_object', 'json_schema']),
    schema: z.record(z.any()).optional()
  }).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  seed: z.number().optional()
});

// Provider configuration schema
const providerConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseURL: z.string().url().optional(),
  timeout: z.number().min(1000).max(300000).optional(),
  retries: z.number().min(0).max(10).optional(),
  rateLimit: z.object({
    requests: z.number().min(1),
    period: z.number().min(1000)
  }).optional(),
  defaultModel: z.string().optional(),
  maxTokens: z.number().min(1).max(100000).optional(),
  temperature: z.number().min(0).max(2).optional()
});

// Model configuration schema
const modelConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  capabilities: z.object({
    tools: z.boolean().optional(),
    images: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    streaming: z.boolean().optional()
  }).optional(),
  limits: z.object({
    maxTokens: z.number().min(1).optional(),
    contextLength: z.number().min(1).optional()
  }).optional(),
  pricing: z.object({
    input: z.number().min(0).optional(),
    output: z.number().min(0).optional()
  }).optional()
});

/**
 * Validator class for input validation
 */
export class Validator {
  /**
   * Validate chat request
   * @param {Object} request - Chat request to validate
   * @param {string} provider - Provider name for error context
   * @returns {Object} Validated request
   * @throws {ValidationError} If validation fails
   */
  static validateChatRequest(request, provider) {
    try {
      return chatRequestSchema.parse(request);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        throw new ValidationError(
          `Invalid request: ${firstError.message} at ${firstError.path.join('.')}`,
          firstError.path.join('.'),
          firstError.received,
          provider,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate message array
   * @param {Array} messages - Messages to validate
   * @param {string} provider - Provider name for error context
   * @returns {Array} Validated messages
   * @throws {ValidationError} If validation fails
   */
  static validateMessages(messages, provider) {
    try {
      return z.array(messageSchema).parse(messages);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        throw new ValidationError(
          `Invalid messages: ${firstError.message} at ${firstError.path.join('.')}`,
          `messages.${firstError.path.join('.')}`,
          firstError.received,
          provider,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate tool definition
   * @param {Object} tool - Tool definition to validate
   * @param {string} provider - Provider name for error context
   * @returns {Object} Validated tool definition
   * @throws {ValidationError} If validation fails
   */
  static validateToolDefinition(tool, provider) {
    try {
      return toolDefinitionSchema.parse(tool);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        throw new ValidationError(
          `Invalid tool definition: ${firstError.message} at ${firstError.path.join('.')}`,
          `tool.${firstError.path.join('.')}`,
          firstError.received,
          provider,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate provider configuration
   * @param {Object} config - Provider configuration to validate
   * @param {string} provider - Provider name for error context
   * @returns {Object} Validated configuration
   * @throws {ValidationError} If validation fails
   */
  static validateProviderConfig(config, provider) {
    try {
      return providerConfigSchema.parse(config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        throw new ValidationError(
          `Invalid provider configuration: ${firstError.message} at ${firstError.path.join('.')}`,
          `config.${firstError.path.join('.')}`,
          firstError.received,
          provider,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate model configuration
   * @param {Object} config - Model configuration to validate
   * @param {string} provider - Provider name for error context
   * @returns {Object} Validated configuration
   * @throws {ValidationError} If validation fails
   */
  static validateModelConfig(config, provider) {
    try {
      return modelConfigSchema.parse(config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        throw new ValidationError(
          `Invalid model configuration: ${firstError.message} at ${firstError.path.join('.')}`,
          `model.${firstError.path.join('.')}`,
          firstError.received,
          provider,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate API key format for different providers
   * @param {string} apiKey - API key to validate
   * @param {string} provider - Provider name
   * @returns {boolean} Whether API key format is valid
   */
  static validateApiKeyFormat(apiKey, provider) {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }

    switch (provider.toLowerCase()) {
      case 'openai':
        return apiKey.startsWith('sk-') && apiKey.length > 20;
      case 'anthropic':
        return apiKey.startsWith('sk-ant-') && apiKey.length > 20;
      case 'google':
        return apiKey.length > 20; // Google keys are variable length
      case 'mistral':
        return apiKey.length > 20;
      case 'vllm':
      case 'local':
        return true; // Local VLLM doesn't require specific format
      default:
        return apiKey.length > 10; // Generic minimum length
    }
  }

  /**
   * Sanitize and validate model name
   * @param {string} model - Model name to validate
   * @param {string} provider - Provider name
   * @returns {string} Sanitized model name
   * @throws {ValidationError} If model name is invalid
   */
  static validateModelName(model, provider) {
    if (!model || typeof model !== 'string') {
      throw new ValidationError(
        'Model name must be a non-empty string',
        'model',
        model,
        provider
      );
    }

    // Sanitize model name (remove potentially dangerous characters)
    const sanitized = model.trim().replace(/[^\w.-]/g, '');
    
    if (sanitized.length === 0) {
      throw new ValidationError(
        'Model name contains no valid characters',
        'model',
        model,
        provider
      );
    }

    if (sanitized.length > 100) {
      throw new ValidationError(
        'Model name is too long (max 100 characters)',
        'model',
        model,
        provider
      );
    }

    return sanitized;
  }

  /**
   * Validate temperature parameter
   * @param {number} temperature - Temperature value
   * @param {string} provider - Provider name
   * @returns {number} Validated temperature
   * @throws {ValidationError} If temperature is invalid
   */
  static validateTemperature(temperature, provider) {
    if (temperature === undefined || temperature === null) {
      return 0.7; // Default
    }

    if (typeof temperature !== 'number' || isNaN(temperature)) {
      throw new ValidationError(
        'Temperature must be a number',
        'temperature',
        temperature,
        provider
      );
    }

    if (temperature < 0 || temperature > 2) {
      throw new ValidationError(
        'Temperature must be between 0 and 2',
        'temperature',
        temperature,
        provider
      );
    }

    return temperature;
  }
}

// Export schemas for external use
export {
  messageSchema,
  chatRequestSchema,
  toolDefinitionSchema,
  providerConfigSchema,
  modelConfigSchema
};