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
        enabled: z.boolean().optional().default(true),
        filter: z.record(z.any()).optional() // Allow filtering models by any property
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

// Redirect app configuration schema
const redirectConfigSchema = z.object({
  url: z.string().url('Redirect URL must be a valid URL'),
  openInNewTab: z.boolean().optional().default(true),
  showWarning: z.boolean().optional().default(true)
});

// Iframe app configuration schema
const iframeConfigSchema = z.object({
  url: z.string().url('Iframe URL must be a valid URL'),
  allowFullscreen: z.boolean().optional().default(true),
  sandbox: z
    .array(z.string())
    .optional()
    .default(['allow-scripts', 'allow-same-origin', 'allow-forms'])
});

// iAssistant filter schema for app-specific iAssistant configuration
const iAssistantFilterSchema = z.object({
  key: z.string().min(1, 'Filter key cannot be empty'),
  values: z.array(z.string()),
  isNegated: z.boolean().optional().default(false)
});

// iAssistant configuration schema for tool-specific settings
const iAssistantConfigSchema = z
  .object({
    baseUrl: z.string().url('Base URL must be a valid URL').optional(),
    profileId: z.string().min(1, 'Profile ID cannot be empty').optional(),
    filter: z.array(iAssistantFilterSchema).optional(),
    searchMode: z.string().optional(),
    searchDistance: z.string().optional(),
    searchFields: z.record(z.any()).optional()
  })
  .optional();

// Base app config schema without refinements
const baseAppConfigSchema = z.object({
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

  // App type - defaults to 'chat' for backward compatibility
  type: z.enum(['chat', 'redirect', 'iframe']).optional().default('chat'),

  // Type-specific configuration
  redirectConfig: redirectConfigSchema.optional(),
  iframeConfig: iframeConfigSchema.optional(),

  // Chat-specific fields (optional to support non-chat types)
  system: localizedStringSchema.optional(),
  tokenLimit: z
    .number()
    .int()
    .min(TOKEN_LIMIT_MIN, `Token limit must be at least ${TOKEN_LIMIT_MIN}`)
    .max(TOKEN_LIMIT_MAX, `Token limit cannot exceed ${TOKEN_LIMIT_MAX.toLocaleString()}`)
    .optional(),

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
  disabledByDefault: z.array(z.string()).optional(),
  outputSchema: z.union([z.object({}).passthrough(), z.string()]).optional(),
  customResponseRenderer: z.string().optional(),
  category: z.string().optional(),
  enabled: z.boolean().optional().default(true),

  // Tool-specific configurations
  iassistant: iAssistantConfigSchema,

  // Inheritance fields
  allowInheritance: z.boolean().optional().default(false),
  parentId: z.string().optional(),
  inheritanceLevel: z.number().int().min(0).optional(),
  overriddenFields: z.array(z.string()).optional()
});

// Export known app keys from base schema before adding refinements
export const knownAppKeys = Object.keys(baseAppConfigSchema.shape);

// Add validation refinements and export the final schema
export const appConfigSchema = baseAppConfigSchema
  .strict() // Use strict instead of passthrough for better validation
  .refine(
    data => {
      // For chat type apps, system and tokenLimit are required
      if (data.type === 'chat' || !data.type) {
        return data.system !== undefined && data.tokenLimit !== undefined;
      }
      return true;
    },
    {
      message: 'Chat type apps require system prompt and tokenLimit fields'
    }
  )
  .refine(
    data => {
      // For redirect type apps, redirectConfig is required
      if (data.type === 'redirect') {
        return data.redirectConfig !== undefined;
      }
      return true;
    },
    {
      message: 'Redirect type apps require redirectConfig with url field'
    }
  )
  .refine(
    data => {
      // For iframe type apps, iframeConfig is required
      if (data.type === 'iframe') {
        return data.iframeConfig !== undefined;
      }
      return true;
    },
    {
      message: 'Iframe type apps require iframeConfig with url field'
    }
  );
