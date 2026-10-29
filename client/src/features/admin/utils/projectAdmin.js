// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Business rules of the admin projects pages (#1036), kept out of the React
 * components so they can be unit tested on their own:
 *
 *  - project links (`[{ id, mode, write }]`) on apps, workflow nodes and
 *    agent profiles, and their normalization from bare string ids;
 *  - the project form: defaults, validation and the request body;
 *  - the malware-scan warning of the edit page;
 *  - list filtering and the dependency list of a refused delete.
 *
 * Item rules (status, the "Add item" dialog, uploads) are shared with the user
 * project page and live in `features/projects/utils/projectItems.js`.
 *
 * Every function is pure. Validation returns error *codes*; the components
 * turn them into translated messages.
 *
 * @module features/admin/utils/projectAdmin
 */

import { localizedText } from '../../projects/utils/projectItems';
import { slugify } from './modelImport';

/** How a linked project reaches the model. `auto` lets the server decide by size. */
export const PROJECT_LINK_MODES = Object.freeze(['auto', 'context', 'tools']);

/** The mode a link gets when none is set (and for a bare string id). */
export const DEFAULT_PROJECT_LINK_MODE = 'auto';

/** Prefix of user project ids; admin project ids may not use it. */
export const USER_PROJECT_ID_PREFIX = 'prj_';

/** Prefix of the ids of iFinder smart collections shown as projects; reserved the same way. */
export const IFINDER_PROJECT_ID_PREFIX = 'ifc_';

/** Longest admin project id the server accepts. */
export const MAX_PROJECT_ID_LENGTH = 50;

/** Characters allowed in a project id (the server's safe id pattern). */
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

// --- localized text -------------------------------------------------------

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
 *   enabled: boolean, published: boolean, category: string, tags: string[],
 *   defaultAppId: string}}
 */
export function createEmptyProjectForm() {
  return {
    id: '',
    name: { en: '' },
    description: { en: '' },
    instructions: '',
    enabled: true,
    published: false,
    category: '',
    tags: [],
    defaultAppId: ''
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
    published: project?.published === true,
    category: project?.category || '',
    tags: Array.isArray(project?.tags) ? [...project.tags] : [],
    defaultAppId: typeof project?.defaultAppId === 'string' ? project.defaultAppId : ''
  };
}

/**
 * Who can use an admin project, as one decision instead of the two stored
 * flags `enabled` and `published`: `off` (nothing uses it), `apps` (the apps,
 * workflows and agents that link it), `everyone` (also everyone signed in).
 * A disabled project is `off` whatever `published` says: the server gives
 * nobody but admins access to it then.
 *
 * @param {{enabled?: boolean, published?: boolean}} project
 * @returns {'off'|'apps'|'everyone'}
 */
export function projectAvailability(project) {
  if (project?.enabled === false) return 'off';
  return project?.published === true ? 'everyone' : 'apps';
}

/**
 * The stored flags of an availability.
 *
 * @param {'off'|'apps'|'everyone'} availability
 * @returns {{enabled: boolean, published: boolean}}
 */
export function availabilityFlags(availability) {
  return { enabled: availability !== 'off', published: availability === 'everyone' };
}

/**
 * The id a new project gets from its name until the admin types one: the
 * English name, else the first one filled, as a safe id.
 *
 * @param {string|Object<string, string>} name
 * @returns {string}
 */
export function projectIdFromName(name) {
  const record = typeof name === 'string' ? { en: name } : name || {};
  const text = record.en?.trim() || Object.values(record).find(value => value?.trim()) || '';
  return slugify(text).slice(0, MAX_PROJECT_ID_LENGTH);
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
  // `new` is the route of the create form.
  if (
    value.startsWith(USER_PROJECT_ID_PREFIX) ||
    value.toLowerCase().startsWith(IFINDER_PROJECT_ID_PREFIX) ||
    value.toLowerCase() === 'new'
  ) {
    return 'reserved';
  }
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
    published: form.published === true,
    ...(category ? { category } : {}),
    tags: Array.isArray(form.tags) ? form.tags : [],
    ...(form.defaultAppId ? { defaultAppId: form.defaultAppId } : {})
  };
}

// --- uploads ------------------------------------------------------------------------

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
