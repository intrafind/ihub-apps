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
  const { text, ...rest } = item;
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

/**
 * One project as the client sees it.
 *
 * @param {Object} project - Stored project.
 * @param {ReturnType<import('./projectAccess.js').projectPermissions>} permissions
 * @param {Object} [options]
 * @param {boolean} [options.includeItems=true]
 * @param {boolean} [options.adminView=false] - Members and owner id always included.
 * @param {boolean} [options.ownerActive=true]
 * @returns {Object}
 */
export function serializeProject(
  project,
  permissions,
  { includeItems = true, adminView = false, ownerActive = true } = {}
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
          category: project.category || '',
          tags: project.tags || []
        }
      : {}),
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
    role: permissions.role,
    permissions: {
      canUse: permissions.canUse,
      canEdit: permissions.canEdit,
      canShare: permissions.canShare,
      canDelete: permissions.canDelete,
      canTransfer: permissions.canTransfer,
      isOwner: permissions.isOwner,
      readOnly: permissions.readOnly
    }
  };
}
