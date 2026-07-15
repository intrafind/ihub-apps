import { getLocalizedContent } from '../../utils/localizeContent.js';

export const OTHER_CATEGORY_ID = '__other__';

/**
 * Client-side filter for the App Navigator sidebar search box (FR-7).
 * Matches on localized app name and description, case-insensitively.
 */
export function filterAppsForNavigator(apps, searchTerm, currentLanguage) {
  const term = (searchTerm || '').trim().toLowerCase();
  if (!term) return apps;

  return apps.filter(app => {
    const name = (getLocalizedContent(app.name, currentLanguage) || '').toLowerCase();
    const description = (getLocalizedContent(app.description, currentLanguage) || '').toLowerCase();
    return name.includes(term) || description.includes(term);
  });
}

/**
 * Groups apps by category for the App Navigator sidebar (FR-3, FR-6, FR-13).
 *
 * `categoryMeta` is the existing `uiConfig.appsList.categories.list` array — reused
 * as-is so category id/name/color are only ever defined in one place. `categoryOrder`
 * (from `uiConfig.appNavigator.categoryOrder`) only controls display order; categories
 * present in apps but missing from categoryOrder fall back to categoryMeta's own order,
 * then alphabetically by id. Apps whose `category` doesn't match any known category id
 * are bucketed into a trailing "other" group (FR-13).
 */
export function groupAppsByCategory({ apps, categoryOrder = [], categoryMeta = [] }) {
  const metaById = new Map(categoryMeta.filter(c => c.id !== 'all').map(c => [c.id, c]));

  const buckets = new Map();
  const usedIds = new Set();

  for (const app of apps) {
    const categoryId =
      app.category && metaById.has(app.category) ? app.category : OTHER_CATEGORY_ID;
    usedIds.add(categoryId);
    if (!buckets.has(categoryId)) buckets.set(categoryId, []);
    buckets.get(categoryId).push(app);
  }

  const orderedIds = [];
  const seen = new Set();

  for (const id of categoryOrder) {
    if (usedIds.has(id) && !seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }

  for (const id of metaById.keys()) {
    if (usedIds.has(id) && !seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }

  const leftover = [...usedIds]
    .filter(id => id !== OTHER_CATEGORY_ID && !seen.has(id))
    .sort((a, b) => a.localeCompare(b));
  orderedIds.push(...leftover);
  leftover.forEach(id => seen.add(id));

  if (usedIds.has(OTHER_CATEGORY_ID)) {
    orderedIds.push(OTHER_CATEGORY_ID);
  }

  return orderedIds.map(id => {
    const meta = metaById.get(id);
    return {
      id,
      name: meta ? meta.name : null,
      color: meta ? meta.color : undefined,
      apps: buckets.get(id)
    };
  });
}
