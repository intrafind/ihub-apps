import { z } from 'zod';
import { VARIABLE_NAME_PATTERN, VARIABLE_TYPES } from '../../shared/promptVariables.js';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';
import { SHARE_PERMISSIONS, SHARE_TARGET_TYPES } from '../services/prompts/userPromptAccess.js';
import { MAX_SHARE_TARGETS } from '../services/prompts/userPromptSettings.js';

/**
 * Input schemas for the prompts users write themselves (#2519).
 *
 * A user prompt is written in one language, so its texts are plain strings.
 * Its variables reuse the shape of a global prompt's `variables` — label,
 * description, type, default, required, select options — with the labels
 * allowed to be either a string or a localized object, so a global prompt
 * duplicated into "My prompts" keeps its translated labels.
 */

const LANGUAGE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/;

const textOrLocalized = max =>
  z.union([
    z.string().trim().max(max),
    z.record(z.string().regex(LANGUAGE_CODE), z.string().max(max))
  ]);

const scalar = z.union([z.string().max(2000), z.number(), z.boolean()]);

export const userPromptVariableSchema = z
  .object({
    name: z
      .string()
      .regex(
        VARIABLE_NAME_PATTERN,
        'Variable name must start with a letter or underscore and contain only letters, digits, underscores and hyphens'
      )
      .max(64),
    label: textOrLocalized(200).optional(),
    description: textOrLocalized(500).optional(),
    type: z.enum(VARIABLE_TYPES).optional(),
    required: z.boolean().optional(),
    defaultValue: scalar.optional(),
    predefinedValues: z
      .array(z.object({ label: textOrLocalized(200), value: scalar }).strict())
      .max(100)
      .optional()
  })
  .strict();

const optionalId = z
  .string()
  .trim()
  .max(100)
  .regex(SAFE_ID_PATTERN, 'Only letters, digits, dots, underscores and hyphens are allowed')
  .nullable()
  .optional()
  .or(z.literal(''));

/** The revisioned fields of a user prompt, as a create or an update sends them. */
export const userPromptContentSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
    description: z.string().trim().max(2000, 'Description is too long').optional(),
    prompt: z.string().min(1, 'Prompt text is required').max(20000, 'Prompt is too long'),
    icon: z
      .string()
      .trim()
      .max(64)
      .regex(/^[a-z0-9-]*$/, 'Invalid icon')
      .nullable()
      .optional(),
    category: optionalId,
    appId: optionalId,
    variables: z
      .array(userPromptVariableSchema)
      .max(50, 'A prompt can declare at most 50 variables')
      .optional()
      .refine(
        variables => new Set((variables || []).map(v => v.name)).size === (variables || []).length,
        'Each variable may be declared only once'
      )
  })
  .strict();

/** `PUT /api/prompts/:id` — the content plus the revision the editor started from. */
export const userPromptUpdateSchema = userPromptContentSchema
  .extend({ expectedRevision: z.number().int().min(1).optional() })
  .strict();

/** One entry of `PUT /api/prompts/:id/shares`. */
export const shareTargetSchema = z
  .object({
    type: z.enum(SHARE_TARGET_TYPES),
    id: z.string().trim().min(1).max(200).nullable().optional(),
    permission: z.enum(SHARE_PERMISSIONS).prefault('use')
  })
  .strict();

export const sharesUpdateSchema = z
  .object({ shares: z.array(shareTargetSchema).max(MAX_SHARE_TARGETS) })
  .strict();

export const transferSchema = z.object({ ownerId: z.string().trim().min(1).max(200) }).strict();

export const duplicateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    language: z.string().regex(LANGUAGE_CODE).optional()
  })
  .strict();

export const preferencesUpdateSchema = z
  .object({
    favorites: z.array(z.string().max(100)).max(500).optional(),
    recents: z
      .array(z.object({ id: z.string().max(100), at: z.string().max(64) }).strict())
      .max(50)
      .optional()
  })
  .strict();

export const promoteSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9._-]+$/,
        'ID must contain only lowercase letters, numbers, underscores, dots, and hyphens'
      )
      .min(1)
      .max(100)
      .optional(),
    enabled: z.boolean().optional()
  })
  .strict();

/**
 * One readable line out of a zod error.
 *
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
export function describeIssues(error) {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}
