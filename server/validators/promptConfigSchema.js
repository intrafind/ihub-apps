import { z } from 'zod';

// Localized string schema - matches client pattern for language codes
const localizedStringSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., "en", "de", "en-US")'),
  z.string().min(1, 'Localized string cannot be empty')
);

// Predefined value schema for select-type variables
const predefinedValueSchema = z
  .object({
    label: localizedStringSchema,
    value: z.union([z.string(), z.number(), z.boolean()])
  })
  .strict();

// Variable configuration schema
const variableSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-zA-Z_][a-zA-Z0-9_-]*$/,
        'Variable name must start with letter/underscore and contain only alphanumeric characters, underscores, and hyphens'
      ),
    label: localizedStringSchema,
    type: z.enum(['string', 'number', 'boolean', 'select', 'textarea']).default('string'),
    required: z.boolean().optional().default(false),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
    predefinedValues: z.array(predefinedValueSchema).optional()
  })
  .strict();

// Action configuration schema
const actionSchema = z
  .object({
    id: z.string().min(1, 'Action ID cannot be empty'),
    label: localizedStringSchema,
    description: localizedStringSchema.optional()
  })
  .strict();

// Output schema configuration
const outputSchemaConfig = z
  .object({
    type: z.enum(['object', 'array', 'string', 'number', 'boolean']),
    properties: z.record(z.any()).optional(),
    required: z.array(z.string()).optional()
  })
  .passthrough(); // Allow additional JSON schema properties

export const promptConfigSchema = z
  .object({
    // Required fields
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'ID must contain only lowercase letters, numbers, and hyphens')
      .min(1, 'ID cannot be empty'),
    name: localizedStringSchema,
    description: localizedStringSchema,
    prompt: localizedStringSchema,

    // Optional fields with validation
    icon: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    order: z.number().int().min(0).optional(),
    category: z.string().optional(),
    appId: z.string().optional(),
    variables: z.array(variableSchema).optional(),
    actions: z.array(actionSchema).optional(),
    outputSchema: outputSchemaConfig.optional()
  })
  .strict();

export const knownPromptKeys = Object.keys(promptConfigSchema.shape);
