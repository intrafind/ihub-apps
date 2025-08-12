import { z } from 'zod';

// Localized string schema - matches client pattern for language codes
const localizedStringSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

// Variable predefined value schema
const predefinedValueSchema = z.object({
  value: z.string().min(1, 'Value cannot be empty'),
  label: localizedStringSchema
});

// Variable configuration schema
const variableSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z_][a-zA-Z0-9_-]*$/,
      'Variable name must start with letter/underscore and contain only alphanumeric characters, underscores, and hyphens'
    ),
  label: localizedStringSchema,
  type: z.enum(['string', 'text', 'number', 'boolean', 'date', 'select']),
  required: z.boolean().optional().default(false),
  defaultValue: z
    .record(
      z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
      z.string() // Allow empty strings for default values
    )
    .optional(),
  predefinedValues: z.array(predefinedValueSchema).optional()
});

// Starter prompt schema
const starterPromptSchema = z.object({
  title: localizedStringSchema,
  message: localizedStringSchema,
  variables: z.record(z.any()).optional()
});

// Settings configuration schema
const settingsSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    model: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    temperature: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    outputFormat: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    chatHistory: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    style: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    speechRecognition: z
      .object({
        service: z.enum(['default', 'azure']).optional().default('default'),
        host: z.string().url().optional()
      })
      .optional()
  })
  .optional();

// Input mode configuration schema
const inputModeSchema = z
  .object({
    type: z.enum(['singleline', 'multiline']).optional().default('multiline'),
    rows: z.number().int().min(1).max(20).optional().default(5),
    microphone: z
      .object({
        enabled: z.boolean().optional().default(true),
        mode: z.enum(['manual', 'auto']).optional().default('manual'),
        showTranscript: z.boolean().optional().default(true)
      })
      .optional()
  })
  .optional();

// Upload configuration schema
const uploadSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    imageUpload: z
      .object({
        enabled: z.boolean().optional().default(false),
        resizeImages: z.boolean().optional().default(true),
        maxFileSizeMB: z.number().int().min(1).max(100).optional().default(10),
        supportedFormats: z
          .array(z.string().regex(/^image\//))
          .optional()
          .default(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'])
      })
      .optional(),
    fileUpload: z
      .object({
        enabled: z.boolean().optional().default(false),
        maxFileSizeMB: z.number().int().min(1).max(100).optional().default(5),
        supportedTextFormats: z
          .array(z.string())
          .optional()
          .default([
            'text/plain',
            'text/markdown',
            'text/csv',
            'application/json',
            'text/html',
            'text/css',
            'text/javascript',
            'application/javascript',
            'text/xml'
          ]),
        supportedPdfFormats: z.array(z.string()).optional().default(['application/pdf'])
      })
      .optional()
  })
  .optional();

// Features configuration schema
const featuresSchema = z
  .object({
    magicPrompt: z
      .object({
        enabled: z.boolean().optional().default(false),
        model: z.string().optional().default('gpt-4'),
        prompt: z
          .string()
          .optional()
          .default(
            'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
          )
      })
      .optional()
  })
  .passthrough(); // Allow additional feature flags

// Localized greeting schema
const localizedGreetingSchema = z.record(
  z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  z.object({
    title: z.string().min(1),
    subtitle: z.string().min(1)
  })
);

// Thinking configuration schema
const thinkingSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    budget: z.number().int().min(1).optional(),
    thoughts: z.boolean().optional().default(false)
  })
  .optional();

// Sources configuration - only supports string references to admin-configured sources
const sourceReferenceSchema = z.string().min(1, 'Source reference ID cannot be empty');

export const appConfigSchema = z
  .object({
    // Required fields
    id: z
      .string()
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        'ID must contain only alphanumeric characters, underscores, and hyphens'
      )
      .min(1, 'ID cannot be empty')
      .max(50, 'ID cannot exceed 50 characters'),
    name: localizedStringSchema,
    description: localizedStringSchema,
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex code (e.g., #4F46E5)'),
    icon: z.string().min(1, 'Icon cannot be empty'),
    system: localizedStringSchema,
    tokenLimit: z
      .number()
      .int()
      .min(1, 'Token limit must be at least 1')
      .max(1000000, 'Token limit cannot exceed 1,000,000'),

    // Optional fields with validation
    order: z.number().int().min(0).optional(),
    preferredModel: z.string().optional(),
    preferredOutputFormat: z.enum(['markdown', 'text', 'json', 'html']).optional(),
    preferredStyle: z.string().optional(),
    preferredTemperature: z.number().min(0).max(2).optional(),
    sendChatHistory: z.boolean().optional().default(true),
    thinking: thinkingSchema.optional(),
    messagePlaceholder: localizedStringSchema.optional(),
    prompt: localizedStringSchema.optional(),
    variables: z.array(variableSchema).optional(),
    settings: settingsSchema.optional(),
    inputMode: inputModeSchema.optional(),
    upload: uploadSchema.optional(),
    features: featuresSchema.optional(),
    greeting: localizedGreetingSchema.optional(),
    starterPrompts: z.array(starterPromptSchema).optional(),
    sources: z.array(sourceReferenceSchema).optional(),
    allowedModels: z.array(z.string()).optional(),
    disallowModelSelection: z.boolean().optional().default(false),
    allowEmptyContent: z.boolean().optional().default(false),
    tools: z.array(z.string()).optional(),
    outputSchema: z.union([z.object({}).passthrough(), z.string()]).optional(),
    category: z.string().optional(),
    enabled: z.boolean().optional().default(true),

    // Inheritance fields
    allowInheritance: z.boolean().optional().default(false),
    parentId: z.string().optional(),
    inheritanceLevel: z.number().int().min(0).optional(),
    overriddenFields: z.array(z.string()).optional()
  })
  .strict(); // Use strict instead of passthrough for better validation

export const knownAppKeys = Object.keys(appConfigSchema.shape);
