// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The client view of a project — what `/api/projects` and the admin pages
 * send for one. The wrapped data key of an item never leaves the server;
 * members are listed only to those who may change them (and to admins).
 *
 * @module services/projects/projectView
 */
import { getLocalizedContent } from '../../../shared/localize.js';

function memberView(member) {
  return {
    type: member.type,
    id: member.type === 'everyone' ? null : member.id,
    ...(member.name ? { name: member.name } : {}),
    role: member.role
  };
}

/**
 * One item as the client sees it.
 *
 * @param {Object} item - Stored item.
 * @returns {Object}
 */
export function serializeItem(item) {
  // `ingestAttempt` is the server's fencing token of a running ingest job.
  const { text, ingestAttempt: _attempt, ...rest } = item;
  return {
    ...rest,
    ref: item.ref || {},
    text: text
      ? {
          chars: text.chars,
          tokens: text.tokens,
          bytes: text.bytes,
          sha256: text.sha256,
          extractedAt: text.extractedAt,
          truncated: text.truncated === true,
          original: text.original || null
        }
      : null
  };
}

/**
 * The display name of a project in one language (admin projects are
 * localized records, user projects plain strings).
 *
 * @param {Object} project
 * @param {string} [language]
 * @returns {string}
 */
export function projectName(project, language = 'en') {
  if (typeof project?.name === 'string') return project.name;
  return getLocalizedContent(project?.name, language) || project?.id || '';
}

/** Longest description a prompt or a tool description carries. */
const PROMPT_DESCRIPTION_LENGTH = 600;

/**
 * What a project holds, in one language, on one line and short enough for a
 * prompt: the model reads it to decide whether a project can answer a
 * question (the iHub Documentation says it also holds every release's notes).
 *
 * @param {Object} project
 * @param {string} [language]
 * @param {number} [maxLength]
 * @returns {string} Empty when the project has no description.
 */
export function projectDescription(
  project,
  language = 'en',
  maxLength = PROMPT_DESCRIPTION_LENGTH
) {
  const raw =
    typeof project?.description === 'string'
      ? project.description
      : getLocalizedContent(project?.description, language) || '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  // Cut by code point: a UTF-16 cut inside an emoji leaves a lone surrogate
  // that a provider may refuse, and with it every chat that has the project.
  const points = Array.from(text);
  return points.length > maxLength
    ? `${points
        .slice(0, maxLength - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/**
 * One project as the client sees it.
 *
 * @param {Object} project - Stored project.
 * @param {ReturnType<import('./projectAccess.js').projectPermissions>} permissions
 * @param {Object} [options]
 * @param {boolean} [options.includeItems=true]
 * @param {boolean} [options.adminView=false] - Members and owner id always included.
 * @param {boolean} [options.ownerActive=true]
 * @param {boolean} [options.catalogOn=true] - The catalog is on: a published project shows as one.
 * @returns {Object}
 */
export function serializeProject(
  project,
  permissions,
  { includeItems = true, adminView = false, ownerActive = true, catalogOn = true } = {}
) {
  const members = Array.isArray(project.members) ? project.members : [];
  const showMembers = adminView || permissions.canShare;
  const items = Array.isArray(project.items) ? project.items : [];
  return {
    id: project.id,
    ownership: project.ownership,
    tier: project.tier || 'ihub',
    name: project.name,
    description: project.description || '',
    instructions: project.instructions || '',
    ...(project.ownership === 'admin'
      ? {
          enabled: project.enabled !== false,
          published: project.published === true,
          category: project.category || '',
          tags: project.tags || []
        }
      : { defaultAppId: project.defaultAppId || null }),
    owner: project.owner
      ? {
          name: project.owner.name || '',
          active: ownerActive !== false,
          ...(adminView || permissions.isOwner ? { id: project.owner.id } : {})
        }
      : null,
    ...(showMembers ? { members: members.map(memberView) } : { memberCount: members.length }),
    usage: project.usage || { items: items.length, bytes: 0 },
    ...(includeItems ? { items: items.map(serializeItem) } : {}),
    createdAt: project.createdAt,
    createdBy: project.createdBy?.name || project.owner?.name || '',
    updatedAt: project.updatedAt,
    updatedBy: project.updatedBy?.name || '',
    lastActivityAt: project.lastActivityAt || project.updatedAt,
    ...(project.ownership === 'admin'
      ? {}
      : {
          // Who the project reaches beyond its named members, for the
          // "Global" and "Published" badges every viewer sees.
          audience: {
            everyone: members.some(member => member.type === 'everyone'),
            catalog: catalogOn && Boolean(project.catalog?.publishedAt)
          },
          catalog: project.catalog?.publishedAt
            ? {
                publishedAt: project.catalog.publishedAt,
                publishedBy: project.catalog.publishedBy?.name || ''
              }
            : null
        }),
    role: permissions.role,
    permissions: {
      canUse: permissions.canUse,
      canEdit: permissions.canEdit,
      canShare: permissions.canShare,
      canDelete: permissions.canDelete,
      canTransfer: permissions.canTransfer,
      readsAllChats: permissions.readsAllChats !== false,
      canHoldChats: permissions.canHoldChats !== false,
      isOwner: permissions.isOwner,
      readOnly: permissions.readOnly
    }
  };
}
