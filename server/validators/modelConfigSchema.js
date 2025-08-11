import { z } from 'zod';

// Localized string schema - matches client pattern for language codes
const localizedStringSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

// Thinking configuration schema
const thinkingSchema = z
  .object({
    enabled: z.boolean(),
    budget: z.number().int(), // 0=disabled, -1=dynamic, positive=specific budget
    thoughts: z.boolean() // whether to include thoughts in response
  })
  .strict();

export const modelConfigSchema = z
  .object({
    // Required fields
    id: z
      .string()
      .regex(/^[a-z0-9.-]+$/, 'ID must contain only lowercase letters, numbers, hyphens, and dots')
      .min(1, 'ID cannot be empty'),
    modelId: z.string().min(1, 'Model ID cannot be empty'),
    name: localizedStringSchema,
    description: localizedStringSchema,
    url: z.string().url('URL must be a valid URI format'),
    provider: z.enum(['openai', 'anthropic', 'google', 'mistral', 'local', 'iassistant'], {
      errorMap: () => ({
        message: 'Provider must be one of: openai, anthropic, google, mistral, local, iassistant'
      })
    }),
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
    config: z.record(z.any()).optional() // Allow provider-specific configuration
  })
  .strict(); // Use strict instead of passthrough for better validation

export const knownModelKeys = Object.keys(modelConfigSchema.shape);
