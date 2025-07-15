import { z } from 'zod';

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
