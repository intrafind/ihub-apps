import { z } from 'zod';
import {
  APP_ID_PATTERN,
  APP_ID_MAX_LENGTH,
  HEX_COLOR_PATTERN,
  LANGUAGE_CODE_PATTERN,
  TOKEN_LIMIT_MIN,
  TOKEN_LIMIT_MAX,
  VARIABLE_NAME_PATTERN
} from '../../shared/validationPatterns.js';

// Localized string schema - matches client pattern for language codes
const localizedStringSchema = z.record(
  z
    .string()
    .regex(LANGUAGE_CODE_PATTERN, 'Invalid language code format (e.g., "en", "de", "en-US")'),
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
      VARIABLE_NAME_PATTERN,
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
  description: localizedStringSchema.optional(),
  variables: z.record(z.any()).optional(),
  autoSend: z.boolean().optional().default(false)
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
    allowMultiple: z.boolean().optional().default(false),
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
        supportedFormats: z
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
            'text/xml',
            'message/rfc822',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-outlook',
            'application/vnd.oasis.opendocument.text',
            'application/vnd.oasis.opendocument.spreadsheet',
            'application/vnd.oasis.opendocument.presentation'
          ])
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
        APP_ID_PATTERN,
        'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
      )
      .min(1, 'ID cannot be empty')
      .max(APP_ID_MAX_LENGTH, `ID cannot exceed ${APP_ID_MAX_LENGTH} characters`),
    name: localizedStringSchema,
    description: localizedStringSchema,
    color: z.string().regex(HEX_COLOR_PATTERN, 'Color must be a valid hex code (e.g., #4F46E5)'),
    icon: z.string().min(1, 'Icon cannot be empty'),
    system: localizedStringSchema,
    tokenLimit: z
      .number()
      .int()
      .min(TOKEN_LIMIT_MIN, `Token limit must be at least ${TOKEN_LIMIT_MIN}`)
      .max(TOKEN_LIMIT_MAX, `Token limit cannot exceed ${TOKEN_LIMIT_MAX.toLocaleString()}`),

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
    customResponseRenderer: z.string().optional(),

    // Inheritance fields
    allowInheritance: z.boolean().optional().default(false),
    parentId: z.string().optional(),
    inheritanceLevel: z.number().int().min(0).optional(),
    overriddenFields: z.array(z.string()).optional()
  })
  .strict(); // Use strict instead of passthrough for better validation

export const knownAppKeys = Object.keys(appConfigSchema.shape);
