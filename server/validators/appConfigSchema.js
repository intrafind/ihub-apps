import { z } from 'zod';

// Source configuration schema
const sourceConfigSchema = z.object({
  id: z.string(), // Unique identifier for the source
  type: z.enum(['filesystem', 'url', 'ifinder']), // Source handler type
  description: z.string().optional(), // Human-readable description
  config: z.object({ // Handler-specific configuration
    // Filesystem config
    path: z.string().optional(),
    encoding: z.string().optional(),
    // URL config  
    url: z.string().optional(),
    maxContentLength: z.number().optional(),
    cleanContent: z.boolean().optional(),
    followRedirects: z.boolean().optional(),
    // iFinder config
    documentId: z.string().optional(),
    query: z.string().optional(),
    searchProfile: z.string().optional(),
    maxResults: z.number().optional(),
    maxLength: z.number().optional()
  }).optional(),
  exposeAs: z.enum(['prompt', 'tool']).default('prompt'), // How to expose the source
  caching: z.object({ // Caching configuration
    ttl: z.number().optional(), // Time to live in seconds
    strategy: z.enum(['static', 'refresh']).optional()
  }).optional(),
  enabled: z.boolean().default(true) // Whether source is enabled
});

export const appConfigSchema = z
  .object({
    id: z.string(),
    order: z.number().optional(),
    name: z.record(z.string()),
    description: z.record(z.string()),
    color: z.string(),
    icon: z.string(),
    system: z.record(z.string()),
    tokenLimit: z.number(),
    preferredModel: z.string().optional(),
    preferredOutputFormat: z.string().optional(),
    preferredStyle: z.string().optional(),
    preferredTemperature: z.number().optional(),
    sendChatHistory: z.boolean().optional(),
    messagePlaceholder: z.record(z.string()).optional(),
    prompt: z.record(z.string()).optional(),
    variables: z.array(z.any()).optional(),
    settings: z.any().optional(),
    inputMode: z.any().optional(),
    imageUpload: z.any().optional(),
    fileUpload: z.any().optional(),
    features: z.any().optional(),
    greeting: z.any().optional(),
    starterPrompts: z.array(z.any()).optional(),
    // New sources system (replaces sourcePath)
    sources: z.array(sourceConfigSchema).optional(),
    // Legacy field - will be removed in migration
    sourcePath: z.string().optional(),
    allowedModels: z.array(z.string()).optional(),
    disallowModelSelection: z.boolean().optional(),
    allowEmptyContent: z.boolean().optional(),
    tools: z.array(z.string()).optional(),
    outputSchema: z.any().optional(),
    category: z.string().optional(),
    enabled: z.boolean().optional(),
    // Inheritance fields
    allowInheritance: z.boolean().optional(),
    parentId: z.string().optional(),
    inheritanceLevel: z.number().optional(),
    overriddenFields: z.array(z.string()).optional()
  })
  .passthrough();

export const knownAppKeys = Object.keys(appConfigSchema.shape);
