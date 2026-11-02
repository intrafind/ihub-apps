// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedContent } from '../../../../utils/localizeContent';

/**
 * Which apps bind an installation. A key of `app.integrations` binds it when
 * it is
 *
 * - the installation id (`"govdata": {}`),
 * - its definition id (`"com.intrafind/ldap-directory": {}` binds every
 *   directory), or
 * - its type (`"type:people-directory": {}` binds every installation of the
 *   type, see `server/services/integrations/integrationTypes.js`).
 *
 * A web search engine (`type: "web-search"`) is not bound: an app with web
 * search on names it in `websearch.provider` (`webSearch`), or uses it on
 * Auto (`webSearchAuto`, the first engine a user may use).
 *
 * Used by the remove and disable confirmations on Admin → Integrations and by
 * the Overview tab of an installation's page.
 *
 * @module features/admin/components/integrations/integrationBindings
 */

/** Prefix of an `app.integrations` key that binds every installation of a type. */
export const TYPE_BINDING_PREFIX = 'type:';

/** The type of the web search engines, which apps use through `app.websearch`. */
const WEB_SEARCH_TYPE = 'web-search';

/**
 * How an app binds an installation, or null when it does not.
 *
 * @param {Object} app - an app config (`integrations`)
 * @param {{ id: string, definition?: string, type?: string|null }} installation
 * @returns {'installation'|'definition'|'type'|'webSearch'|'webSearchAuto'|null}
 */
export function bindingKindOf(app, installation) {
  if (!installation?.id) return null;
  if (installation.type === WEB_SEARCH_TYPE && app?.websearch?.enabled === true) {
    const provider = app.websearch.provider || 'auto';
    if (provider === installation.id) return 'webSearch';
    if (provider === 'auto') return 'webSearchAuto';
  }
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return null;
  if (Object.hasOwn(bindings, installation.id)) return 'installation';
  if (installation.definition && Object.hasOwn(bindings, installation.definition)) {
    return 'definition';
  }
  if (installation.type && Object.hasOwn(bindings, `${TYPE_BINDING_PREFIX}${installation.type}`)) {
    return 'type';
  }
  return null;
}

/**
 * The apps that bind an installation, with their display names.
 *
 * @param {Object[]} apps - app configs (`GET /api/admin/apps`)
 * @param {{ id: string, definition?: string, type?: string|null }} installation
 * @param {string} language - for the app names
 * @returns {Array<{ id: string, name: string, via: 'installation'|'definition'|'type'|'webSearch'|'webSearchAuto' }>}
 */
export function appsBindingInstallation(apps, installation, language) {
  if (!Array.isArray(apps) || !installation) return [];
  const out = [];
  for (const app of apps) {
    const via = bindingKindOf(app, installation);
    if (!via) continue;
    out.push({ id: app.id, name: getLocalizedContent(app.name, language) || app.id, via });
  }
  return out;
}
