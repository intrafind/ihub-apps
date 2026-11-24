// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a personal app may store, and the bodies of its routes (feature
 * `userApps`).
 *
 * The content schema is an allow-list: an unknown key is refused, at every
 * level. The caps and the allowed sub-keys come from
 * `shared/userAppContent.js`, so the client, the generator and this file
 * agree. Every text is cleaned of hidden characters before its length is
 * checked, so a reader of the instructions sees everything the model sees.
 *
 * Design: concepts/app-builder-rework-2026-11/02-personal-apps.md, sections
 * 4.4, 4.5 and 9.1.
 *
 * @module validators/userAppSchema
 */
import { z } from 'zod';
import { LANGUAGE_CODE_PATTERN, VARIABLE_NAME_PATTERN } from '../../shared/validationPatterns.js';
import { DEFAULT_APP_COLOR, DEFAULT_APP_ICON } from '../../shared/appDefaults.js';
import {
  USER_APP_COLOR_PATTERN,
  NO_MODEL_AVAILABLE_ID,
  USER_APP_INPUT_MODE_TYPES,
  USER_APP_OUTPUT_FORMATS,
  USER_APP_ICON_PATTERN,
  USER_APP_LIMITS,
  USER_APP_MEMBER_ROLES,
  USER_APP_MEMBER_TYPES,
  USER_APP_ORIGINS
} from '../../shared/userAppContent.js';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';
import { stripHiddenCharacters } from '../../shared/visibleText.js';

/** A text without the characters a reader cannot see; it lives in `shared/visibleText.js`. */
export { stripHiddenCharacters };

/** The installation that owns `ask_user` and the scheduling tools: never bound by a personal app. */
export const FORBIDDEN_INSTALLATION_ID = 'ihub';

/** The values of `publishing.adminEnables`. */
export const ADMIN_ENABLES_VALUES = Object.freeze(['withTools', 'always']);

const L = USER_APP_LIMITS;

/** A cleaned text of at most `max` characters; `allowEmpty: false` refuses a text that is blank. */
function text(max, { allowEmpty = false } = {}) {
  const cleaned = z.string().transform(stripHiddenCharacters);
  const bounded = z.string().max(max, `At most ${max} characters`);
  return cleaned.pipe(
    allowEmpty
      ? bounded
      : bounded.refine(value => value.trim() !== '', { message: 'The text cannot be empty' })
  );
}

const languageCode = z
  .string()
  .regex(LANGUAGE_CODE_PATTERN, 'Invalid language code format (e.g., "en", "de", "en-US")');

/** One text per language: at least one language, at most `USER_APP_LIMITS.languages`. */
function localized(max, options) {
  return z
    .record(languageCode, text(max, options))
    .refine(value => Object.keys(value).length >= 1, { message: 'At least one language' })
    .refine(value => Object.keys(value).length <= L.languages, {
      message: `At most ${L.languages} languages`
    });
}

/**
 * An optional text per language. An object without a language is the same
 * as no value: a merge patch that removes the last language leaves one.
 */
function optionalLocalized(max, options) {
  return z
    .record(languageCode, text(max, options))
    .refine(value => Object.keys(value).length <= L.languages, {
      message: `At most ${L.languages} languages`
    })
    .nullish()
    .transform(value => (value && Object.keys(value).length > 0 ? value : undefined));
}

const predefinedValueSchema = z
  .object({
    value: text(L.optionValue),
    label: localized(L.optionLabel)
  })
  .strict();

const variableSchema = z
  .object({
    name: z
      .string()
      .max(100)
      .regex(
        VARIABLE_NAME_PATTERN,
        'Variable name must start with letter/underscore and contain only alphanumeric characters, underscores, and hyphens'
      ),
    label: localized(L.variableLabel),
    type: z.enum(['string', 'text', 'number', 'boolean', 'date', 'select']),
    required: z.boolean().optional(),
    defaultValue: optionalLocalized(L.variableDefault, { allowEmpty: true }),
    predefinedValues: z.array(predefinedValueSchema).max(L.options).optional()
  })
  .strict();

const starterPromptSchema = z
  .object({
    title: localized(L.starterTitle),
    message: localized(L.starterMessage)
  })
  .strict();

const installationId = z
  .string()
  .min(1)
  .max(100)
  .regex(SAFE_ID_PATTERN, 'An installation ID, not a definition or a type key')
  .refine(id => id !== FORBIDDEN_INSTALLATION_ID, {
    message: `The installation "${FORBIDDEN_INSTALLATION_ID}" cannot be used by personal apps`
  });

const actionName = z
  .string()
  .min(1)
  .max(200)
  .refine(name => name !== '*', { message: 'Name each action; "*" is not accepted' });

/** One bound installation. `actions` is required and not empty. */
const integrationBindingSchema = z
  .object({
    id: installationId,
    actions: z
      .array(actionName)
      .min(1, 'A binding names its actions')
      .max(L.integrationActions)
      .transform(actions => [...new Set(actions)])
  })
  .strict();

function uniqueIds(bindings, ctx) {
  const seen = new Set();
  bindings.forEach((binding, index) => {
    if (seen.has(binding.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: 'Each installation can be bound once'
      });
    }
    seen.add(binding.id);
  });
}

const modelId = z
  .string()
  .min(1)
  .max(200)
  .regex(SAFE_ID_PATTERN, 'Invalid model ID')
  .refine(id => id !== NO_MODEL_AVAILABLE_ID, { message: 'Invalid model ID' });

/**
 * The models the app may use and whether the choice is locked. Only ever
 * narrows: the ceiling cuts the list to the models the owner and the person
 * chatting may use. An object without a value is the same as none.
 */
const modelsSchema = z
  .object({
    allowed: z
      .array(modelId)
      .max(L.models)
      .transform(ids => [...new Set(ids)])
      .optional(),
    lock: z.boolean().optional()
  })
  .strict()
  .nullish()
  .transform(value => {
    const models = value ? compact(value) : {};
    if (Array.isArray(models.allowed) && models.allowed.length === 0) delete models.allowed;
    if (models.lock !== true) delete models.lock;
    return Object.keys(models).length > 0 ? models : undefined;
  });

/** How the app researches on the web; only has an effect while web search is on. */
const webSearchSettingsSchema = z
  .object({
    maxPageReads: z.number().int().min(1).max(L.pageReads).optional(),
    researchGuidance: text(L.researchGuidance, { allowEmpty: true }).optional()
  })
  .strict()
  .nullish()
  .transform(value => {
    const settings = value ? compact(value) : {};
    if (settings.researchGuidance !== undefined && settings.researchGuidance.trim() === '') {
      delete settings.researchGuidance;
    }
    return Object.keys(settings).length > 0 ? settings : undefined;
  });

const projectLinkSchema = z
  .object({
    id: z.string().min(1).max(200).regex(SAFE_ID_PATTERN, 'Invalid project ID')
  })
  .strict();

/**
 * The projects the app answers from. Only the ID: the project's own knowledge
 * mode applies, and a personal app never writes into a project. The ceiling decides
 * whether the owner and the person chatting may use each one.
 */
const projectsSchema = z
  .array(projectLinkSchema)
  .max(L.projects)
  .superRefine(uniqueIds)
  .nullish()
  .transform(value => (value && value.length > 0 ? value : undefined));

/** The schema of every key inside `capabilities`, by key (see `userAppFieldSchemas`). */
export const userAppCapabilitySchemas = {
  upload: z.boolean().prefault(false),
  webSearch: z.boolean().prefault(false),
  skills: z.boolean().prefault(false),
  integrations: z
    .array(integrationBindingSchema)
    .max(L.integrations)
    .superRefine(uniqueIds)
    .prefault([]),
  models: modelsSchema,
  webSearchSettings: webSearchSettingsSchema,
  projects: projectsSchema
};

const capabilitiesSchema = z.object(userAppCapabilitySchemas).strict().transform(compact);

/** Remove the keys that are `undefined`, so a stored content has only what is set. */
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * The greeting of the empty chat: a title and a subtitle per language. An
 * object without a language is the same as no value.
 */
const greetingSchema = z
  .record(
    languageCode,
    z
      .object({
        title: text(L.greetingTitle, { allowEmpty: false }),
        subtitle: text(L.greetingSubtitle, { allowEmpty: false })
      })
      .strict()
  )
  .refine(value => Object.keys(value).length <= L.languages, {
    message: `At most ${L.languages} languages`
  })
  .nullish()
  .transform(value => (value && Object.keys(value).length > 0 ? value : undefined));

/** The input line: single or multi line and its rows. The microphone is not the author's. */
const inputModeSchema = z
  .object({
    type: z.enum(USER_APP_INPUT_MODE_TYPES).optional(),
    rows: z.number().int().min(1).max(L.inputRows).optional()
  })
  .strict()
  .nullish()
  .transform(value =>
    value && Object.keys(compact(value)).length > 0 ? compact(value) : undefined
  );

const outputFormatSchema = z
  .enum(USER_APP_OUTPUT_FORMATS)
  .nullish()
  .transform(value => value || undefined);

const startFormSchema = z
  .object({
    enabled: z.boolean(),
    submitLabel: optionalLocalized(L.submitLabel)
  })
  .strict()
  .nullish()
  .transform(value => (value ? compact(value) : undefined));

const variablesPanelSchema = z
  .object({ pinned: z.boolean() })
  .strict()
  .nullish()
  .transform(value => value || undefined);

/** `autoStart` is stored only when it is on; off is the same as absent. */
const autoStartSchema = z
  .boolean()
  .nullish()
  .transform(value => (value === true ? true : undefined));

/**
 * The schema of every top-level content key, by key. The builder validates a
 * single proposed value with the entry of its key (`services/appSettingsProposal.js`),
 * so a value it accepts is one a save accepts.
 */
export const userAppFieldSchemas = {
  name: localized(L.name),
  description: localized(L.description),
  system: localized(L.system),
  icon: z.string().regex(USER_APP_ICON_PATTERN, 'Invalid icon name').prefault(DEFAULT_APP_ICON),
  color: z
    .string()
    .regex(USER_APP_COLOR_PATTERN, 'Color must be a valid hex code (e.g., #4F46E5)')
    .prefault(DEFAULT_APP_COLOR),
  prompt: optionalLocalized(L.prompt),
  messagePlaceholder: optionalLocalized(L.messagePlaceholder),
  variables: z.array(variableSchema).max(L.variables).prefault([]),
  starterPrompts: z.array(starterPromptSchema).max(L.starterPrompts).prefault([]),
  greeting: greetingSchema,
  inputMode: inputModeSchema,
  preferredOutputFormat: outputFormatSchema,
  startForm: startFormSchema,
  variablesPanel: variablesPanelSchema,
  autoStart: autoStartSchema,
  // Whether the model exists and may be used is the ceiling's to say.
  preferredModel: z
    .string()
    .min(1)
    .max(200)
    .regex(SAFE_ID_PATTERN, 'Invalid model ID')
    .nullish()
    .transform(value => value || undefined),
  capabilities: capabilitiesSchema.prefault({})
};

/**
 * The content of a personal app (`content` in the stored record, section
 * 4.4). The parsed value always has `icon`, `color`, `variables`,
 * `starterPrompts` and a complete `capabilities`; `prompt`,
 * `messagePlaceholder` and `preferredModel` are absent when not set.
 */
export const userAppContentSchema = z
  .object(userAppFieldSchemas)
  .strict()
  .superRefine((content, ctx) => {
    // A locked model is the preferred one, and the preferred one is on the list when
    // there is a list: otherwise the app would ask for a model it forbids itself.
    const models = content.capabilities?.models;
    if (models?.lock === true && !content.preferredModel) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'models', 'lock'],
        message: 'Locking the model needs a preferred model'
      });
    }
    if (
      content.preferredModel &&
      Array.isArray(models?.allowed) &&
      !models.allowed.includes(content.preferredModel)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferredModel'],
        message: 'The preferred model must be one of the allowed models'
      });
    }
  })
  .transform(compact);

/**
 * The body of `POST /api/apps`: the content keys at the top level, plus
 * `language` (the content language; defaults to the first language of
 * `name`) and `origin`.
 *
 * Parsed, it is `{ language, origin, content }`.
 */
export const userAppCreateSchema = z
  .object({
    ...userAppFieldSchemas,
    language: languageCode.optional(),
    origin: z.enum(USER_APP_ORIGINS).prefault('blank')
  })
  .strict()
  .transform(({ language, origin, ...content }) => ({
    language: language || Object.keys(content.name)[0],
    origin,
    content: compact(content)
  }));

/**
 * The body of `PATCH /api/apps/{appId}`: a JSON Merge Patch over the content
 * keys. Only the key names are checked here; the merged content is checked by
 * {@link mergeUserAppContent}.
 */
export const userAppPatchSchema = z
  .object(
    Object.fromEntries(Object.keys(userAppFieldSchemas).map(key => [key, z.unknown().optional()]))
  )
  .strict()
  .refine(patch => Object.keys(patch).length > 0, { message: 'Nothing to change' });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** RFC 7396: objects merge key by key, `null` removes a key, everything else replaces. */
function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch;
  const result = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/**
 * The content after a merge patch, validated as a whole.
 *
 * @param {Object} content - The stored content.
 * @param {Object} patch - The body of the `PATCH`.
 * @returns {Object} The new content, as {@link userAppContentSchema} parses it.
 * @throws {import('zod').ZodError} When the patch names an unknown key or the
 *   merged content breaks a rule; the error handler answers 400
 *   `VALIDATION_FAILED`.
 *
 * @example
 * mergeUserAppContent(stored, { name: { en: 'New name' }, prompt: null });
 */
export function mergeUserAppContent(content, patch) {
  const checked = userAppPatchSchema.parse(patch || {});
  return userAppContentSchema.parse(mergePatch(content || {}, checked));
}

/** One member of the body of `PUT /api/apps/{appId}/members`. */
const userAppMemberSchema = z
  .object({
    type: z.enum(USER_APP_MEMBER_TYPES),
    id: z.string().trim().min(1).max(200).nullable().optional(),
    name: z.string().max(300).optional(),
    role: z.enum(USER_APP_MEMBER_ROLES).prefault('user')
  })
  .strict()
  .refine(member => member.type === 'everyone' || Boolean(member.id), {
    message: 'A user or a group needs an id',
    path: ['id']
  });

/** The body of `PUT /api/apps/{appId}/members`: the list that replaces the stored one. */
export const userAppMembersSchema = z
  .object({
    members: z.array(userAppMemberSchema).max(L.members, `At most ${L.members} members`)
  })
  .strict();

/** The body of `PUT /api/apps/{appId}/owner-offer`. */
export const userAppOwnerOfferSchema = z
  .object({ ownerId: z.string().trim().min(1).max(200) })
  .strict();

/** One installation personal apps may bind, with the actions an admin allows. */
const allowedInstallationSchema = z
  .object({
    id: installationId,
    actions: z
      .array(actionName)
      .min(1, 'Name the actions personal apps may bind')
      .max(500)
      .transform(actions => [...new Set(actions)])
  })
  .strict();

/**
 * The body of `PUT /api/admin/user-apps/_settings`: the block
 * `platform.userApps`, every key optional, no unknown key. The installation
 * `ihub` and an entry without actions are refused.
 */
export const userAppSettingsSchema = z
  .object({
    limits: z
      .object({
        maxAppsPerUser: z.number().int().min(0).max(100_000),
        maxOpenOffersPerUser: z.number().int().min(1).max(1000),
        ownerSnapshotMaxAgeDays: z.number().int().min(0).max(3650)
      })
      .partial()
      .strict()
      .optional(),
    sharing: z
      .object({
        allowUsers: z.boolean(),
        allowGroups: z.boolean(),
        allowEveryone: z.boolean(),
        allowPublish: z.boolean()
      })
      .partial()
      .strict()
      .optional(),
    capabilities: z
      .object({
        modelChoice: z.boolean(),
        upload: z.boolean(),
        webSearch: z.boolean(),
        skills: z.boolean(),
        projects: z.boolean(),
        integrations: z.array(allowedInstallationSchema).max(200).superRefine(uniqueIds),
        webSearchLimits: z
          .object({
            maxPageReads: z.number().int().min(1).max(L.pageReads)
          })
          .partial()
          .strict()
      })
      .partial()
      .strict()
      .optional(),
    publishing: z
      .object({ adminEnables: z.enum(ADMIN_ENABLES_VALUES) })
      .partial()
      .strict()
      .optional(),
    blockedOwners: z
      .array(z.string().trim().min(1).max(200))
      .max(10_000)
      .transform(ids => [...new Set(ids)])
      .optional()
  })
  .strict();
