// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Category helpers shared by the admin Apps and Prompts lists.
 *
 * The end-user lists file an app without a category under "Utility" and a
 * prompt without one under "Creative" (`AppsList.jsx`, `PromptsList.jsx`). The
 * admin lists use the same fallback for the Category column, its sort and the
 * category filter, so the column never says "N/A" for an app the filter counts
 * as Utility.
 */

/** The category an app without one is listed under. */
export const APP_FALLBACK_CATEGORY = 'utility';

/** The category a prompt without one is listed under. */
export const PROMPT_FALLBACK_CATEGORY = 'creative';

/** The id `ui.json` gives its own "All" entry in a category list. */
const ALL_CATEGORY_ID = 'all';

/**
 * The category an item is listed under: its own, or the fallback.
 *
 * @param {{category?: string}} item - An app or a prompt.
 * @param {string} fallback - `APP_FALLBACK_CATEGORY` or `PROMPT_FALLBACK_CATEGORY`.
 * @returns {string}
 *
 * @example
 * effectiveCategory({}, APP_FALLBACK_CATEGORY); // → 'utility'
 */
export function effectiveCategory(item, fallback) {
  return item?.category || fallback;
}

/**
 * The categories to offer as filter chips. `ui.json` lists an "All" entry of
 * its own for the end-user pages; the admin lists already start with their own
 * "All Categories" chip, so that entry is left out instead of showing twice.
 *
 * @param {Array<{id: string}>|undefined} categories - `ui.json` `appsList` / `promptsList` categories.
 * @returns {Array<{id: string}>}
 *
 * @example
 * categoryChips([{ id: 'all' }, { id: 'utility' }]); // → [{ id: 'utility' }]
 */
export function categoryChips(categories) {
  return (Array.isArray(categories) ? categories : []).filter(
    category => category && category.id !== ALL_CATEGORY_ID
  );
}

/**
 * The display name of the category an item is listed under, with whether it
 * is the item's own or the fallback.
 *
 * @param {{category?: string}} item - An app or a prompt.
 * @param {Array<{id: string, name: unknown}>|undefined} categories - The configured categories.
 * @param {string} fallback - The fallback category id.
 * @param {(name: unknown) => string} localize - Turns a localized name into text.
 * @returns {{id: string, label: string, isFallback: boolean}}
 */
export function categoryDisplay(item, categories, fallback, localize) {
  const id = effectiveCategory(item, fallback);
  const found = (Array.isArray(categories) ? categories : []).find(category => category?.id === id);
  const label = (found && localize(found.name)) || id;
  return { id, label, isFallback: !item?.category };
}
