// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pure rules of the project catalog dialog: where an entry comes from, what
 * the viewer can do with it, and how the search and the source filter narrow
 * the list. The dialog lists the published projects (`/projects/_catalog`) and
 * the viewer's iFinder smart collections (`/projects/_collections`) in one list,
 * grouped by source.
 *
 * @module features/projects/utils/catalogSources
 */

import { localizedText } from './projectItems';
import { projectDisplayName } from './projectView';

/**
 * The sources, in the order the dialog shows their groups: what the viewer
 * can add first, what is theirs already last.
 *
 * - `admin`: admin projects available to everyone signed in.
 * - `colleagues`: user projects published by someone else, reached only
 *   through the catalog.
 * - `ifinder`: the viewer's own iFinder smart collections.
 * - `yours`: published projects the viewer owns or is a member of; they are
 *   in the viewer's list already.
 */
export const CATALOG_SOURCES = Object.freeze(['admin', 'colleagues', 'ifinder', 'yours']);

/**
 * The source of a catalog project.
 *
 * @param {{ownership?: string, role?: string}} project
 * @returns {'admin'|'colleagues'|'yours'}
 */
export function catalogProjectSource(project) {
  if (project?.ownership === 'admin') return 'admin';
  return project?.role === 'catalog' ? 'colleagues' : 'yours';
}

/**
 * The texts of a value that may be localized (`{ en, de }`) or plain.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function texts(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    return Object.values(value).filter(entry => typeof entry === 'string');
  }
  return [];
}

/**
 * @typedef {Object} CatalogEntry
 * @property {string} key - Unique over both lists.
 * @property {'project'|'collection'} kind
 * @property {'admin'|'colleagues'|'ifinder'|'yours'} source
 * @property {string} id - The project id, or the collection id.
 * @property {string} name
 * @property {string} description
 * @property {string|null} projectId - The project to open, when there is one.
 * @property {'add'|'added'|'inList'} status - `add`: not in the viewer's
 *   list; `added`: added from the catalog (can be removed again); `inList`:
 *   in the viewer's list for another reason (owner, member, a collection
 *   added as a project).
 * @property {string|null} ownerName
 * @property {number} count - Items of a project, documents of a collection.
 * @property {string} haystack - Lower-cased text the search matches.
 */

/**
 * A catalog project as a dialog entry.
 *
 * @param {Object} project - From `/projects/_catalog`.
 * @param {string} language
 * @returns {CatalogEntry}
 */
export function projectEntry(project, language) {
  const source = catalogProjectSource(project);
  const ownerName = project.owner?.name || null;
  return {
    key: `project:${project.id}`,
    kind: 'project',
    source,
    id: project.id,
    name: projectDisplayName(project, language),
    description: localizedText(project.description, language),
    projectId: project.id,
    status: source === 'yours' ? 'inList' : project.subscribed ? 'added' : 'add',
    ownerName,
    count: project.usage?.items ?? 0,
    haystack: [...texts(project.name), ...texts(project.description), ownerName || '']
      .join(' ')
      .toLowerCase()
  };
}

/**
 * A smart collection as a dialog entry.
 *
 * @param {Object} collection - From `/projects/_collections`.
 * @returns {CatalogEntry}
 */
export function collectionEntry(collection) {
  const added = Boolean(collection.added);
  return {
    key: `collection:${collection.collectionId}`,
    kind: 'collection',
    source: 'ifinder',
    id: collection.collectionId,
    name: collection.name || collection.collectionId,
    description: collection.description || '',
    projectId: added ? collection.projectId || null : null,
    status: added ? 'inList' : 'add',
    ownerName: null,
    count: collection.documentCount ?? 0,
    haystack: `${collection.name || ''} ${collection.description || ''}`.toLowerCase()
  };
}

/**
 * Whether an entry matches the search (every word, anywhere in its name,
 * description or owner).
 *
 * @param {CatalogEntry} entry
 * @param {string} query
 * @returns {boolean}
 */
export function matchesQuery(entry, query) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words.every(word => entry.haystack.includes(word));
}

/**
 * The entries of each source that match the search, in source order. Sources
 * without entries are left out.
 *
 * @param {CatalogEntry[]} entries
 * @param {string} query
 * @returns {Array<{source: string, entries: CatalogEntry[]}>}
 */
export function groupCatalogEntries(entries, query) {
  return CATALOG_SOURCES.map(source => ({
    source,
    entries: entries.filter(entry => entry.source === source && matchesQuery(entry, query))
  })).filter(group => group.entries.length > 0);
}

/**
 * The sources the filter offers: those with at least one entry before the
 * search, plus the ones that are still loading or failed (so their chip does
 * not appear late and push the others aside).
 *
 * @param {CatalogEntry[]} entries
 * @param {string[]} [pendingSources=[]] - Sources still loading or failed.
 * @returns {string[]}
 */
export function availableSources(entries, pendingSources = []) {
  return CATALOG_SOURCES.filter(
    source => pendingSources.includes(source) || entries.some(entry => entry.source === source)
  );
}
