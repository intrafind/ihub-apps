// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import {
  APP_ID_PATTERN,
  APP_ID_MAX_LENGTH,
  HEX_COLOR_PATTERN,
  LANGUAGE_CODE_PATTERN,
  VARIABLE_NAME_PATTERN
} from '../../shared/validationPatterns.js';
import { VOICE_LISTENING_STYLES } from '../../shared/voiceMode.js';
import { zHttpUrl } from './common.js';
import { projectLinksSchema } from './projectSchema.js';
import { FEATURE_IDS } from '../featureRegistry.js';
import { INTEGRATION_IDS } from '../integrationRegistry.js';

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
  // Help text and input placeholder shown with the variable in the chat UI.
  // Undeclared, both were stripped on load and never reached the client.
  description: localizedStringSchema.optional(),
  placeholder: localizedStringSchema.optional(),
  type: z.enum(['string', 'text', 'number', 'boolean', 'date', 'select']),
  required: z.boolean().optional().prefault(false),
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
  autoSend: z.boolean().optional().prefault(false)
});

// Usage guide (issue #2838): pre-written "how to use this app" text, written
// by an admin or generated once with a model in the app editor. The chat opens
// `content` in a dialog headed by `question` — no model call, and the guide
// never enters the chat. Kept in the app itself so it travels with exports,
// backups and the marketplace.
const usageGuideSchema = z
  .object({
    // The dialog's heading. An empty or missing language falls back to the
    // built-in question.
    question: z.record(z.string().regex(LANGUAGE_CODE_PATTERN), z.string()).optional(),
    // The guide, as markdown per language.
    content: localizedStringSchema
  })
  .optional();

// Form-based start (issue #2581): a new chat opens with the app's variables,
// plus a drop zone when uploads are on, as a form instead of the composer.
// Submitting sends the `prompt` filled with the answers as the first user
// message; follow-up messages go out as typed, without the template.
const startFormSchema = z
  .object({
    enabled: z.boolean().optional().prefault(false),
    // Text of the form's send button. An empty or missing language falls back
    // to the built-in label, so an emptied field in the admin editor saves.
    submitLabel: z.record(z.string().regex(LANGUAGE_CODE_PATTERN), z.string()).optional()
  })
  .optional();

// The input parameters panel beside the chat (issue #3053). Users can collapse,
// expand and pin it; `pinned` is the default for this app. Unpinned, the panel
// collapses each time a message is sent. Unset = pinned, as before.
const variablesPanelSchema = z
  .object({
    pinned: z.boolean().optional()
  })
  .optional();

// Web search configuration schema
const websearchSchema = z
  .object({
    enabled: z.boolean().optional().prefault(false),
    provider: z.enum(['auto', 'brave', 'staan', 'qwant']).optional().prefault('auto'),
    useNativeSearch: z.boolean().optional().prefault(true),
    maxResults: z.number().int().min(1).max(20).optional().prefault(5),
    extractContent: z.boolean().optional().prefault(true),
    contentMaxLength: z.number().int().min(500).max(50000).optional().prefault(3000),
    enabledByDefault: z.boolean().optional().prefault(false),
    // Cap on provider-run searches per model call (Anthropic web search `max_uses`).
    maxSearches: z.number().int().min(1).max(50).optional().prefault(5),
    // Cap on pages the model opens with the page reader in one chat answer
    // (services/chat/pageReadLimit.js). Unset = the built-in default of 5.
    maxPageReads: z.number().int().min(1).max(50).optional(),
    // Guidance appended to the system prompt when web search is on, telling the
    // model to research in several steps. true/unset = built-in text, false = off,
    // string = custom text replacing the built-in one.
    researchGuidance: z.union([z.boolean(), z.string().max(4000)]).optional()
  })
  .optional();

// Settings configuration schema
const settingsSchema = z
  .object({
    enabled: z.boolean().optional().prefault(true),
    model: z
      .object({
        enabled: z.boolean().optional().prefault(true),
        filter: z.record(z.any()).optional() // Allow filtering models by any property
      })
      .optional(),
    outputFormat: z
      .object({
        enabled: z.boolean().optional().prefault(true)
      })
      .optional(),
    chatHistory: z
      .object({
        enabled: z.boolean().optional().prefault(true)
      })
      .optional(),
    ephemeral: z
      .object({
        enabled: z.boolean().optional().prefault(true)
      })
      .optional(),
    style: z
      .object({
        enabled: z.boolean().optional().prefault(true)
      })
      .optional(),
    imageGeneration: z
      .object({
        enabled: z.boolean().optional().prefault(true)
      })
      .optional(),
    speechRecognition: z
      .object({
        // 'default' follows the platform default (platform.speech.defaultService);
        // 'browser' pins the browser Web Speech API; 'model' streams the
        // microphone through iHub to the transcription model `modelId`.
        service: z
          .enum(['default', 'browser', 'azure', 'custom', 'model'])
          .optional()
          .prefault('default'),
        modelId: z.string().optional(),
        host: z.string().url().optional()
      })
      .optional()
  })
  .optional();

// Input mode configuration schema
const inputModeSchema = z
  .object({
    type: z.enum(['singleline', 'multiline']).optional().prefault('multiline'),
    rows: z.number().int().min(1).max(20).optional().prefault(5),
    microphone: z
      .object({
        enabled: z.boolean().optional().prefault(true),
        mode: z.enum(['manual', 'automatic']).optional().prefault('manual'),
        showTranscript: z.boolean().optional().prefault(true)
      })
      .optional(),
    // Voice mode: a spoken conversation with the app. Nothing is defaulted
    // here: an absent `enabled`, `listeningStyle` or `ttsModelId` follows the
    // platform (`speech.voiceMode`, see shared/voiceMode.js). Voice mode shares
    // the app's speech service (settings.speechRecognition), and an app with
    // `microphone.enabled: false` has none.
    voiceMode: z
      .object({
        enabled: z.boolean().optional(),
        listeningStyle: z.enum(VOICE_LISTENING_STYLES).optional(),
        // A `modelType: "tts"` model; empty follows the platform's.
        ttsModelId: z.string().trim().max(200).optional(),
        // A voice of that model; empty uses the model's voice for the language.
        // The speech route takes ids up to 200 characters.
        voice: z.string().trim().max(200).optional()
      })
      .optional()
  })
  .optional();

// Upload configuration schema
const uploadSchema = z
  .object({
    enabled: z.boolean().optional().prefault(false),
    allowMultiple: z.boolean().optional().prefault(false),
    imageUpload: z
      .object({
        enabled: z.boolean().optional().prefault(false),
        resizeImages: z.boolean().optional().prefault(true),
        maxFileSizeMB: z.number().int().min(1).max(100).optional().prefault(10),
        supportedFormats: z
          .array(z.string().regex(/^image\//))
          .optional()
          .prefault(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'])
      })
      .optional(),
    audioUpload: z
      .object({
        enabled: z.boolean().optional().prefault(false),
        maxFileSizeMB: z.number().int().min(1).max(2000).optional().prefault(20),
        supportedFormats: z
          .array(z.string().regex(/^audio\//))
          .optional()
          .prefault([
            'audio/mpeg',
            'audio/wav',
            'audio/mp3',
            'audio/flac',
            'audio/ogg',
            'audio/mp4'
          ])
      })
      .optional(),
    // Video upload — the client extracts the audio track (extractAudio) for
    // transcription or multimodal audio handling. Previously the client
    // supported this but the schema silently stripped the block.
    videoUpload: z
      .object({
        enabled: z.boolean().optional().prefault(false),
        extractAudio: z.boolean().optional().prefault(true),
        // 50 GB: the browser reads only the index and the audio of an MP4/MOV (see
        // client/src/features/upload/utils/mp4AudioExtraction.js), so the size of
        // the video does not matter. Other containers stop at ~2 GB.
        maxFileSizeMB: z.number().int().min(1).max(51200).optional().prefault(50),
        supportedFormats: z
          .array(z.string().regex(/^video\//))
          .optional()
          .prefault(['video/mp4', 'video/webm', 'video/quicktime'])
      })
      .optional(),
    fileUpload: z
      .object({
        enabled: z.boolean().optional().prefault(false),
        // Word (.docx) review marks sent to the model — opt-in, so documents reach the model as
        // the accepted view without comments unless the app asks. `markup` writes tracked
        // insertions/deletions as CriticMarkup ({++added++} / {--removed--}), `inline` writes
        // comments as {>>Author: text<<} after the text they belong to.
        trackedChanges: z.enum(['accepted', 'markup']).optional().prefault('accepted'),
        comments: z.enum(['ignore', 'inline']).optional().prefault('ignore'),
        // PowerPoint (.pptx) and OpenDocument (.odp) decks: `include` sends the speaker notes of a
        // slide after its text as [Notes]. Off by default — notes are not what the audience sees.
        speakerNotes: z.enum(['ignore', 'include']).optional().prefault('ignore'),
        maxFileSizeMB: z.number().int().min(1).max(100).optional().prefault(20),
        supportedFormats: z
          .array(z.string())
          .optional()
          .prefault([
            'text/plain',
            'text/markdown',
            'text/csv',
            'text/vtt',
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
        enabled: z.boolean().optional().prefault(false)
      })
      .optional()
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
        enabled: z.boolean().optional().prefault(false),
        model: z.string().optional().prefault('gpt-4'),
        prompt: z
          .string()
          .optional()
          .prefault(
            'You are a helpful assistant that improves user prompts to be more specific and effective. Improve this prompt: {{prompt}}'
          )
      })
      .optional(),
    compareMode: z
      .object({
        // Compare mode is opt-out at the app level: if the object exists but `enabled` is
        // unset, treat it as enabled. The client uses `enabled !== false` for the same reason.
        enabled: z.boolean().optional().prefault(true)
      })
      .optional(),
    // Response feedback (star rating + comment) for this app. Absent means
    // enabled: only an explicit `false` opts the app out, and the platform-wide
    // `feedback` feature flag still has to be on for it to show at all.
    feedback: z.boolean().optional(),
    // Projects in this app (#1036). Absent means on: only an explicit `false`
    // switches off its linked projects, chats inside a project and attached
    // projects. `userProjects: false` keeps the admin projects but takes no
    // personal ones. The platform-wide `projects` / `userProjects` feature
    // flags still have to be on.
    projects: z.boolean().optional(),
    userProjects: z.boolean().optional()
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

// Thinking configuration schema. Mirrors the model config block
// (`server/validators/modelConfigSchema.js`): reasoning effort is a level, and
// there is no token-budget alternative — no provider ever accepted one.
const thinkingSchema = z
  .object({
    enabled: z.boolean().optional().prefault(false),
    level: z
      .enum(['minimal', 'low', 'medium', 'high', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'])
      .optional(),
    thoughts: z.boolean().optional().prefault(false)
  })
  .optional();

// Redirect app configuration schema
const redirectConfigSchema = z.object({
  // Navigated to by the client, so only http(s) is accepted.
  url: zHttpUrl('Redirect URL'),
  openInNewTab: z.boolean().optional().prefault(true),
  showWarning: z.boolean().optional().prefault(true)
});

// Iframe app configuration schema
const iframeConfigSchema = z.object({
  // Loaded as the iframe's src by the client, so only http(s) is accepted.
  url: zHttpUrl('Iframe URL'),
  allowFullscreen: z.boolean().optional().prefault(true),
  sandbox: z
    .array(z.string())
    .optional()
    .prefault(['allow-scripts', 'allow-same-origin', 'allow-forms'])
});

// iAssistant filter schema for app-specific iAssistant configuration
const iAssistantFilterSchema = z.object({
  key: z.string().min(1, 'Filter key cannot be empty'),
  values: z.array(z.string()),
  isNegated: z.boolean().optional().prefault(false)
});

// iAssistant configuration schema for app-level settings
const iAssistantConfigSchema = z
  .object({
    enabled: z.boolean().optional().prefault(false),

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
    // An iFinder iAssistant (`/public-api/v0/assistants`, iFinder 6.8+): it
    // supplies the conversation profile and the search profile, so it wins
    // over `profileId`, `searchProfile` and `allSearchProfiles`. Same pattern
    // as iFinder's AssistantId.
    assistantId: z
      .string()
      .max(256, 'iAssistant ID cannot exceed 256 characters')
      .regex(
        /^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/,
        'iAssistant ID may contain letters and digits separated by single dots, underscores or hyphens'
      )
      .optional()
      .or(z.literal('')),
    // Send no search profile, so iFinder (6.9+) retrieves across every search
    // profile the user has. Tri-state: undefined defers to the model.
    allSearchProfiles: z.boolean().optional(),
    extraContext: z.string().optional(),
    systemPromptPreamble: z.string().optional(),

    // Answer only from what retrieval returned, and say so when it returned
    // nothing, instead of falling back on the model's world knowledge. The
    // Conversation API has no such switch, so this is carried as a prompt —
    // see services/integrations/iAssistantGrounding.js. Tri-state on purpose:
    // undefined defers to the platform's `iAssistant.groundedOnly`, false
    // turns that default off for this app.
    groundedOnly: z.boolean().optional(),

    // The four below are read by the iAssistant adapter's resolveConfig but
    // were never declared here. Zod strips unknown keys and the resource
    // loader keeps the parsed object, so setting any of them on an app used
    // to do nothing at all — silently, with no validation error.
    //
    // `tools` in particular defaulted to [] at app level, which meant an app
    // could not enable ifinder_search for itself; only the model's own
    // `config.tools` ever reached the API.
    tools: z.array(z.string()).optional(),
    labels: z.union([z.string(), z.array(z.string())]).optional(),
    scope: z.string().optional(),
    ephemeral: z.boolean().optional()
  })
  .optional();

// Where the chat input offers an integration's scope and which scope the app
// starts with or pins (#3050). A scope is where the integration searches (an
// iFinder search profile id) or whom it asks (`assistant:<id>`, `configured`,
// `all` for iAssistant). A pinned scope is the only one the app's chats use.
const integrationScopeId = z
  .string()
  .min(1, 'Scope cannot be empty')
  .max(256, 'Scope cannot exceed 256 characters')

  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Scope cannot contain control characters');

const integrationScopeSettingsSchema = z
  .object({
    scopePicker: z.enum(['inline', 'menu', 'hidden']).optional(),
    defaultScope: integrationScopeId.optional(),
    pinnedScope: integrationScopeId.optional()
  })
  .strict();

const appIntegrationsSchema = z
  .object({
    ifinder: integrationScopeSettingsSchema.optional(),
    iassistant: integrationScopeSettingsSchema
      .extend({
        // Offer "all my search profiles" (iFinder 6.9+) beside the iAssistants.
        allowAllSearchProfiles: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .optional();

// Base app config schema without refinements
const baseAppConfigSchema = z.object({
  // Required fields
  id: z
    .string()
    .regex(
      APP_ID_PATTERN,
      'ID must contain only lowercase alphanumeric characters, underscores, dots, and hyphens'
    )
    .min(1, 'ID cannot be empty')
    .max(APP_ID_MAX_LENGTH, `ID cannot exceed ${APP_ID_MAX_LENGTH} characters`),
  name: localizedStringSchema,
  description: localizedStringSchema,
  color: z.string().regex(HEX_COLOR_PATTERN, 'Color must be a valid hex code (e.g., #4F46E5)'),
  icon: z.string().min(1, 'Icon cannot be empty'),

  // App type - defaults to 'chat' for backward compatibility
  type: z.enum(['chat', 'redirect', 'iframe']).optional().prefault('chat'),

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
  sendChatHistory: z.boolean().optional().prefault(true),
  thinking: thinkingSchema.optional(),
  imageGeneration: imageGenerationConfigSchema,
  messagePlaceholder: localizedStringSchema.optional(),
  prompt: localizedStringSchema.optional(),
  variables: z.array(variableSchema).optional(),
  startForm: startFormSchema,
  variablesPanel: variablesPanelSchema,
  settings: settingsSchema.optional(),
  inputMode: inputModeSchema.optional(),
  upload: uploadSchema.optional(),
  features: featuresSchema.optional(),
  greeting: localizedGreetingSchema.optional(),
  starterPrompts: z.array(starterPromptSchema).optional(),
  usageGuide: usageGuideSchema,
  // Projects linked to the app (#1036, spec 1 §6.1): a bare id or
  // `{ id, mode: 'auto' | 'context' | 'tools', write }`.
  projects: projectLinksSchema.optional(),
  allowedModels: z.array(z.string()).optional(),
  disallowModelSelection: z.boolean().optional().prefault(false),
  allowEmptyContent: z.boolean().optional().prefault(false),
  autoStart: z.boolean().optional().prefault(false),
  ephemeral: z.boolean().optional().prefault(false),
  websearch: websearchSchema,
  tools: z.array(z.string()).optional(),
  // `required`: the model's first call of each turn must call one of the app's
  // tools (see services/loop/toolChoice.js); later calls are `auto`.
  toolChoice: z.enum(['auto', 'required']).optional(),
  workflows: z.array(z.string()).optional(),
  // Other app ids this app may invoke as synthetic `app__<id>` tools
  // (requires the `appAsTool` platform feature; see appToolsGateway).
  apps: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  skillSettings: z
    .object({
      // Skills are opt-in: without `true`, the app offers no skills at all
      // (no prompt block, no skill tools, nothing carried over in the chat)
      enabled: z.boolean().optional(),
      autoActivate: z.boolean().optional(),
      maxActiveSkills: z.number().min(1).max(10).optional(),
      // false keeps users' own and shared skills out of this app
      allowPersonal: z.boolean().optional()
    })
    .optional(),
  // Document template (Admin → Document templates) every PDF, Word and
  // PowerPoint file this app's skills create uses; it also preselects the
  // template of the chat's PDF export.
  documentTemplate: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  outputSchema: z.union([z.object({}).passthrough(), z.string()]).optional(),
  customResponseRenderer: z.string().optional(),
  rendererConfig: z.object({}).passthrough().optional(),
  category: z.string().optional(),
  enabled: z.boolean().optional().prefault(true),
  // Feature ids (Admin → Features) the app needs; while one is off, users do
  // not get the app at all, as if it were disabled.
  requiredFeatures: z.array(z.enum(FEATURE_IDS)).optional(),
  // Integrations (Admin → Integrations, e.g. `ifinder`) the app needs; while one
  // is off, users do not get the app at all, as if it were disabled.
  requiredIntegrations: z.array(z.enum(INTEGRATION_IDS)).optional(),

  // Tool-specific configurations
  iassistant: iAssistantConfigSchema,
  // Per-integration chat settings: the scope picker (#3050)
  integrations: appIntegrationsSchema,

  // Inheritance fields
  allowInheritance: z.boolean().optional().prefault(false),
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
