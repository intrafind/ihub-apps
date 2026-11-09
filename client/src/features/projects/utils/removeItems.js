// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Removing several items of a project at once, shared by the admin project
 * editor and the user project page.
 *
 * @module features/projects/utils/removeItems
 */

import { projectErrorDetails } from './projectErrors';

/**
 * Whether a failed removal means the item is gone already (another tab or
 * person removed it), which is what the caller asked for.
 *
 * @param {Error} error - Thrown by the API call (axios error or the enhanced error).
 * @returns {boolean}
 */
export const isItemGone = error => projectErrorDetails(error).code === 'ITEM_NOT_FOUND';

/**
 * Remove items one after the other, each through the caller's single-item
 * call, so each is checked and recorded like a single removal. A failure does
 * not stop the rest.
 *
 * @param {Object[]} items
 * @param {(item: Object) => Promise<unknown>} removeOne
 * @param {Object} options
 * @param {(error: Error) => string} options.messageOf - The message of a failure.
 * @param {(item: Object|null) => void} [options.onItem] - The item being removed; `null`
 *   once all are done.
 * @returns {Promise<{removed: Set<string>, failed: string[]}>} The ids that are gone
 *   (removed now or already), and the message of each item that is not.
 */
export async function removeItemsInTurn(items, removeOne, { messageOf, onItem = () => {} }) {
  const removed = new Set();
  const failed = [];
  try {
    for (const item of items) {
      onItem(item);
      try {
        // One at a time on purpose: each removal takes the project's write
        // lock (and writes to iFinder for a smart collection), so parallel
        // requests would only queue there.
        await removeOne(item);
        removed.add(item.id);
      } catch (error) {
        if (isItemGone(error)) removed.add(item.id);
        else failed.push(messageOf(error));
      }
    }
  } finally {
    onItem(null);
  }
  return { removed, failed };
}

/**
 * The project without the given items.
 *
 * @param {Object|null} project
 * @param {Set<string>} ids
 * @returns {Object|null}
 */
export function withoutItems(project, ids) {
  if (!project || ids.size === 0) return project;
  return { ...project, items: (project.items || []).filter(entry => !ids.has(entry.id)) };
}
