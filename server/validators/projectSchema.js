// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { isHttpUrl, zSafeId } from './common.js';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';
import {
  LINK_MODES,
  MAX_FILES_CEILING,
  MAX_MEMBERS,
  MEMBER_ROLES,
  MEMBER_TARGET_TYPES,
  PROJECT_TIERS
} from '../services/projects/projectConstants.js';

/**
 * Schemas of the project model (#1036, spec 1 §2 and §3): the stored
 * project and item documents, and the request bodies of `/api/projects` and
 * `/api/admin/projects`.
 *
 * A user project is written in one language, so its name and description
 * are plain strings. An admin project is configuration shown to every user,
 * so they are localized records, as apps use, on create and on update alike.
 */

const LANGUAGE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/;

const localized = max => z.record(z.string().regex(LANGUAGE_CODE), z.string().max(max));

/**
 * One line per issue, for a 400 message.
 *
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
export function describeIssues(error) {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

/** Longest project name, description and instructions. */
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_INSTRUCTIONS_LENGTH = 20000;
export const MAX_ITEM_NAME_LENGTH = 300;

/** The states an item moves through. */
export const ITEM_STATUSES = Object.freeze(['pending', 'extracting', 'ready', 'failed', 'stale']);

/** Where an item's content comes from. */
export const ITEM_ORIGINS = Object.freeze(['uploaded', 'picked', 'linked', 'written', 'migrated']);

/** How an item's content is held in the iHub tier. */
export const ITEM_STORAGE = Object.freeze(['text', 'link']);

const actorSchema = z
  .object({ id: z.string().max(200), name: z.string().max(300).optional() })
  .passthrough();

const runRefSchema = z
  .object({
    type: z.enum(['chat', 'workflow', 'agent']),
    id: z.string().max(200),
    nodeId: z.string().max(200).optional()
  })
  .strict();

export const itemProvenanceSchema = z
  .object({
    origin: z.enum(ITEM_ORIGINS),
    by: actorSchema.nullable().optional(),
    at: z.string().optional(),
    run: runRefSchema.nullable().optional(),
    source: z
      .object({
        site: z.string().max(300).optional(),
        url: z.string().max(2048).optional(),
        lastModified: z.string().optional()
      })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();

/** The stored text block of a `storage: 'text'` item. The wrapped key never leaves the server. */
export const itemTextSchema = z
  .object({
    blobKey: z.string().min(1).max(200),
    bytes: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    sha256: z.string().max(64),
    format: z.string().max(64),
    segmentBytes: z.number().int().positive().optional(),
    key: z
      .object({
        provider: z.string().max(64),
        keyId: z.string().max(128),
        wrapped: z.string().max(4096)
      })
      .strict(),
    tenant: z.string().max(100).optional(),
    extractedAt: z.string(),
    truncated: z.boolean().optional(),
    original: z
      .object({
        contentType: z.string().max(200).optional(),
        bytes: z.number().int().nonnegative().optional(),
        pages: z.number().int().nonnegative().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

/** A stored project item (spec 1 §3). `ref` is validated by the kind, not here. */
export const projectItemSchema = z
  .object({
    id: zSafeId.min(1).max(100),
    kind: zSafeId.min(1).max(50),
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH),
    ref: z.record(z.string(), z.unknown()).prefault({}),
    storage: z.enum(ITEM_STORAGE),
    pinned: z.boolean().prefault(false),
    status: z.enum(ITEM_STATUSES).prefault('pending'),
    error: z
      .object({ code: z.string().max(64), message: z.string().max(2000) })
      .strict()
      .nullable()
      .optional(),
    text: itemTextSchema.nullable().optional(),
    cache: z.object({ ttlSeconds: z.number().int().positive() }).strict().optional(),
    provenance: itemProvenanceSchema,
    snapshotAt: z.string().nullable().optional(),
    /** Set while a refresh runs; the status keeps the readable snapshot. */
    refreshingAt: z.string().nullable().optional(),
    /** The ingest job (upload, pick, write or refresh) that may record the item's outcome. */
    ingestAttempt: z.string().max(64).optional(),
    import: z
      .object({ file: z.string().max(1024), encoding: z.string().max(32).optional() })
      .strict()
      .optional(),
    managedFile: z.string().max(1024).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional()
  })
  .passthrough();

export const projectMemberSchema = z
  .object({
    type: z.enum(MEMBER_TARGET_TYPES),
    id: z.string().trim().min(1).max(200).nullable().optional(),
    name: z.string().max(300).optional(),
    role: z.enum(MEMBER_ROLES).prefault('user')
  })
  .strict();

/** The admin project document as the admin API accepts it (`contents/projects/<id>.json`). */
export const adminProjectSchema = z
  .object({
    version: z.number().int().positive().prefault(1),
    id: zSafeId.min(1).max(50),
    ownership: z.literal('admin').prefault('admin'),
    tier: z.enum(PROJECT_TIERS).prefault('ihub'),
    name: localized(MAX_NAME_LENGTH),
    description: localized(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).prefault(''),
    enabled: z.boolean().prefault(true),
    category: z.string().max(100).optional(),
    tags: z.array(z.string().max(100)).prefault([]),
    items: z.array(projectItemSchema).max(MAX_FILES_CEILING).prefault([]),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    createdBy: actorSchema.nullable().optional()
  })
  .passthrough()
  .refine(
    project => new Set(project.items.map(item => item.id)).size === project.items.length,
    'Item ids must be unique within a project'
  );

/** What `POST /api/projects` accepts. */
export const userProjectCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(MAX_NAME_LENGTH, 'Name is too long'),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional()
  })
  .strict();

/** What `PATCH /api/projects/:id` accepts. */
export const userProjectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional()
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, 'Nothing to change');

/** What `PATCH /api/admin/projects/:id` accepts beyond the user fields. */
export const adminProjectUpdateSchema = z
  .object({
    name: localized(MAX_NAME_LENGTH).optional(),
    description: localized(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
    enabled: z.boolean().optional(),
    category: z.string().max(100).optional(),
    tags: z.array(z.string().max(100)).optional()
  })
  .strict();

/** What `POST /api/projects/:id/items` accepts as JSON (every kind but `upload`). */
export const addItemSchema = z
  .object({
    kind: z.string().trim().min(1).max(50).regex(SAFE_ID_PATTERN, 'Invalid kind'),
    ref: z.record(z.string(), z.unknown()).prefault({}),
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH).optional(),
    pinned: z.boolean().optional(),
    text: z.string().max(2_000_000).optional()
  })
  .strict();

/** What `PATCH /api/projects/:id/items/:itemId` accepts. */
export const itemUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH).optional(),
    pinned: z.boolean().optional()
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, 'Nothing to change');

/** What `PUT /api/projects/:id/members` accepts. */
export const membersUpdateSchema = z
  .object({ members: z.array(projectMemberSchema).max(MAX_MEMBERS) })
  .strict();

/** What `POST /api/projects/:id/transfer` accepts. */
export const transferSchema = z.object({ ownerId: z.string().trim().min(1).max(200) }).strict();

/** What `POST /api/admin/projects/_toggle` accepts. */
export const toggleSchema = z
  .object({
    ids: z.array(zSafeId.min(1).max(50)).min(1).max(500),
    enabled: z.boolean()
  })
  .strict();

/** The `projectId` field `PATCH /api/chats/:chatId` accepts. */
export const chatProjectSchema = z
  .object({ projectId: zSafeId.min(1).max(100).nullable() })
  .strict();

/**
 * A link on an app, workflow or agent profile to a project (spec 1 §6.1):
 * a bare id, or an object with the access mode and the write flag.
 */
export const projectLinkSchema = z.union([
  zSafeId.min(1).max(100),
  z
    .object({
      id: zSafeId.min(1).max(100),
      mode: z.enum(LINK_MODES).prefault('auto'),
      write: z.boolean().prefault(false)
    })
    .strict()
]);

export const projectLinksSchema = z.array(projectLinkSchema);

/**
 * A link as an object, whatever shape the config used.
 *
 * @param {string|{id: string, mode?: string, write?: boolean}} link
 * @returns {{id: string, mode: 'auto'|'context'|'tools', write: boolean}}
 */
export function normalizeProjectLink(link) {
  if (typeof link === 'string') return { id: link, mode: 'auto', write: false };
  return {
    id: String(link?.id || ''),
    mode: LINK_MODES.includes(link?.mode) ? link.mode : 'auto',
    write: link?.write === true
  };
}

/** Query of `GET /api/projects/pickers/ifinder/search`. */
export const ifinderPickerSchema = z
  .object({
    q: z.string().trim().min(1).max(1000),
    profile: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).prefault(10)
  })
  .passthrough();

/** Body of `POST /api/projects/pickers/url/check`. */
export const urlCheckSchema = z
  .object({
    url: z.string().trim().max(2048).refine(isHttpUrl, 'Only http(s) URLs are allowed')
  })
  .strict();
