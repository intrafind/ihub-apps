// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * Display helpers for integration scopes (#3050). The server names every
 * integration and scope (a string or a `{ en, de }` object), so nothing here
 * depends on which integration is behind an entry.
 */

/** The display name of an integration or a scope. */
export function scopeDisplayName(entry, language) {
  if (!entry) return '';
  return getLocalizedContent(entry.name, language) || entry.id || '';
}

/** The scope an integration currently uses, or undefined. */
export function currentScopeOf(integration) {
  return integration?.scopes?.find(scope => scope.id === integration.current);
}

/**
 * The label before a scope name: "Search in" for an integration that searches
 * somewhere, "Ask" for one that asks someone.
 */
export function scopeActionLabel(integration, t) {
  return integration?.action === 'ask'
    ? t('integrationScopes.ask', 'Ask')
    : t('integrationScopes.searchIn', 'Search in');
}

/**
 * Why an integration only lists its configured default, or null when the
 * list is the user's own.
 */
export function scopeHint(integration, t) {
  switch (integration?.hint) {
    case 'forbidden':
      return t(
        'integrationScopes.hint.forbidden',
        'Your account may not read its list here, so only the default is offered.'
      );
    case 'no-profiles':
      return t(
        'integrationScopes.hint.noProfiles',
        'None of your own entries is offered here, so only the default is listed.'
      );
    case 'unavailable':
      return t(
        'integrationScopes.hint.unavailable',
        'The list could not be loaded, so only the default is offered.'
      );
    default:
      return null;
  }
}
