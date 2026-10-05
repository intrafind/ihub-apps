/**
 * The client view of a user skill — what `/api/user-skills` and the admin list
 * send for one. Shaped like the user prompt view (`userPromptView.js`).
 *
 * @module services/skills/userSkillView
 */

function shareView(share) {
  return {
    type: share.type,
    id: share.type === 'everyone' ? null : share.id,
    ...(share.name ? { name: share.name } : {}),
    permission: share.permission
  };
}

/** Bytes of a skill's instructions plus its files, as stored. */
export function skillSize(skill) {
  const files = Array.isArray(skill?.files) ? skill.files : [];
  return (
    Buffer.byteLength(String(skill?.body || ''), 'utf8') +
    files.reduce((sum, file) => sum + Buffer.byteLength(String(file?.content || ''), 'utf8'), 0)
  );
}

/**
 * The client view of one user skill.
 *
 * Recipients learn who owns a skill by name, not by id, and see the share
 * list only when they may change it. The instructions and files come only
 * with `includeContent` — the list endpoints leave them out.
 *
 * @param {Object} skill - Stored skill.
 * @param {Object} permissions - From `userPromptPermissions` (the policy is shared).
 * @param {Object} [options]
 * @param {boolean} [options.ownerActive=true]
 * @param {boolean} [options.adminView=false] - Admin listing: owner id and shares always included.
 * @param {boolean} [options.includeContent=false] - Include `body` and `files`.
 * @returns {Object}
 */
export function serializeUserSkill(
  skill,
  permissions,
  { ownerActive = true, adminView = false, includeContent = false } = {}
) {
  const shares = Array.isArray(skill.shares) ? skill.shares : [];
  const files = Array.isArray(skill.files) ? skill.files : [];
  const showShares = adminView || permissions.canShare;
  return {
    id: skill.id,
    scope: permissions.isOwner ? 'mine' : 'shared',
    name: skill.name,
    description: skill.description || '',
    owner: {
      name: skill.ownerName || '',
      active: ownerActive !== false,
      ...(adminView || permissions.isOwner ? { id: skill.ownerId } : {})
    },
    revision: skill.revision || 1,
    createdAt: skill.createdAt,
    createdBy: skill.createdBy?.name || skill.ownerName || '',
    updatedAt: skill.updatedAt,
    updatedBy: skill.updatedBy?.name || '',
    access: permissions.access,
    shared: shares.length > 0,
    ...(showShares ? { shares: shares.map(shareView) } : {}),
    readOnly: permissions.readOnly,
    copiedFrom: skill.copiedFrom || null,
    ...(adminView || permissions.isOwner ? { promotedTo: skill.promotedTo || null } : {}),
    fileCount: files.length,
    size: skillSize(skill),
    permissions: {
      canEdit: permissions.canEdit,
      canShare: permissions.canShare,
      canDelete: permissions.canDelete,
      canTransfer: permissions.canTransfer,
      canDuplicate: permissions.canDuplicate
    },
    ...(includeContent
      ? {
          body: skill.body || '',
          files: files.map(file => ({ path: file.path, content: file.content }))
        }
      : {})
  };
}
