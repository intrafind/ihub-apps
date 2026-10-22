// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Rules about project **items** (#1036) that the admin project editor and the
 * user project page share, kept out of the React components so they can be
 * unit tested on their own:
 *
 *  - item status helpers (is anything still being extracted, which actions an
 *    item offers);
 *  - the "Add item" dialog: which tabs exist and whether each is usable, the
 *    JSON body each tab sends, the reference a cloud pick becomes, and the
 *    checks a file goes through before it is uploaded;
 *  - small display helpers (kind icon, localized text).
 *
 * Every function is pure. Validation returns error *codes*; the components
 * turn them into translated messages.
 *
 * @module features/projects/utils/projectItems
 */

import { getLocalizedContent } from '../../../utils/localizeContent';

/** Item states in which the server is still working on the text. */
export const ACTIVE_ITEM_STATUSES = Object.freeze(['pending', 'extracting']);

/** Item states whose text can be read (a stale item keeps its old snapshot). */
export const READABLE_ITEM_STATUSES = Object.freeze(['ready', 'stale']);

/** How often a project page re-reads a project while an item is being extracted. */
export const ITEM_POLL_INTERVAL_MS = 2000;

/** How much of an item's text the "Preview text" dialog loads. */
export const ITEM_TEXT_PREVIEW_CHARS = 20000;

/** Cloud storage kinds: picked through the cloud file browsers. */
export const CLOUD_ITEM_KINDS = Object.freeze(['office365', 'google-drive', 'nextcloud']);

/**
 * The `platform.cloudStorage.providers[].type` each cloud kind reads from
 * (the kind's `picker.provider` says the same; this is the fallback).
 */
export const CLOUD_PROVIDER_TYPE_BY_KIND = Object.freeze({
  office365: 'office365',
  'google-drive': 'googledrive',
  nextcloud: 'nextcloud'
});

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

/**
 * A name or description in one language. Admin projects store localized
 * records; a plain string (user projects, hand-edited files) is returned as is.
 *
 * @param {string|Object<string, string>|null|undefined} value
 * @param {string} [language='en']
 * @returns {string}
 */
export function localizedText(value, language = 'en') {
  return getLocalizedContent(value, language) || '';
}

// --- status ---------------------------------------------------------------------

/**
 * Whether the server is still extracting the text of any item: a new item
 * (`pending` / `extracting`), or a picked document being refreshed — that one
 * keeps its `ready` / `stale` status (the old snapshot stays readable) and
 * carries `refreshingAt` until the new snapshot is stored.
 *
 * @param {Array<{status: string, refreshingAt?: string}>|undefined} items
 * @returns {boolean}
 */
export function hasActiveItems(items) {
  return (items || []).some(
    item => ACTIVE_ITEM_STATUSES.includes(item?.status) || Boolean(item?.refreshingAt)
  );
}

/**
 * Whether an item's text can be previewed.
 *
 * @param {{status?: string}} item
 * @returns {boolean}
 */
export function isItemReadable(item) {
  return READABLE_ITEM_STATUSES.includes(item?.status);
}

/** The longest text the edit dialog loads and sends (the server's own cap). */
export const ITEM_TEXT_EDIT_CHARS = 2_000_000;

/** The origins whose stored text an editor may replace (mirrors the server). */
export const EDITABLE_TEXT_ORIGINS = Object.freeze(['written', 'uploaded', 'imported']);

/**
 * Whether the text of an item can be edited in place: a readable stored
 * text that came from the user (written, uploaded) or from the sources
 * migration. A link reads live, and a document picked from a cloud drive or
 * iFinder carries the source's text, so neither is editable.
 *
 * @param {Object} item
 * @returns {boolean}
 */
export function isItemTextEditable(item) {
  return (
    item?.storage === 'text' &&
    Boolean(item.text) &&
    isItemReadable(item) &&
    EDITABLE_TEXT_ORIGINS.includes(item.provenance?.origin)
  );
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

// --- the "Add item" dialog ---------------------------------------------------------

/**
 * Whether a kind is offered: listed, and not explicitly disabled. The admin
 * `_kinds` list carries `enabled` per kind; the user `_config.kinds` list
 * only holds the enabled ones and has no such flag.
 */
function enabledKindIds(kinds) {
  return new Set((kinds || []).filter(kind => kind && kind.enabled !== false).map(kind => kind.id));
}

/**
 * The tabs of the "Add item" dialog and whether each can be used.
 *
 * @param {Array<{id: string, enabled?: boolean}>} kinds - Admin `GET /_kinds` or
 *   user `GET /api/projects/_config` `kinds`.
 * @param {{upload?: {available?: boolean}}|null} config - The `_config` answer.
 * @param {{cloud?: boolean}} [options] - `cloud: true` offers the cloud kinds
 *   (the dialog has a cloud picker); otherwise they are shown as coming later.
 * @returns {Array<{id: string, kind: string, enabled: boolean,
 *   reason: null|'later'|'disabled'|'storageUnavailable'}>}
 *   `reason` explains a disabled tab.
 */
export function buildItemDialogTabs(kinds, config, { cloud = false } = {}) {
  const enabledKinds = enabledKindIds(kinds);
  const uploadAvailable = config?.upload?.available !== false;
  return ITEM_DIALOG_TABS.map(tab => {
    if (CLOUD_ITEM_KINDS.includes(tab.kind) && !cloud) {
      return { ...tab, enabled: false, reason: 'later' };
    }
    if (!enabledKinds.has(tab.kind)) return { ...tab, enabled: false, reason: 'disabled' };
    if (tab.kind === 'upload' && !uploadAvailable) {
      return { ...tab, enabled: false, reason: 'storageUnavailable' };
    }
    return { ...tab, enabled: true, reason: null };
  });
}

/**
 * The tabs a user sees: usable tabs, plus disabled ones only when they
 * explain something (storage down). Kinds the installation does not offer
 * are hidden rather than shown greyed out (spec 3 §9: "the kind's tab is
 * hidden").
 *
 * @param {ReturnType<typeof buildItemDialogTabs>} tabs
 * @returns {ReturnType<typeof buildItemDialogTabs>}
 */
export function visibleItemDialogTabs(tabs) {
  return (tabs || []).filter(tab => tab.enabled || tab.reason === 'storageUnavailable');
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
 * The JSON body `POST …/projects/:id/items` gets from a dialog tab (every
 * tab but the file upload, which sends multipart, and the cloud tabs, which
 * send {@link buildCloudItemRequest}).
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

/** Drop `undefined`, `null` and empty strings from a flat object. */
function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== undefined && value !== null && value !== ''
    )
  );
}

/**
 * The `ref` of a cloud item, from what the cloud file browser holds for the
 * picked file (`useCloudStorageBrowser`: Graph / Drive / WebDAV listings).
 * The shapes follow the kinds' `refSchema` (`server/services/projects/kinds/
 * cloudKinds.js`): Office 365 needs the drive, Nextcloud a path.
 *
 * @param {string} kind - `office365`, `google-drive` or `nextcloud`.
 * @param {string} providerId - The cloud storage provider the file came from.
 * @param {{id: string, name?: string, path?: string, mimeType?: string, size?: number,
 *   lastModifiedDateTime?: string, webUrl?: string, webViewLink?: string}} file
 * @param {{id?: string}|null} [drive] - The drive the file sits in (Office 365).
 * @returns {Object|null} `null` when the file lacks what the kind needs.
 *
 * @example
 * cloudItemRef('office365', 'sp', { id: 'f1', name: 'a.pdf' }, { id: 'd1' })
 * // => { providerId: 'sp', fileId: 'f1', driveId: 'd1', name: 'a.pdf' }
 */
export function cloudItemRef(kind, providerId, file, drive = null) {
  if (!providerId || !file) return null;
  const meta = compact({
    name: file.name,
    mimeType: file.mimeType,
    size: Number.isFinite(file.size) ? file.size : undefined,
    lastModified: file.lastModifiedDateTime || file.lastModified,
    url: file.webUrl || file.webViewLink
  });
  switch (kind) {
    case 'office365':
      if (!file.id) return null;
      return compact({ providerId, fileId: file.id, driveId: drive?.id, ...meta });
    case 'google-drive':
      if (!file.id) return null;
      return { providerId, fileId: file.id, ...meta };
    case 'nextcloud': {
      const path = file.path || file.id;
      if (!path) return null;
      return { providerId, path, ...meta };
    }
    default:
      return null;
  }
}

/**
 * The JSON bodies of a cloud pick: one item per picked file.
 *
 * @param {string} kind
 * @param {string} providerId
 * @param {Array<Object>} files - Picked files (see {@link cloudItemRef}).
 * @param {Object|null} drive
 * @param {{pinned?: boolean}} [options]
 * @returns {Array<{kind: string, ref: Object, name?: string, pinned: boolean}>}
 */
export function buildCloudItemRequests(kind, providerId, files, drive, { pinned = false } = {}) {
  return (files || [])
    .map(file => cloudItemRef(kind, providerId, file, drive))
    .filter(Boolean)
    .map(ref => ({ kind, ref, ...(ref.name ? { name: ref.name } : {}), pinned }));
}

/**
 * The cloud providers that serve one cloud kind.
 *
 * @param {Array<{id: string, type: string, displayName?: string}>} providers -
 *   From `GET /api/projects/pickers/cloud`.
 * @param {{id: string, picker?: {provider?: string}}|string} kind - A kind
 *   entry of `_config.kinds`, or its id.
 * @returns {Array<{id: string, type: string, displayName?: string}>}
 */
export function cloudProvidersForKind(providers, kind) {
  const kindId = typeof kind === 'string' ? kind : kind?.id;
  const type =
    (typeof kind === 'object' && kind?.picker?.provider) || CLOUD_PROVIDER_TYPE_BY_KIND[kindId];
  return (providers || []).filter(provider => provider?.type === type);
}

/**
 * The `uploadConfig` the shared cloud file browsers expect, from the project
 * limits: the browser greys out files above `maxFileSizeMB` (and falls back
 * to its own 10 MB default when it is not set). The server checks the size
 * again when it fetches the file.
 *
 * @param {{limits?: {maxFileBytes?: number}}|null} config - `_config`.
 * @returns {{maxFileSizeMB?: number}}
 *
 * @example
 * cloudBrowserUploadConfig({ limits: { maxFileBytes: 20971520 } }); // { maxFileSizeMB: 20 }
 */
export function cloudBrowserUploadConfig(config) {
  const maxBytes = config?.limits?.maxFileBytes;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return {};
  return { maxFileSizeMB: maxBytes / (1024 * 1024) };
}

/**
 * Which cloud files the project can take, for the shared cloud file browser
 * (`isFileSupported`): the formats the project extraction pipeline accepts
 * (`_config.upload`, by MIME type — `text/*` style wildcards included — or by
 * extension), rather than the chat uploader's list, which leaves out Excel,
 * PowerPoint and OpenDocument files the project reads. The server checks the
 * type again when it fetches the file.
 *
 * @param {{upload?: {mimeTypes?: string[], accept?: string[]}}|null} config - `_config`.
 * @returns {((mimeType: string, fileName: string) => boolean)|null} Null
 *   without an upload block: the browser keeps its own rule.
 *
 * @example
 * const supported = projectFileSupported({ upload: { mimeTypes: ['text/*'], accept: ['.xlsx'] } });
 * supported('text/csv', 'a.csv'); // true
 * supported('application/octet-stream', 'Budget.XLSX'); // true
 */
export function projectFileSupported(config) {
  const upload = config?.upload;
  const mimeTypes = Array.isArray(upload?.mimeTypes) ? upload.mimeTypes : [];
  const extensions = Array.isArray(upload?.accept) ? upload.accept : [];
  if (mimeTypes.length === 0 && extensions.length === 0) return null;
  const exact = new Set(mimeTypes.filter(type => !type.endsWith('/*')).map(lower));
  const prefixes = mimeTypes
    .filter(type => type.endsWith('/*'))
    .map(type => lower(type.slice(0, -1)));
  const accepted = new Set(extensions.map(lower));
  return (mimeType, fileName) => {
    const type = lower(String(mimeType || '').split(';')[0]);
    if (type && (exact.has(type) || prefixes.some(prefix => type.startsWith(prefix)))) {
      return true;
    }
    const name = String(fileName || '');
    const dot = name.lastIndexOf('.');
    return dot > 0 && accepted.has(lower(name.slice(dot)));
  };
}

function lower(value) {
  return String(value).trim().toLowerCase();
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
 * Check several files against the per-file limit and the project quotas
 * before any is sent (the server checks again; this saves a doomed upload).
 *
 * @param {Array<File>} files
 * @param {{limits?: {maxFileBytes?: number, maxFiles?: number, maxProjectBytes?: number}}|null} config
 * @param {{items?: number, bytes?: number}|null} usage - The project's current usage.
 * @returns {null|'fileRequired'|'fileTooLarge'|'quotaFiles'|'quotaProjectBytes'}
 */
export function validateUploads(files, config, usage) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return 'fileRequired';
  for (const file of list) {
    const error = validateUpload(file, config);
    if (error) return error;
  }
  const limits = config?.limits || {};
  const usedItems = usage?.items || 0;
  if (Number.isFinite(limits.maxFiles) && usedItems + list.length > limits.maxFiles) {
    return 'quotaFiles';
  }
  const usedBytes = usage?.bytes || 0;
  const adding = list.reduce((sum, file) => sum + (file.size || 0), 0);
  if (Number.isFinite(limits.maxProjectBytes) && usedBytes + adding > limits.maxProjectBytes) {
    return 'quotaProjectBytes';
  }
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
