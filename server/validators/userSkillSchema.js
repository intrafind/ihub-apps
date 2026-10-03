import { z } from 'zod';
import { shareTargetSchema } from './userPromptSchema.js';
import { MAX_SHARE_TARGETS } from '../services/skills/userSkillSettings.js';

/**
 * Input schemas for the skills users write themselves.
 *
 * A user skill is what a global skill folder holds: a `name` and a
 * `description` (the SKILL.md frontmatter), the instructions (`body`, the
 * SKILL.md body) and optional text files next to it. Names and descriptions
 * follow the Agent Skills rules the skill loader enforces for global skills;
 * file paths are one folder deep (`references/`, `assets/` or `scripts/`) and
 * text only, because skills read their files as UTF-8. Size and count limits
 * come from `platform.userSkills` and are checked by the routes.
 */

/** Agent Skills name rule — the same `skillLoader` applies to global skills. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A skill file path: one folder, one plain file name, a text extension. */
export const SKILL_FILE_PATH_PATTERN =
  /^(references|assets|scripts)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt|csv|json|ya?ml)$/;

export const skillNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(64, 'Name is too long')
  .regex(
    SKILL_NAME_PATTERN,
    'Name must use lowercase letters, digits and hyphens, and start and end with a letter or digit'
  )
  .refine(name => !name.includes('--'), 'Name must not contain two hyphens in a row');

const skillFileSchema = z
  .object({
    path: z
      .string()
      .max(200)
      .regex(
        SKILL_FILE_PATH_PATTERN,
        'File paths are references/, assets/ or scripts/ plus a .md, .txt, .csv, .json or .yaml file name'
      ),
    content: z.string()
  })
  .strict();

/** The revisioned fields of a user skill, as a create or an update sends them. */
export const userSkillContentSchema = z
  .object({
    name: skillNameSchema,
    description: z
      .string()
      .trim()
      .min(1, 'Description is required')
      .max(1024, 'Description is too long (at most 1024 characters)'),
    body: z.string().min(1, 'Instructions are required'),
    files: z
      .array(skillFileSchema)
      .optional()
      .refine(
        files => new Set((files || []).map(file => file.path)).size === (files || []).length,
        'Each file path may be used only once'
      )
  })
  .strict();

/** `PUT /api/user-skills/:id` — the content plus the revision the editor started from. */
export const userSkillUpdateSchema = userSkillContentSchema
  .extend({ expectedRevision: z.number().int().min(1).optional() })
  .strict();

export const skillSharesUpdateSchema = z
  .object({ shares: z.array(shareTargetSchema).max(MAX_SHARE_TARGETS) })
  .strict();

export const skillTransferSchema = z
  .object({ ownerId: z.string().trim().min(1).max(200) })
  .strict();

export const skillDuplicateSchema = z.object({ name: skillNameSchema.optional() }).strict();

export const skillPromoteSchema = z.object({ name: skillNameSchema.optional() }).strict();

/** `PUT /api/admin/user-skills/settings` — any subset of the settings. */
export const userSkillSettingsSchema = z
  .object({
    enabled: z.boolean(),
    maxSkillsPerUser: z.number().int().min(0).max(100000),
    maxVersions: z.number().int().min(1).max(1000),
    maxSkillSizeKB: z.number().int().min(1).max(10240),
    maxFilesPerSkill: z.number().int().min(1).max(200),
    sharing: z
      .object({
        allowUsers: z.boolean(),
        allowGroups: z.boolean(),
        allowEveryone: z.boolean(),
        restrictToGroups: z.array(z.string().trim().min(1).max(200)).max(200)
      })
      .partial()
      .strict()
  })
  .partial()
  .strict();

export { describeIssues } from './userPromptSchema.js';
