// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The warnings Admin → Apps shows for an app after a definition migration
 * changed what the app binds (versioning concept, open question "App
 * bindings are not versioned": a removed action leaves the app with fewer
 * tools and a warning in Admin → Apps).
 *
 * The data is the installations' `migrationLog` of
 * `GET /api/admin/integrations/installed`: every run records the planner's
 * warnings, each with the `appId` and binding `key` it concerns
 * (`server/services/integrations/definitions/migrationPlanner.js`):
 *
 * - `ACTION_REMOVED_FROM_APP` (`action`): a `removeAction` step dropped an
 *   action from the app's own or definition binding; the app no longer offers it.
 * - `TYPE_BINDING_NOT_REWRITTEN` (`action` or `scope`): the app names a
 *   renamed or removed action or scope in a `type:` binding, which a
 *   migration never rewrites; the admin edits the app.
 *
 * Pure; `AppMigrationWarnings.jsx` renders them.
 *
 * @module features/admin/components/integrations/appMigrationWarnings
 */

/** The warning codes that concern an app. */
export const APP_WARNING_CODES = Object.freeze({
  ACTION_REMOVED_FROM_APP: 'ACTION_REMOVED_FROM_APP',
  TYPE_BINDING_NOT_REWRITTEN: 'TYPE_BINDING_NOT_REWRITTEN'
});

const CODES = new Set(Object.values(APP_WARNING_CODES));

/**
 * Whether the app still has what a warning is about:
 *
 * - a type binding warning holds while the binding still names the action
 *   (or sets the scope); once the admin edited it, it is gone;
 * - a removed action holds while the app still has the binding it was
 *   removed from (unbinding the installation settles it).
 *
 * @param {Object} app - the app (as stored, or as being edited)
 * @param {Object} warning
 * @returns {boolean}
 */
function stillApplies(app, warning) {
  const bindings =
    app?.integrations && typeof app.integrations === 'object' ? app.integrations : {};
  if (!warning.key) return true;
  if (!Object.hasOwn(bindings, warning.key)) return false;
  if (warning.code !== APP_WARNING_CODES.TYPE_BINDING_NOT_REWRITTEN) return true;
  const binding = bindings[warning.key] || {};
  if (warning.scope) {
    return binding.defaultScope === warning.scope || binding.pinnedScope === warning.scope;
  }
  return Array.isArray(binding.actions) && binding.actions.includes(warning.action);
}

/**
 * The migration warnings about one app, newest first: the warnings of each
 * installation's `migrated` runs since its last restore (a restore puts the
 * app bindings of its backup back, so what earlier runs removed is back
 * too), that still apply to the app, once each.
 *
 * @param {Array<Object>|null|undefined} installations - `GET …/installed` → `items`
 * @param {Object} app - the app (`id`, `integrations`)
 * @returns {Array<{ code: string, appId: string, key?: string, action?: string, scope?: string,
 *   message?: string, instanceId: string, installationLabel: string, from?: string, to?: string, at?: string }>}
 */
export function appMigrationWarnings(installations, app) {
  if (!app?.id || !Array.isArray(installations)) return [];
  const seen = new Set();
  const out = [];
  for (const installation of installations) {
    const log = Array.isArray(installation?.migrationLog) ? installation.migrationLog : [];
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const entry = log[index];
      if (entry?.result === 'restored') break;
      if (entry?.result !== 'migrated') continue;
      for (const warning of entry.warnings || []) {
        if (!CODES.has(warning?.code) || warning.appId !== app.id) continue;
        if (!stillApplies(app, warning)) continue;
        const id = [installation.id, warning.code, warning.key, warning.action, warning.scope].join(
          '\u0000'
        );
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          ...warning,
          instanceId: installation.id,
          installationLabel: installation.label || installation.id,
          from: entry.from,
          to: entry.to,
          at: entry.at
        });
      }
    }
  }
  return out;
}

/**
 * The warnings of an app by the binding key they concern (`app.integrations`
 * key), for the app editor's binding rows.
 *
 * @param {Array<Object>} warnings - from {@link appMigrationWarnings}
 * @returns {Map<string, Array<Object>>}
 */
export function warningsByBindingKey(warnings) {
  const byKey = new Map();
  for (const warning of warnings || []) {
    const key = warning.key || '';
    byKey.set(key, [...(byKey.get(key) || []), warning]);
  }
  return byKey;
}
