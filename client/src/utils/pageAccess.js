/**
 * Shared navigation/page access helpers.
 *
 * Used by both the layout footer and the sidebar so the rules for gating
 * configured links live in exactly one place.
 */

// Maps navigation URLs to the feature flag that gates them.
export const FEATURE_ROUTES = { '/prompts': 'promptsLibrary', '/workflows': 'workflows' };

/**
 * Whether the current user may see a configured link.
 *
 * Only `/pages/*` links carry per-page access rules (authRequired / allowedGroups);
 * everything else is always visible.
 *
 * @param {{url: string}} link
 * @param {{ uiConfig?: object, isAuthenticated?: boolean, user?: object }} ctx
 * @returns {boolean}
 */
export function canAccessLink(link, { uiConfig, isAuthenticated, user } = {}) {
  if (!link?.url || !link.url.startsWith('/pages/') || !uiConfig?.pages) return true;
  const pageId = link.url.replace('/pages/', '');
  const page = uiConfig.pages[pageId];
  if (!page) return true;
  if (page.authRequired && !isAuthenticated) return false;
  if (Array.isArray(page.allowedGroups)) {
    if (page.allowedGroups.includes('*')) return true;
    if (page.allowedGroups.length > 0) {
      const groups = user?.groups || [];
      return groups.some(g => page.allowedGroups.includes(g));
    }
  }
  return true;
}
