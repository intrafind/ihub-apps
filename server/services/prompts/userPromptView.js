/**
 * The client view of a user prompt — what `/api/prompts` and the admin list
 * send for one.
 *
 * @module services/prompts/userPromptView
 */

function shareView(share) {
  return {
    type: share.type,
    id: share.type === 'everyone' ? null : share.id,
    ...(share.name ? { name: share.name } : {}),
    permission: share.permission
  };
}

/**
 * The client view of one user prompt.
 *
 * Recipients learn who owns a prompt by name, not by id, and see the share
 * list only when they may change it.
 *
 * @param {Object} prompt - Stored prompt.
 * @param {ReturnType<typeof userPromptPermissions>} permissions
 * @param {Object} [options]
 * @param {boolean} [options.ownerActive=true]
 * @param {boolean} [options.adminView=false] - Admin listing: owner id and
 *   shares always included.
 * @returns {Object}
 */
export function serializeUserPrompt(
  prompt,
  permissions,
  { ownerActive = true, adminView = false } = {}
) {
  const shares = Array.isArray(prompt.shares) ? prompt.shares : [];
  const showShares = adminView || permissions.canShare;
  return {
    id: prompt.id,
    scope: permissions.isOwner ? 'mine' : 'shared',
    name: prompt.name,
    description: prompt.description || '',
    prompt: prompt.prompt,
    icon: prompt.icon || null,
    category: prompt.category || null,
    appId: prompt.appId || null,
    variables: Array.isArray(prompt.variables) ? prompt.variables : [],
    owner: {
      name: prompt.ownerName || '',
      active: ownerActive !== false,
      ...(adminView || permissions.isOwner ? { id: prompt.ownerId } : {})
    },
    revision: prompt.revision || 1,
    createdAt: prompt.createdAt,
    createdBy: prompt.createdBy?.name || prompt.ownerName || '',
    updatedAt: prompt.updatedAt,
    updatedBy: prompt.updatedBy?.name || '',
    access: permissions.access,
    shared: shares.length > 0,
    ...(showShares ? { shares: shares.map(shareView) } : {}),
    readOnly: permissions.readOnly,
    copiedFrom: prompt.copiedFrom || null,
    ...(adminView || permissions.isOwner ? { promotedTo: prompt.promotedTo || null } : {}),
    permissions: {
      canEdit: permissions.canEdit,
      canShare: permissions.canShare,
      canDelete: permissions.canDelete,
      canTransfer: permissions.canTransfer,
      canDuplicate: permissions.canDuplicate
    }
  };
}
