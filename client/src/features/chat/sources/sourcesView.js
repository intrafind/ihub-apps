// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { hostOf } from '../../../../../shared/sources/index.js';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { originNounOf as activityOriginNounOf } from '../activityHeadline.js';

/**
 * How a source and an answer's sources read in the chat: the site line of a
 * card, the icon it gets, the scope it was found in.
 *
 * @module features/chat/sources/sourcesView
 */

/**
 * Where a source lives, for its card: the site of a web page, the system a
 * document or record comes from.
 *
 * @param {Object} source
 * @returns {string}
 */
export function siteOf(source) {
  if (source?.site) return source.site;
  return source?.url ? hostOf(source.url) : '';
}

/** Lower-case file type of a document, from its type or its file name. */
export function fileTypeOf(source) {
  const type = String(source?.type || '').toLowerCase();
  if (type) return type;
  const match = /\.([a-z0-9]{1,8})$/i.exec(source?.fileName || '');
  return match ? match[1].toLowerCase() : '';
}

/**
 * Where a source was found, for its card: the display name of the scope it
 * was found in ("Contracts" for an iFinder search profile, #3056). Empty for
 * a source whose producer names no scope (a web page, a project document).
 *
 * @param {Object} source
 * @returns {string}
 */
export function scopeLabelOf(source) {
  return source?.ref?.scope && typeof source.scopeName === 'string' ? source.scopeName : '';
}

/**
 * The scopes an answer's sources were found in, in the order they first
 * appear, with how many sources each holds — what the panel filters by when
 * there is more than one.
 *
 * @param {Object[]} sources
 * @returns {Array<{id: string, label: string, count: number}>}
 */
export function sourceScopesOf(sources) {
  const scopes = new Map();
  for (const source of sources || []) {
    const label = scopeLabelOf(source);
    if (!label) continue;
    const id = source.ref.scope;
    const known = scopes.get(id);
    if (known) known.count += 1;
    else scopes.set(id, { id, label, count: 1 });
  }
  return [...scopes.values()];
}

/**
 * Whether a source belongs in the panel while it shows one scope only.
 *
 * @param {Object} source
 * @param {string|null} scopeId - the scope shown; null shows every source
 * @returns {boolean}
 */
export function matchesScope(source, scopeId) {
  return !scopeId || source?.ref?.scope === scopeId;
}

/**
 * Where an answer's integrations searched or whom they asked, as the panel
 * header says it: "Searched in Contracts", "Asked HR assistant".
 *
 * @param {Function} t
 * @param {{id: string, name?: string|Object, action?: string}} scope - one of the
 *   set's `scopes` (`shared/sources/sourceSet.js`)
 * @param {string} [language] - for a name given per language
 * @returns {string}
 */
export function answerScopeLabel(t, scope, language) {
  const name = getLocalizedContent(scope?.name, language) || scope?.id || '';
  return scope?.action === 'ask'
    ? t('sources.asked', 'Asked {{scope}}', { scope: name })
    : t('sources.searchedIn', 'Searched in {{scope}}', { scope: name });
}

/**
 * The noun of a source's origin, as the footer and the activity line say it:
 * "Web", "Project", "iFinder", "Document sources", and for a connected system
 * its own label ("Jira"). The server decides the origin (`Source.origin`); a
 * source without one has no noun, and nothing is guessed from its provider.
 *
 * @param {Function} t - translate function
 * @param {{kind?: string, label?: string}|null|undefined} origin
 * @returns {string} empty when the source names no origin
 */
export function originNounOf(t, origin) {
  if (!origin?.kind) return '';
  // One implementation for the card and the activity line, so they cannot drift.
  return activityOriginNounOf(t, { origin: origin.kind, integration: origin.label });
}

/**
 * How many cards each origin holds, in the order the origins first appear:
 * `Web 5 · Project 3`. Connected systems count by their own label. Sources
 * without an origin are not counted.
 *
 * @param {Function} t
 * @param {Object[]} sources
 * @returns {Array<{key: string, noun: string, count: number}>}
 */
export function originSummaryOf(t, sources) {
  const groups = new Map();
  for (const source of sources || []) {
    const origin = source?.origin;
    if (!origin?.kind) continue;
    const key = origin.kind === 'integration' ? `integration:${origin.label || ''}` : origin.kind;
    const known = groups.get(key);
    if (known) known.count += 1;
    else groups.set(key, { key, noun: originNounOf(t, origin), count: 1 });
  }
  return [...groups.values()];
}
