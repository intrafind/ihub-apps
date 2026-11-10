// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Not for AI" (`excludedFromAi`, #3538): an item that stays in its project
 * for people (preview, download, sharing) and is never given to a model. Every
 * path that hands project text to a model goes through
 * {@link withoutExcludedItems}: the chat scope (`resolveProjectScope`, which
 * feeds the prompt and the knowledge tools) and the MCP project resource.
 * Dependency-free on purpose, so either can import it.
 *
 * @module services/projects/aiAccess
 */

/**
 * Whether an item is marked "Not for AI".
 *
 * @param {Object|null|undefined} item
 * @returns {boolean}
 */
export function isExcludedFromAi(item) {
  return item?.excludedFromAi === true;
}

/**
 * The project as a model may see it: without the items marked "Not for AI".
 * The same object comes back when none is marked, and the stored project is
 * never changed.
 *
 * @param {Object} project
 * @returns {Object}
 */
export function withoutExcludedItems(project) {
  const items = project?.items;
  if (!Array.isArray(items) || !items.some(isExcludedFromAi)) return project;
  return { ...project, items: items.filter(item => !isExcludedFromAi(item)) };
}
