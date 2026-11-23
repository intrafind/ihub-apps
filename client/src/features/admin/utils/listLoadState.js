// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one rule for what an admin list shows while it loads, after it failed to
 * load and when it is empty (AI-B11): a failed load is never shown as an empty
 * list. No "Create your first …" call to action and no count of 0 while a load
 * error is set, because the list is unknown, not empty; rows that were loaded
 * before the failure stay visible (stale data) below the error.
 *
 * Used by the shared `DataTable` (props `error` / `onRetry`) and by the list
 * pages that render their own empty state (Providers). Kept free of React so it
 * can be unit tested.
 */

/**
 * @typedef {'loading'|'error'|'empty'|'rows'} ListView
 *   - `loading`: show the skeleton
 *   - `error`: show only the error (with Retry): nothing was loaded
 *   - `empty`: show the empty state (the load succeeded and there is nothing)
 *   - `rows`: show the rows; with a load error they are stale and the error is shown above them
 */

/**
 * What a list shows.
 *
 * @param {Object} state
 * @param {boolean} [state.loading=false] - A load is running
 * @param {unknown} [state.error=null] - The load error (not an error of an action such as a save)
 * @param {number} [state.rowCount=0] - Rows the list holds (after its filters)
 * @returns {ListView}
 *
 * @example
 *   resolveListView({ error: 'HTTP 500', rowCount: 0 }); // → 'error' (never 'empty')
 *   resolveListView({ error: 'HTTP 500', rowCount: 3 }); // → 'rows' (stale rows stay)
 */
export function resolveListView({ loading = false, error = null, rowCount = 0 } = {}) {
  const hasError = Boolean(error);
  // A retry after a failure keeps the stale rows on screen instead of a skeleton.
  if (loading && !(hasError && rowCount > 0)) return 'loading';
  if (rowCount > 0) return 'rows';
  return hasError ? 'error' : 'empty';
}

/**
 * The count a tab or heading shows for a list: unknown (undefined, so no badge
 * is drawn) while it loads, and after a failed load that left nothing loaded.
 *
 * @param {number} count - Items loaded
 * @param {Object} state
 * @param {boolean} [state.loading=false]
 * @param {unknown} [state.error=null] - The load error
 * @returns {number|undefined}
 */
export function listCount(count, { loading = false, error = null } = {}) {
  if (loading) return undefined;
  if (error && !count) return undefined;
  return count;
}
