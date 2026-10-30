// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The link kinds: items whose content stays where it is and is fetched at
 * use time with a TTL cache — today's `url`, `page` and `ifinder` source
 * handlers behind the kind registry (spec 1 §4, spec 2 §3).
 *
 * This module registers the references and their descriptions. The fetch
 * side (the handlers' `getCachedContent`) is wired by the knowledge provider
 * (spec 2 §2.1), so a link item can be added and listed before it is read.
 *
 * @module services/projects/kinds/linkKinds
 */
import { z } from 'zod';
import { zSafeId, isHttpUrl } from '../../../validators/common.js';
import { registerItemKind } from './registry.js';
import { ProjectError } from '../projectErrors.js';

/** Default cache lifetime of a link item's text, in seconds (the URL handler's). */
export const DEFAULT_LINK_TTL_SECONDS = 7200;

const LANGUAGE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/;

function ifinderConfigured({ platform }) {
  return Boolean(platform?.iFinder?.baseUrl || process.env.IFINDER_API_URL);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export const urlKind = registerItemKind({
  id: 'url',
  name: { en: 'Web page (URL)', de: 'Webseite (URL)' },
  icon: 'link',
  storage: { ihub: 'link' },
  credentials: 'none',
  picker: { type: 'url' },
  refSchema: z
    .object({
      url: z.string().trim().max(2048).refine(isHttpUrl, 'Only http(s) URLs are allowed'),
      maxContentLength: z.number().int().positive().max(5_000_000).optional()
    })
    .strict(),
  describe: ref => ({ name: ref.url, url: ref.url, site: hostOf(ref.url) })
});

export const pageKind = registerItemKind({
  id: 'page',
  name: { en: 'iHub page', de: 'iHub-Seite' },
  icon: 'document-text',
  storage: { ihub: 'link' },
  credentials: 'none',
  picker: { type: 'page' },
  refSchema: z
    .object({
      pageId: zSafeId.min(1).max(100),
      language: z.string().regex(LANGUAGE_CODE).prefault('en')
    })
    .strict(),
  describe: ref => ({
    name: ref.pageId,
    url:
      ref.language && ref.language !== 'en'
        ? `/${ref.language}/pages/${ref.pageId}`
        : `/pages/${ref.pageId}`,
    site: 'iHub'
  })
});

/**
 * The search profile an iFinder item is read in, checked like a profile picked
 * in the chat input (`iFinderScopes.validateScope`): the caller's own and within
 * the admin's allow-list. A profile the installation pins replaces the one sent.
 * An item without a profile is read in the default and needs no check.
 *
 * @param {Object} ref - The checked reference.
 * @param {{user?: Object}} ctx
 * @returns {Promise<{ref: Object}|null>}
 * @throws {ProjectError} `SOURCE_FORBIDDEN` for a profile the caller may not search.
 */
async function checkSearchProfile(ref, { user } = {}) {
  if (!ref?.searchProfile) return null;
  const { default: iFinderScopes } = await import('../../integrations/scopes/iFinderScopes.js');
  const check = await iFinderScopes.validateScope({
    scopeId: ref.searchProfile,
    user,
    app: null
  });
  if (!check.ok) {
    throw new ProjectError('SOURCE_FORBIDDEN', check.message, {
      reason: check.code,
      available: check.available || []
    });
  }
  return check.scopeId && check.scopeId !== ref.searchProfile
    ? { ref: { ...ref, searchProfile: check.scopeId } }
    : null;
}

export const ifinderDocumentKind = registerItemKind({
  id: 'ifinder-document',
  name: { en: 'iFinder document', de: 'iFinder-Dokument' },
  icon: 'magnifying-glass',
  storage: { ihub: 'link' },
  credentials: 'reading-user',
  picker: { type: 'ifinder', mode: 'document' },
  enabled: ifinderConfigured,
  refSchema: z
    .object({
      documentId: z.string().trim().min(1).max(500),
      searchProfile: z.string().trim().max(200).optional(),
      maxLength: z.number().int().positive().max(1_000_000).optional()
    })
    .strict(),
  prepare: checkSearchProfile,
  describe: ref => ({ name: ref.documentId, site: 'iFinder' })
});

export const ifinderQueryKind = registerItemKind({
  id: 'ifinder-query',
  name: { en: 'iFinder search', de: 'iFinder-Suche' },
  icon: 'magnifying-glass',
  storage: { ihub: 'link' },
  credentials: 'reading-user',
  picker: { type: 'ifinder', mode: 'query' },
  enabled: ifinderConfigured,
  refSchema: z
    .object({
      // Empty means the model supplies the query at use time (a tool-exposed
      // iFinder source with neither documentId nor query).
      query: z.string().trim().max(1000).prefault(''),
      searchProfile: z.string().trim().max(200).optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
      maxLength: z.number().int().positive().max(1_000_000).optional()
    })
    .strict(),
  prepare: checkSearchProfile,
  describe: ref => ({ name: ref.query || 'iFinder search', site: 'iFinder' })
});

/** Every link kind, for callers that register them explicitly. */
export const LINK_KINDS = Object.freeze([urlKind, pageKind, ifinderDocumentKind, ifinderQueryKind]);
