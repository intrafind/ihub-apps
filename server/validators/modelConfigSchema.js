import { z } from 'zod';

// Localized string schema - matches client pattern for language codes
const localizedStringSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

// Thinking configuration schema.
//
// Two incompatible Gemini API shapes — schema accepts either:
//   - Gemini 3.x: { enabled, level: "low"|"medium"|"high" }
//   - Gemini 2.5: { enabled, budget: -1|0|N, thoughts: bool }
// Mixing fields is allowed but the adapter uses `level` when present
// (Gemini 3 schema takes precedence). Operators migrating model aliases
// to Gemini 3 should switch to `level` — the legacy fields will yield
// a bare 400 INVALID_ARGUMENT on Gemini 3 endpoints.
const thinkingSchema = z
  .object({
    enabled: z.boolean(),
    // Gemini 3.x (preferred for newer / aliased "latest" models).
    // Google's API enum is uppercase (MINIMAL | LOW | MEDIUM | HIGH); the
    // adapter normalizes to uppercase before sending. Schema accepts both
    // cases so legacy / hand-edited configs don't fail validation.
    level: z
      .enum(['minimal', 'low', 'medium', 'high', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'])
      .optional(),
    // Gemini 2.5 (legacy)
    budget: z.number().int().optional(),
    thoughts: z.boolean().optional()
  })
  .strict();

// Image generation configuration schema
const imageGenerationSchema = z
  .object({
    aspectRatio: z
      .enum(['1:1', '16:9', '9:16', '5:4', '4:5', '3:2', '2:3', '3:4', '4:3', '21:9'])
      .optional()
      .default('1:1'),
    quality: z.enum(['Low', 'Medium', 'High']).optional().default('Medium'),
    maxReferenceImages: z.number().int().min(1).max(14).optional().default(14)
  })
  .strict();

// Hint configuration schema for displaying important messages when model is selected
const hintSchema = z
  .object({
    message: localizedStringSchema, // Internationalized hint message
    level: z.enum(['hint', 'info', 'warning', 'alert']), // Severity levels
    dismissible: z.boolean().optional().default(true) // Whether user can dismiss (only for hint/info)
  })
  .strict();

export const modelConfigSchema = z
  .object({
    // Required fields
    id: z
      .string()
      .regex(
        /^[a-z0-9._-]+$/,
        'ID must contain only lowercase letters, numbers, underscores, dots, and hyphens'
      )
      .min(1, 'ID cannot be empty'),
    modelId: z.string().min(1, 'Model ID cannot be empty'),
    name: localizedStringSchema,
    description: localizedStringSchema,
    url: z
      .string()
      .min(1, 'URL cannot be empty')
      .refine(
        val => val.includes('${') || val.startsWith('http://') || val.startsWith('https://'),
        'URL must be a valid URI format or environment variable reference'
      )
      .optional(),
    provider: z.enum(
      [
        'openai',
        'openai-responses',
        'anthropic',
        'google',
        'mistral',
        'local',
        'iassistant-conversation',
        'bedrock'
      ],
      {
        errorMap: () => ({
          message:
            'Provider must be one of: openai, openai-responses, anthropic, google, mistral, local, iassistant-conversation, bedrock'
        })
      }
    ),
    tokenLimit: z
      .number()
      .int()
      .min(1, 'Token limit must be at least 1')
      .max(1000000, 'Token limit cannot exceed 1,000,000')
      .nullable()
      .optional(),

    // Optional fields with validation
    default: z.boolean().optional().default(false),
    supportsTools: z.boolean().optional().default(false),
    concurrency: z
      .number()
      .int()
      .min(1, 'Concurrency must be at least 1')
      .max(100, 'Concurrency cannot exceed 100')
      .optional(),
    requestDelayMs: z
      .number()
      .int()
      .min(0, 'Request delay cannot be negative')
      .max(10000, 'Request delay cannot exceed 10 seconds')
      .optional(),
    enabled: z.boolean().optional().default(true),
    thinking: thinkingSchema.optional(),

    // Additional fields for specific providers
    supportsImages: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsAudio: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    supportsUsageTracking: z.boolean().optional(),
    supportsImageGeneration: z.boolean().optional().default(false),
    imageGeneration: imageGenerationSchema.optional(),
    config: z.record(z.any()).optional(), // Allow provider-specific configuration

    // Hint configuration - display important messages when model is selected
    hint: hintSchema.optional(),

    // API Key configuration - stored encrypted on server
    apiKey: z.string().optional(), // Encrypted API key for this model

    // Model auto-discovery - automatically detect model ID from /v1/models endpoint
    // Useful for local LLM providers (vLLM, LM Studio, Jan.ai) where the active model can change
    autoDiscovery: z.boolean().optional().default(false)
  })
  .strict(); // Use strict instead of passthrough for better validation

export const knownModelKeys = Object.keys(modelConfigSchema.shape);
