// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { isHttpUrl, zSafeId } from './common.js';
import { SAFE_ID_PATTERN, isValidId } from '../utils/pathSecurity.js';
import { MAX_ITEM_DESCRIPTION_CHARS, MAX_ITEM_TITLE_CHARS } from '../services/projects/itemInfo.js';
import {
  KNOWLEDGE_MODES,
  MAX_CACHE_HEAP_SHARE,
  MAX_FILES_CEILING,
  MAX_INDEX_CACHE_ENTRIES,
  MIN_CACHE_HEAP_SHARE,
  MAX_ATTACHED_PROJECTS,
  MAX_ITEM_TEXT_CHARS,
  MAX_MEMBERS,
  MEMBER_ROLES,
  MEMBER_TARGET_TYPES,
  IFINDER_PROJECT_ID_PREFIX,
  PROJECT_TIERS
} from '../services/projects/projectConstants.js';
import {
  MAX_FETCH_CONCURRENCY,
  MAX_REFRESH_WAIT_SECONDS,
  zRefreshMode,
  zRefreshTtl
} from '../services/projects/refreshTtl.js';

/** One of the knowledge modes (`shared/knowledgeModes.js`). */
export const knowledgeModeSchema = z.enum(KNOWLEDGE_MODES);

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

/**
 * An item id as the item routes accept it (`isValidId`, the predicate behind
 * `assertValidId`) and as the blob keys need it (no `__`, the separator
 * of `<project>__<item>__<version>`).
 */
const itemIdSchema = zSafeId
  .min(1)
  .max(100)
  .refine(id => isValidId(id) && !id.includes('__'), 'Invalid item id');

/**
 * Admin project ids that would shadow a static endpoint of the project
 * routes (`/api/projects/_config`, `/api/admin/projects/_stats`, ...).
 * Compared case-insensitively, as the routes match them.
 */
export const RESERVED_ADMIN_PROJECT_IDS = Object.freeze([
  '_catalog',
  '_config',
  '_kinds',
  '_settings',
  '_stats',
  '_tokens',
  'share-targets'
]);

/**
 * Whether an id is one of {@link RESERVED_ADMIN_PROJECT_IDS} or starts with the
 * prefix of an iFinder collection's project id (`ifc_`), whatever its case: the
 * two namespaces must never collide.
 */
export function isReservedAdminProjectId(id) {
  const lower = String(id).toLowerCase();
  return RESERVED_ADMIN_PROJECT_IDS.includes(lower) || lower.startsWith(IFINDER_PROJECT_ID_PREFIX);
}

/**
 * An admin project id: path-safe, not a user id, free of the blob separator
 * and not the name of a static endpoint.
 */
const adminProjectIdSchema = zSafeId
  .min(1)
  .max(50)
  .refine(id => !id.includes('__') && !isReservedAdminProjectId(id), 'Invalid project id');

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
    id: itemIdSchema,
    kind: zSafeId.min(1).max(50),
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH),
    /** The document's own title and a short description, captured at ingest or first read. */
    title: z.string().max(MAX_ITEM_TITLE_CHARS).nullable().optional(),
    description: z.string().max(MAX_ITEM_DESCRIPTION_CHARS).nullable().optional(),
    ref: z.record(z.string(), z.unknown()).prefault({}),
    storage: z.enum(ITEM_STORAGE),
    pinned: z.boolean().prefault(false),
    /** "Not for AI": the item stays for people, never reaches the model. Never set with `pinned`. */
    excludedFromAi: z.boolean().optional(),
    status: z.enum(ITEM_STATUSES).prefault('pending'),
    error: z
      .object({ code: z.string().max(64), message: z.string().max(2000) })
      .strict()
      .nullable()
      .optional(),
    text: itemTextSchema.nullable().optional(),
    cache: z.object({ ttlSeconds: z.number().int().positive() }).strict().optional(),
    /** The item's own refresh TTL (#3536); absent takes the project's. */
    refreshTtl: zRefreshTtl.optional(),
    // When an outdated snapshot is refreshed: in the background or on use (#3622).
    refreshMode: zRefreshMode.optional(),
    /** When the source of a fetched or live item was last checked. */
    checkedAt: z.string().nullable().optional(),
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
    id: adminProjectIdSchema,
    ownership: z.literal('admin').prefault('admin'),
    // Set by a delete that could not finish its chat cascade: the project
    // refuses every other write until the delete is retried.
    deleting: z.boolean().optional(),
    tier: z.enum(PROJECT_TIERS).prefault('ihub'),
    name: localized(MAX_NAME_LENGTH),
    description: localized(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).prefault(''),
    enabled: z.boolean().prefault(true),
    // Published: everyone signed in may use it and link its documents into
    // their own projects, not only the apps, workflows and agents linking it.
    published: z.boolean().optional(),
    category: z.string().max(100).optional(),
    tags: z.array(z.string().max(100)).prefault([]),
    // The app new chats start in; users who open the project get it preselected.
    defaultAppId: zSafeId.min(1).max(100).nullable().optional(),
    // How the project reaches the model unless a chat or a link says otherwise (#3538).
    knowledgeMode: knowledgeModeSchema.optional(),
    // How long its files from websites and web pages are current (#3536).
    refreshTtl: zRefreshTtl.optional(),
    // When an outdated snapshot is refreshed: in the background or on use (#3622).
    refreshMode: zRefreshMode.optional(),
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

/**
 * An item in `POST /api/admin/projects`: what an admin may say about it. The
 * rest (`storage`, `status`, `text`, `provenance`, …) is the server's, derived
 * from the kind when the project is created, never taken from the request.
 */
export const adminItemCreateSchema = z
  .object({
    id: itemIdSchema.optional(),
    kind: zSafeId.min(1).max(50),
    ref: z.record(z.string(), z.unknown()).prefault({}),
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH).optional(),
    pinned: z.boolean().prefault(false),
    excludedFromAi: z.boolean().optional(),
    cache: z.object({ ttlSeconds: z.number().int().positive() }).strict().optional()
  })
  .strict();

/** What `POST /api/admin/projects` accepts: the stored document minus everything the server owns. */
export const adminProjectCreateSchema = z
  .object({
    version: z.number().int().positive().optional(),
    // `new` is the route of the admin create form. Only a new project is refused
    // it: one that already has the id must keep loading.
    id: adminProjectIdSchema.refine(
      id => id.toLowerCase() !== 'new',
      'The id "new" is reserved for the create form'
    ),
    tier: z.enum(PROJECT_TIERS).prefault('ihub'),
    name: localized(MAX_NAME_LENGTH),
    description: localized(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).prefault(''),
    enabled: z.boolean().prefault(true),
    // Published: everyone signed in may use it and link its documents into
    // their own projects, not only the apps, workflows and agents linking it.
    published: z.boolean().optional(),
    category: z.string().max(100).optional(),
    tags: z.array(z.string().max(100)).prefault([]),
    defaultAppId: zSafeId.min(1).max(100).optional(),
    knowledgeMode: knowledgeModeSchema.optional(),
    items: z.array(adminItemCreateSchema).max(MAX_FILES_CEILING).prefault([])
  })
  .strict()
  .refine(
    project =>
      new Set(project.items.filter(item => item.id).map(item => item.id)).size ===
      project.items.filter(item => item.id).length,
    'Item ids must be unique within a project'
  );

/** What `POST /api/projects` accepts. */
export const userProjectCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(MAX_NAME_LENGTH, 'Name is too long'),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
    defaultAppId: zSafeId.min(1).max(100).optional(),
    knowledgeMode: knowledgeModeSchema.optional(),
    /** `ifinder` creates a smart collection in iFinder and its stub; omitted is `ihub`. */
    tier: z.enum(['ihub', 'ifinder']).optional()
  })
  .strict();

/**
 * `POST /api/projects/_collections`: add one of the caller's iFinder smart
 * collections to their projects, with the default app and the instructions its
 * stub keeps. The name comes from the collection.
 */
export const collectionImportSchema = z
  .object({
    collectionId: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
    defaultAppId: zSafeId.min(1).max(100).optional()
  })
  .strict();

/**
 * What `PATCH /api/projects/:id` accepts for a smart collection of the iFinder
 * tier that has no stub (`ifc_…`): its name and description. Nothing else is
 * ever sent to iFinder; a stub takes {@link userProjectUpdateSchema}.
 */
export const ifinderProjectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional()
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, 'Nothing to change');

/** What `PATCH /api/projects/:id` accepts. `defaultAppId: null` clears the default app. */
export const userProjectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
    defaultAppId: zSafeId.min(1).max(100).nullable().optional(),
    // How the project reaches the model; null goes back to `auto` (#3538).
    knowledgeMode: knowledgeModeSchema.nullable().optional(),
    // Seconds or 'never'; null goes back to the platform's (#3536).
    refreshTtl: zRefreshTtl.nullable().optional(),
    // `auto` or `onDemand`; null goes back to the platform's (#3622).
    refreshMode: zRefreshMode.nullable().optional()
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
    published: z.boolean().optional(),
    category: z.string().max(100).optional(),
    tags: z.array(z.string().max(100)).optional(),
    defaultAppId: zSafeId.min(1).max(100).nullable().optional(),
    knowledgeMode: knowledgeModeSchema.nullable().optional(),
    refreshTtl: zRefreshTtl.nullable().optional(),
    // `auto` or `onDemand`; null goes back to the platform's (#3622).
    refreshMode: zRefreshMode.nullable().optional()
  })
  .strict();

/** What `POST /api/projects/:id/items` accepts as JSON (every kind but `upload`). */
export const addItemSchema = z
  .object({
    kind: z.string().trim().min(1).max(50).regex(SAFE_ID_PATTERN, 'Invalid kind'),
    ref: z.record(z.string(), z.unknown()).prefault({}),
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH).optional(),
    pinned: z.boolean().optional(),
    excludedFromAi: z.boolean().optional(),
    text: z.string().max(MAX_ITEM_TEXT_CHARS).optional(),
    // The site crawl that listed a web page (`POST …/pickers/url/_crawl`): the
    // page it read is stored instead of being fetched again (#3622).
    crawlId: z
      .string()
      .regex(/^[0-9a-z]{9}[0-9a-f]{8}$/, 'Invalid crawlId')
      .optional()
  })
  .strict();

/**
 * What `POST /api/projects/:id/items` accepts for a smart collection of the
 * iFinder tier when it adds several documents at once: `{ items: [...] }`, each
 * one a JSON item of kind `ifinder-document`. One document is the plain
 * {@link addItemSchema} body.
 */
export const ifinderAddItemsSchema = z
  .object({
    items: z.array(addItemSchema).min(1).max(MAX_FILES_CEILING)
  })
  .strict();

/**
 * What `PATCH /api/projects/:id/items/:itemId` accepts. `ref` replaces the
 * reference of a link item (a URL, a page, an iFinder document or search); the
 * server checks it against the item's own kind, which cannot change.
 */
export const itemUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_ITEM_NAME_LENGTH).optional(),
    pinned: z.boolean().optional(),
    // "Not for AI" (#3538): never injected, listed or searched. It excludes `pinned`.
    excludedFromAi: z.boolean().optional(),
    ref: z.record(z.string(), z.unknown()).optional(),
    // A file from a website or a web page: its own refresh TTL, null for the project's.
    refreshTtl: zRefreshTtl.nullable().optional(),
    // Its own refresh mode, null for the project's (#3622).
    refreshMode: zRefreshMode.nullable().optional()
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, 'Nothing to change');

/** What `POST /api/admin/projects/_move` and `_copy` accept. */
export const itemTransferSchema = z
  .object({
    sourceId: zSafeId.min(1).max(100),
    targetId: zSafeId.min(1).max(100),
    itemIds: z.array(zSafeId.min(1).max(100)).min(1).max(MAX_FILES_CEILING)
  })
  .strict();

/** What `POST /api/admin/projects/_merge` accepts. */
export const projectMergeSchema = z
  .object({
    sourceIds: z.array(zSafeId.min(1).max(50)).min(1).max(100),
    targetId: zSafeId.min(1).max(50),
    deleteSources: z.boolean().prefault(false)
  })
  .strict();

/** What `PUT /api/projects/:id/items/:itemId/text` accepts. */
export const itemTextUpdateSchema = z
  .object({
    text: z
      .string()
      .max(MAX_ITEM_TEXT_CHARS)
      .refine(value => value.trim().length > 0, 'The text is empty')
  })
  .strict();

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

/** What `PATCH /api/chats/:id` accepts to set the projects attached to a chat. */
export const attachedProjectsSchema = z
  .object({ attachedProjectIds: z.array(zSafeId.min(1).max(100)).max(MAX_ATTACHED_PROJECTS) })
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
      // Absent: the project's own default applies (#3538).
      mode: knowledgeModeSchema.optional(),
      write: z.boolean().prefault(false)
    })
    .strict()
]);

export const projectLinksSchema = z.array(projectLinkSchema);

/**
 * A link as an object, whatever shape the config used. `mode` is null when the
 * link sets none: the project's own default then applies, which an explicit
 * `auto` does not leave to it.
 *
 * @param {string|{id: string, mode?: string, write?: boolean}} link
 * @returns {{id: string, mode: string|null, write: boolean}}
 */
export function normalizeProjectLink(link) {
  if (typeof link === 'string') return { id: link, mode: null, write: false };
  return {
    id: String(link?.id || ''),
    mode: KNOWLEDGE_MODES.includes(link?.mode) ? link.mode : null,
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

/** Body of `POST /api/projects/pickers/url/_check`. */
export const urlCheckSchema = z
  .object({
    url: z.string().trim().max(2048).refine(isHttpUrl, 'Only http(s) URLs are allowed')
  })
  .strict();

/** Body of `POST /api/projects/pickers/url/preview`. */
export const urlPreviewSchema = urlCheckSchema;

/**
 * Body of `POST /api/projects/pickers/url/_crawl`. The bounds are the crawler's
 * (`CRAWL_MAX_PAGES`, `CRAWL_MAX_DEPTH` in `services/projects/siteCrawler.js`),
 * which clamps again.
 */
export const urlCrawlSchema = z
  .object({
    url: z.string().trim().max(2048).refine(isHttpUrl, 'Only http(s) URLs are allowed'),
    maxPages: z.number().int().min(1).max(200).optional(),
    maxDepth: z.number().int().min(0).max(3).optional(),
    samePath: z.boolean().optional(),
    // Also list documents on other hosts that pages in scope link to (#3536).
    otherHostDocuments: z.boolean().optional()
  })
  .strict();

/**
 * What `PUT /api/admin/projects/_settings` accepts: the sharing audiences, the
 * tier policy, the default app and the limits of the local tier. Each limit
 * is optional; `maxProjectsPerUser` of 0 means no cap.
 */
export const projectSharingSettingsSchema = z
  .object({
    sharing: z
      .object({
        allowUsers: z.boolean(),
        allowGroups: z.boolean(),
        allowEveryone: z.boolean(),
        allowCatalog: z.boolean()
      })
      .partial()
      .strict()
      .optional(),
    tierPolicy: z.enum(['ihub', 'both', 'ifinder']).optional(),
    // The app a project chat starts in when the project names none; '' clears it.
    defaultAppId: z.union([zSafeId.min(1).max(100), z.literal('')]).optional(),
    limits: z
      .object({
        maxFiles: z.number().int().min(1).max(MAX_FILES_CEILING),
        maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        maxProjectBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        maxProjectsPerUser: z.number().int().min(0).max(100_000)
      })
      .partial()
      .strict()
      .optional(),
    // How long files from websites and web pages are current (#3536).
    refreshTtl: zRefreshTtl.optional(),
    // When outdated snapshots are refreshed, and after how many idle days an
    // `auto` project is refreshed only when used (0: never idle) (#3622).
    refreshMode: zRefreshMode.optional(),
    refreshIdleDays: z.number().int().min(0).max(3650).optional(),
    // How long a reader waits for outdated documents before it reads them
    // (0: not at all), and the checks at once per server process (#3622).
    refreshWaitSeconds: z.number().int().min(0).max(MAX_REFRESH_WAIT_SECONDS).optional(),
    ingest: z
      .object({
        fetchConcurrency: z.number().int().min(1).max(MAX_FETCH_CONCURRENCY)
      })
      .partial()
      .strict()
      .optional(),
    // The knowledge modes users may choose (#3538); `auto` is always offered.
    knowledgeModes: z.array(knowledgeModeSchema).min(1).max(KNOWLEDGE_MODES.length).optional(),
    // Per-process caches (#3650). `maxHeapShare: null` goes back to the built-in budget.
    indexCache: z
      .object({
        maxEntries: z.number().int().min(1).max(MAX_INDEX_CACHE_ENTRIES),
        maxHeapShare: z.number().min(MIN_CACHE_HEAP_SHARE).max(MAX_CACHE_HEAP_SHARE).nullable()
      })
      .partial()
      .strict()
      .optional(),
    textCache: z
      .object({
        maxHeapShare: z.number().min(MIN_CACHE_HEAP_SHARE).max(MAX_CACHE_HEAP_SHARE).nullable()
      })
      .partial()
      .strict()
      .optional()
  })
  .strict()
  .refine(
    body =>
      body.sharing !== undefined ||
      body.tierPolicy !== undefined ||
      body.defaultAppId !== undefined ||
      body.limits !== undefined ||
      body.refreshTtl !== undefined ||
      body.refreshMode !== undefined ||
      body.refreshIdleDays !== undefined ||
      body.refreshWaitSeconds !== undefined ||
      body.ingest !== undefined ||
      body.indexCache !== undefined ||
      body.textCache !== undefined ||
      body.knowledgeModes !== undefined,
    {
      message:
        'Send sharing, tierPolicy, defaultAppId, limits, refreshTtl, refreshMode, refreshIdleDays, refreshWaitSeconds, ingest, indexCache, textCache or knowledgeModes'
    }
  );
