// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Shared types of the knowledge contract.
 *
 * @module services/knowledge/types
 */

/**
 * An error a knowledge call answers with. The codes are those of spec 1
 * §5.4 plus `NOT_SUPPORTED` (a capability the provider lacks),
 * `ITEM_NOT_READY` and `TEXT_UNAVAILABLE`.
 */
export class KnowledgeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{projectId?: string, itemId?: string}} [where]
   */
  constructor(code, message, where = {}) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    if (where.projectId) this.projectId = where.projectId;
    if (where.itemId) this.itemId = where.itemId;
  }
}

/**
 * The `KnowledgeDoc` view of a stored item.
 *
 * @param {Object} project
 * @param {Object} item
 * @returns {import('./KnowledgeProvider.js').KnowledgeDoc}
 */
export function docOf(project, item) {
  return {
    id: item.id,
    projectId: project.id,
    kind: item.kind,
    name: item.name,
    status: item.status,
    pinned: item.pinned === true,
    chars: Number.isFinite(item.text?.chars) ? item.text.chars : null,
    tokens: Number.isFinite(item.text?.tokens) ? item.text.tokens : null,
    url: item.provenance?.source?.url || item.ref?.url || item.ref?.webUrl || null,
    provenance: item.provenance || { origin: 'linked' },
    snapshotAt: item.snapshotAt || null,
    updatedAt: item.updatedAt || item.createdAt || null
  };
}

/** Whether an item can be read right now. */
export function isUsable(item) {
  return item?.status === 'ready' || item?.status === 'stale';
}
