// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Business rules of the admin projects pages (#1036), kept out of the React
 * components so they can be unit tested on their own:
 *
 *  - project links (`[{ id, mode, write }]`) on apps, workflow nodes and
 *    agent profiles, and their normalization from bare string ids;
 *  - the project form: defaults, validation and the request body;
 *  - item helpers: status, kinds summary, the "Add item" dialog tabs and the
 *    JSON body each tab sends;
 *  - list filtering and the dependency list of a refused delete.
 *
 * Every function is pure. Validation returns error *codes*; the components
 * turn them into translated messages.
 *
 * @module features/admin/utils/projectAdmin
 */

import { getLocalizedContent } from '../../../utils/localizeContent';

/** How a linked project reaches the model. `auto` lets the server decide by size. */
export const PROJECT_LINK_MODES = Object.freeze(['auto', 'context', 'tools']);

/** The mode a link gets when none is set (and for a bare string id). */
export const DEFAULT_PROJECT_LINK_MODE = 'auto';

/** Prefix of user project ids; admin project ids may not use it. */
export const USER_PROJECT_ID_PREFIX = 'prj_';

/** Longest admin project id the server accepts. */
export const MAX_PROJECT_ID_LENGTH = 50;

/** Characters allowed in a project id (the server's safe id pattern). */
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Item states in which the server is still working on the text. */
export const ACTIVE_ITEM_STATUSES = Object.freeze(['pending', 'extracting']);

/** How often the edit page re-reads a project while an item is being extracted. */
export const ITEM_POLL_INTERVAL_MS = 2000;

/** How much of an item's text the "Preview text" dialog loads. */
export const ITEM_TEXT_PREVIEW_CHARS = 20000;

/** Cloud storage kinds: listed in the dialog but not offered yet. */
export const CLOUD_ITEM_KINDS = Object.freeze(['office365', 'google-drive', 'nextcloud']);

/**
 * Tabs of the "Add item" dialog in display order. `kind` is the item kind the
 * tab creates; the text tab writes an `upload` item from pasted text.
 */
export const ITEM_DIALOG_TABS = Object.freeze([
  { id: 'upload', kind: 'upload' },
  { id: 'text', kind: 'upload' },
  { id: 'url', kind: 'url' },
  { id: 'page', kind: 'page' },
  { id: 'ifinder-document', kind: 'ifinder-document' },
  { id: 'ifinder-query', kind: 'ifinder-query' },
  ...CLOUD_ITEM_KINDS.map(kind => ({ id: kind, kind }))
]);

/** Icon of each item kind (names of the shared `Icon` component). */
const KIND_ICONS = Object.freeze({
  upload: 'upload',
  text: 'document-text',
  url: 'link',
  page: 'document-text',
  'ifinder-document': 'magnifying-glass',
  'ifinder-query': 'magnifying-glass',
  office365: 'cloud',
  'google-drive': 'cloud',
  nextcloud: 'cloud'
});

/**
 * The `Icon` name for an item kind or dialog tab.
 *
 * @param {string} kind
 * @returns {string}
 */
export function kindIcon(kind) {
  return KIND_ICONS[kind] || 'document';
}

// --- localized text -------------------------------------------------------

/**
 * A project's name or description in one language. Admin projects store
 * localized records; a plain string (hand-edited file) is returned as is.
 *
 * @param {string|Object<string, string>|null|undefined} value
 * @param {string} [language='en']
 * @returns {string}
 */
export function localizedText(value, language = 'en') {
  return getLocalizedContent(value, language) || '';
}

/**
 * A localized record without empty languages; a plain string becomes the
 * English text. Returns `undefined` when nothing is left.
 *
 * @param {string|Object<string, string>|null|undefined} value
 * @returns {Object<string, string>|undefined}
 *
 * @example
 * toLocalizedRecord({ en: 'Handbook', de: ' ' }) // => { en: 'Handbook' }
 * toLocalizedRecord('Handbook')                 // => { en: 'Handbook' }
 */
export function toLocalizedRecord(value) {
  const record = typeof value === 'string' ? { en: value } : value || {};
  const entries = Object.entries(record)
    .filter(([, text]) => typeof text === 'string' && text.trim() !== '')
    .map(([language, text]) => [language, text.trim()]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// --- project links ----------------------------------------------------------

/**
 * One project link as an object. A bare string id is a link in `auto` mode
 * without write access; an unknown mode falls back to `auto`.
 *
 * @param {string|{id: string, mode?: string, write?: boolean}} link
 * @returns {{id: string, mode: 'auto'|'context'|'tools', write: boolean}|null}
 *   `null` for a link without an id.
 */
export function normalizeProjectLink(link) {
  if (typeof link === 'string') {
    const id = link.trim();
    return id ? { id, mode: DEFAULT_PROJECT_LINK_MODE, write: false } : null;
  }
  if (!link || typeof link !== 'object') return null;
  const id = typeof link.id === 'string' ? link.id.trim() : '';
  if (!id) return null;
  return {
    id,
    mode: PROJECT_LINK_MODES.includes(link.mode) ? link.mode : DEFAULT_PROJECT_LINK_MODE,
    write: link.write === true
  };
}

/**
 * A link list as objects, without invalid entries and without duplicates
 * (the first link of an id wins).
 *
 * @param {Array<string|Object>|null|undefined} value
 * @returns {Array<{id: string, mode: string, write: boolean}>}
 *
 * @example
 * normalizeProjectLinks(['handbook', { id: 'faq', mode: 'tools' }])
 * // => [{ id: 'handbook', mode: 'auto', write: false },
 * //     { id: 'faq', mode: 'tools', write: false }]
 */
export function normalizeProjectLinks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const links = [];
  for (const entry of value) {
    const link = normalizeProjectLink(entry);
    if (!link || seen.has(link.id)) continue;
    seen.add(link.id);
    links.push(link);
  }
  return links;
}

/**
 * Add a project to a link list, or remove it when it is linked already.
 *
 * @param {Array<string|Object>} links
 * @param {string} projectId
 * @returns {Array<{id: string, mode: string, write: boolean}>}
 */
export function toggleProjectLink(links, projectId) {
  const current = normalizeProjectLinks(links);
  if (current.some(link => link.id === projectId)) {
    return current.filter(link => link.id !== projectId);
  }
  return [...current, { id: projectId, mode: DEFAULT_PROJECT_LINK_MODE, write: false }];
}

/**
 * Change the mode of one link.
 *
 * @param {Array<string|Object>} links
 * @param {string} projectId
 * @param {'auto'|'context'|'tools'} mode
 * @returns {Array<{id: string, mode: string, write: boolean}>}
 */
export function setProjectLinkMode(links, projectId, mode) {
  const nextMode = PROJECT_LINK_MODES.includes(mode) ? mode : DEFAULT_PROJECT_LINK_MODE;
  return normalizeProjectLinks(links).map(link =>
    link.id === projectId ? { ...link, mode: nextMode } : link
  );
}

// --- project form -------------------------------------------------------------

/**
 * The form of a project that does not exist yet.
 *
 * @returns {{id: string, name: Object, description: Object, instructions: string,
 *   enabled: boolean, category: string, tags: string[]}}
 */
export function createEmptyProjectForm() {
  return {
    id: '',
    name: { en: '' },
    description: { en: '' },
    instructions: '',
    enabled: true,
    category: '',
    tags: []
  };
}

/**
 * The editable fields of a loaded project.
 *
 * @param {Object} project - As `GET /api/admin/projects/:id` returns it.
 * @returns {ReturnType<typeof createEmptyProjectForm>}
 */
export function projectFormFromProject(project) {
  const asRecord = value =>
    typeof value === 'string' ? { en: value } : value && typeof value === 'object' ? value : {};
  const name = asRecord(project?.name);
  const description = asRecord(project?.description);
  return {
    id: project?.id || '',
    name: Object.keys(name).length > 0 ? { ...name } : { en: '' },
    description: Object.keys(description).length > 0 ? { ...description } : { en: '' },
    instructions: project?.instructions || '',
    enabled: project?.enabled !== false,
    category: project?.category || '',
    tags: Array.isArray(project?.tags) ? [...project.tags] : []
  };
}

/**
 * Why an admin project id is not acceptable.
 *
 * @param {string} id
 * @returns {null|'required'|'invalid'|'tooLong'|'reserved'} `null` when the id is fine.
 */
export function validateProjectId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) return 'required';
  if (value.length > MAX_PROJECT_ID_LENGTH) return 'tooLong';
  if (!PROJECT_ID_PATTERN.test(value)) return 'invalid';
  if (value.startsWith(USER_PROJECT_ID_PREFIX)) return 'reserved';
  return null;
}

/**
 * Validate the project form.
 *
 * @param {ReturnType<typeof createEmptyProjectForm>} form
 * @param {{isNew: boolean}} options - The id is checked only when creating.
 * @returns {Object<string, string>} Field → error code; empty when valid.
 */
export function validateProjectForm(form, { isNew }) {
  const errors = {};
  if (isNew) {
    const idError = validateProjectId(form.id);
    if (idError) errors.id = idError;
  }
  if (!toLocalizedRecord(form.name)) errors.name = 'required';
  return errors;
}

/**
 * Split a comma-separated tag input into tags.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseTags(text) {
  const seen = new Set();
  return String(text || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag && !seen.has(tag) && seen.add(tag));
}

/**
 * The request body of `POST /api/admin/projects` and `PUT /api/admin/projects/:id`.
 * Empty languages are dropped and an empty description is left out, because
 * the schema rejects a description that is not a localized record.
 *
 * @param {ReturnType<typeof createEmptyProjectForm>} form
 * @returns {Object}
 */
export function buildProjectPayload(form) {
  const description = toLocalizedRecord(form.description);
  const category = (form.category || '').trim();
  return {
    id: form.id.trim(),
    name: toLocalizedRecord(form.name) || {},
    ...(description ? { description } : {}),
    instructions: form.instructions || '',
    enabled: form.enabled !== false,
    ...(category ? { category } : {}),
    tags: Array.isArray(form.tags) ? form.tags : []
  };
}

// --- items ------------------------------------------------------------------------

/**
 * Whether the server is still extracting the text of any item.
 *
 * @param {Array<{status: string}>|undefined} items
 * @returns {boolean}
 */
export function hasActiveItems(items) {
  return (items || []).some(item => ACTIVE_ITEM_STATUSES.includes(item?.status));
}

/**
 * How many items of each kind a project holds, most frequent first.
 *
 * @param {Array<{kind: string}>|undefined} items
 * @returns {Array<{kind: string, count: number}>}
 */
export function summarizeItemKinds(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (!item?.kind) continue;
    counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * Sum of the extracted tokens of a project's items.
 *
 * @param {Array<{text?: {tokens?: number}}>|undefined} items
 * @returns {number}
 */
export function sumItemTokens(items) {
  return (items || []).reduce((sum, item) => sum + (item?.text?.tokens || 0), 0);
}

/**
 * The tabs of the "Add item" dialog and whether each can be used.
 *
 * @param {Array<{id: string, enabled: boolean}>} kinds - From `GET /_kinds`.
 * @param {{upload?: {available?: boolean}}|null} config - From `GET /_config`.
 * @returns {Array<{id: string, kind: string, enabled: boolean,
 *   reason: null|'later'|'disabled'|'storageUnavailable'}>}
 *   `reason` explains a disabled tab.
 */
export function buildItemDialogTabs(kinds, config) {
  const enabledKinds = new Set((kinds || []).filter(kind => kind.enabled).map(kind => kind.id));
  const uploadAvailable = config?.upload?.available !== false;
  return ITEM_DIALOG_TABS.map(tab => {
    if (CLOUD_ITEM_KINDS.includes(tab.kind)) return { ...tab, enabled: false, reason: 'later' };
    if (!enabledKinds.has(tab.kind)) return { ...tab, enabled: false, reason: 'disabled' };
    if (tab.kind === 'upload' && !uploadAvailable) {
      return { ...tab, enabled: false, reason: 'storageUnavailable' };
    }
    return { ...tab, enabled: true, reason: null };
  });
}

/**
 * Whether a string is an absolute http(s) URL.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The JSON body `POST /api/admin/projects/:id/items` gets from a dialog tab
 * (every tab but the file upload, which sends multipart).
 *
 * @param {string} tabId - One of {@link ITEM_DIALOG_TABS}.
 * @param {{name?: string, pinned?: boolean, text?: string, url?: string,
 *   pageId?: string, language?: string, documentId?: string, query?: string}} draft
 * @returns {{body: Object|null, error: null|string}} The body, or an error code
 *   (`textRequired`, `urlInvalid`, `pageRequired`, `documentRequired`,
 *   `queryRequired`, `unsupported`).
 *
 * @example
 * buildItemRequest('url', { url: 'https://example.com' })
 * // => { body: { kind: 'url', ref: { url: 'https://example.com' }, pinned: false }, error: null }
 */
export function buildItemRequest(tabId, draft = {}) {
  const name = (draft.name || '').trim();
  const common = { ...(name ? { name } : {}), pinned: draft.pinned === true };
  const fail = error => ({ body: null, error });
  switch (tabId) {
    case 'text': {
      const text = draft.text || '';
      if (!text.trim()) return fail('textRequired');
      return { body: { kind: 'upload', ref: {}, ...common, text }, error: null };
    }
    case 'url': {
      const url = (draft.url || '').trim();
      if (!isHttpUrl(url)) return fail('urlInvalid');
      return { body: { kind: 'url', ref: { url }, ...common }, error: null };
    }
    case 'page': {
      const pageId = (draft.pageId || '').trim();
      if (!pageId) return fail('pageRequired');
      const ref = { pageId, ...(draft.language ? { language: draft.language } : {}) };
      return { body: { kind: 'page', ref, ...common }, error: null };
    }
    case 'ifinder-document': {
      const documentId = (draft.documentId || '').trim();
      if (!documentId) return fail('documentRequired');
      return { body: { kind: 'ifinder-document', ref: { documentId }, ...common }, error: null };
    }
    case 'ifinder-query': {
      const query = (draft.query || '').trim();
      if (!query) return fail('queryRequired');
      return { body: { kind: 'ifinder-query', ref: { query }, ...common }, error: null };
    }
    default:
      return fail('unsupported');
  }
}

/**
 * Validate a file upload before it is sent.
 *
 * @param {File|null|undefined} file
 * @param {{limits?: {maxFileBytes?: number}}|null} config
 * @returns {null|'fileRequired'|'fileTooLarge'}
 */
export function validateUpload(file, config) {
  if (!file) return 'fileRequired';
  const maxBytes = config?.limits?.maxFileBytes;
  if (Number.isFinite(maxBytes) && maxBytes > 0 && file.size > maxBytes) return 'fileTooLarge';
  return null;
}

/**
 * The `accept` attribute of the upload input.
 *
 * @param {{upload?: {accept?: string[]}}|null} config
 * @returns {string|undefined}
 */
export function uploadAccept(config) {
  const accept = config?.upload?.accept;
  return Array.isArray(accept) && accept.length > 0 ? accept.join(',') : undefined;
}

/**
 * Whether uploads are accepted without a malware scan, which the edit page
 * warns about.
 *
 * @param {{upload?: {available?: boolean}, scan?: {provider?: string}}|null} config
 * @returns {boolean}
 */
export function uploadsAreUnscanned(config) {
  return config?.upload?.available === true && config?.scan?.provider === 'none';
}

// --- list and delete ----------------------------------------------------------------

/**
 * Filter the admin project list.
 *
 * @param {Array<Object>} projects
 * @param {{search?: string, status?: 'all'|'enabled'|'disabled', kind?: string, language?: string}} filters
 * @returns {Array<Object>}
 */
export function filterProjects(projects, { search = '', status = 'all', kind = 'all', language }) {
  const query = search.trim().toLowerCase();
  return (projects || []).filter(project => {
    if (status === 'enabled' && project.enabled === false) return false;
    if (status === 'disabled' && project.enabled !== false) return false;
    if (kind !== 'all' && !(project.items || []).some(item => item.kind === kind)) return false;
    if (!query) return true;
    const names =
      typeof project.name === 'object' && project.name
        ? Object.values(project.name)
        : [project.name];
    const haystack = [
      project.id,
      localizedText(project.name, language),
      ...names,
      project.category,
      ...(project.tags || [])
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * The dependency list of a delete the server refused (`400 PROJECT_IN_USE`).
 *
 * @param {Error & {response?: {data?: {details?: {code?: string, dependencies?: Array}}}}} error
 * @returns {Array<{type: string, id: string, name: string}>|null} `null` for any other error.
 */
export function dependenciesFromDeleteError(error) {
  const details = error?.response?.data?.details;
  if (details?.code !== 'PROJECT_IN_USE') return null;
  return Array.isArray(details.dependencies) ? details.dependencies : [];
}
