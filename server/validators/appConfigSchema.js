import { z } from 'zod';
import {
  APP_ID_PATTERN,
  APP_ID_MAX_LENGTH,
  HEX_COLOR_PATTERN,
  LANGUAGE_CODE_PATTERN,
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
      z.string().regex(LANGUAGE_CODE_PATTERN),
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

// Web search configuration schema
const websearchSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    provider: z.enum(['auto', 'brave']).optional().default('auto'),
    useNativeSearch: z.boolean().optional().default(true),
    maxResults: z.number().int().min(1).max(20).optional().default(5),
    extractContent: z.boolean().optional().default(true),
    contentMaxLength: z.number().int().min(500).max(50000).optional().default(3000),
    enabledByDefault: z.boolean().optional().default(false)
  })
  .optional();

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
    ephemeral: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    style: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    imageGeneration: z
      .object({
        enabled: z.boolean().optional().default(true)
      })
      .optional(),
    speechRecognition: z
      .object({
        service: z
          .enum(['default', 'azure', 'custom', 'vllm-realtime'])
          .optional()
          .default('default'),
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
        mode: z.enum(['manual', 'automatic']).optional().default('manual'),
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
    audioUpload: z
      .object({
        enabled: z.boolean().optional().default(false),
        maxFileSizeMB: z.number().int().min(1).max(2000).optional().default(20),
        supportedFormats: z
          .array(z.string().regex(/^audio\//))
          .optional()
          .default(['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/flac', 'audio/ogg', 'audio/mp4'])
      })
      .optional(),
    // Video upload — the client extracts the audio track (extractAudio) for
    // transcription or multimodal audio handling. Previously the client
    // supported this but the schema silently stripped the block.
    videoUpload: z
      .object({
        enabled: z.boolean().optional().default(false),
        extractAudio: z.boolean().optional().default(true),
        maxFileSizeMB: z.number().int().min(1).max(2000).optional().default(50),
        supportedFormats: z
          .array(z.string().regex(/^video\//))
          .optional()
          .default(['video/mp4', 'video/webm', 'video/quicktime'])
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
      .optional(),
    cloudStorageUpload: z
      .object({
        enabled: z.boolean().optional().default(false)
      })
      .optional()
  })
  .optional();

// Transcription configuration schema (routes audio to a modelType:'transcription' model).
//
// When enabled, audio sources (uploaded audio, audio extracted from an uploaded
// video, or a browser recording) are transcribed by the referenced
// `modelType: "transcription"` model and rendered as an assistant chat turn —
// instead of being sent as `audioData` to the multimodal chat model. Coexists
// with the multimodal `audioUpload` path; both never fire for one submission.
const transcriptionSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    // Whether the per-chat transcription toggle starts on. When on, audio/video
    // submissions are transcribed by the transcription model; when off they fall
    // through to the multimodal chat path. Users can flip it per conversation.
    defaultEnabled: z.boolean().optional().default(true),
    // Id of the transcription model (modelType: 'transcription') to route to.
    modelId: z.string().optional().default(''),
    inputs: z
      .object({
        upload: z.boolean().optional().default(true),
        record: z.boolean().optional().default(true),
        video: z.boolean().optional().default(true)
      })
      .optional()
      .default({}),
    // Stream partial transcription deltas into the assistant bubble.
    streaming: z.boolean().optional().default(true),
    // Client-enforced cap on decoded audio / recording length (seconds).
    maxDurationSeconds: z.number().int().min(1).max(7200).optional().default(900)
  })
  .optional();

// Image generation configuration schema for app-level defaults
const imageGenerationConfigSchema = z
  .object({
    aspectRatio: z
      .enum(['1:1', '16:9', '9:16', '5:4', '4:5', '3:2', '2:3', '3:4', '4:3', '21:9'])
      .optional(),
    quality: z.enum(['Low', 'Medium', 'High']).optional()
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
      .optional(),
    compareMode: z
      .object({
        // Compare mode is opt-out at the app level: if the object exists but `enabled` is
        // unset, treat it as enabled. The client uses `enabled !== false` for the same reason.
        enabled: z.boolean().optional().default(true)
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

// iAssistant configuration schema for app-level settings
const iAssistantConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),

    // Legacy fields (for backward compatibility)
    baseUrl: z.string().url('Base URL must be a valid URL').optional(),
    filter: z.array(iAssistantFilterSchema).optional(),
    searchMode: z.string().optional(),
    searchDistance: z.string().optional(),
    searchFields: z.record(z.any()).optional(),

    // New dedicated configuration fields (similar to websearch)
    profileId: z
      .string()
      .min(2, 'Profile ID must be at least 2 characters')
      .max(64, 'Profile ID cannot exceed 64 characters')
      .regex(
        /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
        'Profile ID must be URL-safe (lowercase, numbers, hyphens)'
      )
      .optional()
      .or(z.literal('')),
    searchProfile: z.string().min(1, 'Search profile cannot be empty').optional().or(z.literal('')),
    extraContext: z.string().optional(),
    systemPromptPreamble: z.string().optional()
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

  // Optional fields with validation
  order: z.number().int().min(0).optional(),
  preferredModel: z.string().optional(),
  preferredOutputFormat: z.enum(['markdown', 'text', 'json', 'html']).optional(),
  preferredStyle: z.string().optional(),
  preferredTemperature: z.number().min(0).max(2).optional(),
  sendChatHistory: z.boolean().optional().default(true),
  thinking: thinkingSchema.optional(),
  imageGeneration: imageGenerationConfigSchema,
  messagePlaceholder: localizedStringSchema.optional(),
  prompt: localizedStringSchema.optional(),
  variables: z.array(variableSchema).optional(),
  settings: settingsSchema.optional(),
  inputMode: inputModeSchema.optional(),
  upload: uploadSchema.optional(),
  transcription: transcriptionSchema,
  features: featuresSchema.optional(),
  greeting: localizedGreetingSchema.optional(),
  starterPrompts: z.array(starterPromptSchema).optional(),
  sources: z.array(sourceReferenceSchema).optional(),
  allowedModels: z.array(z.string()).optional(),
  disallowModelSelection: z.boolean().optional().default(false),
  allowEmptyContent: z.boolean().optional().default(false),
  autoStart: z.boolean().optional().default(false),
  ephemeral: z.boolean().optional().default(false),
  websearch: websearchSchema,
  tools: z.array(z.string()).optional(),
  workflows: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  skillSettings: z
    .object({
      autoActivate: z.boolean().optional(),
      maxActiveSkills: z.number().min(1).max(10).optional()
    })
    .optional(),
  outputSchema: z.union([z.object({}).passthrough(), z.string()]).optional(),
  customResponseRenderer: z.string().optional(),
  rendererConfig: z.object({}).passthrough().optional(),
  category: z.string().optional(),
  enabled: z.boolean().optional().default(true),

  // Integration surface visibility - absent/empty means visible everywhere.
  // Non-empty restricts the app to only the listed surfaces (e.g. 'web', 'outlook').
  restrictToIntegrations: z.array(z.string()).optional(),

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
