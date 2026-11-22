// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What can be wrong with a new app before and after the create request, as
 * message keys: the checks the page runs itself, and the reading of the
 * server's answer (`application/problem+json`). Nothing here looks at a
 * message text; the server's `code`, its status and the paths of its
 * validation errors decide.
 *
 * A field error is `{ key, values }` for `t(key, values)`. A field the
 * server refused has `key: null`: the summary names it, and the server's
 * English wording is not shown.
 *
 * Pure: no React, no browser API, no request.
 *
 * @module features/admin/components/app-create/createErrors
 */

import { appIdProblem, slugifyAppId } from '../../../../../../shared/appId.js';

/** The messages of the create step, by case (plan section 4.4). */
export const CREATE_ERROR_KEYS = Object.freeze({
  nameRequired: 'admin.apps.create.error.nameRequired',
  descriptionRequired: 'admin.apps.create.error.descriptionRequired',
  instructionsRequired: 'admin.apps.create.error.instructionsRequired',
  idRequired: 'admin.apps.create.error.idRequired',
  idFormat: 'admin.apps.create.error.idFormat',
  idTooLong: 'admin.apps.create.error.idTooLong',
  idTaken: 'admin.apps.create.error.idTaken',
  idReserved: 'admin.apps.create.error.idReserved',
  urlFormat: 'admin.apps.create.error.urlFormat',
  /** Plural: call it with `count`. */
  summary: 'admin.apps.create.error.summary',
  validation: 'admin.apps.create.error.validation',
  forbidden: 'admin.apps.create.error.forbidden',
  offline: 'admin.apps.create.error.offline',
  unknown: 'admin.apps.create.error.unknown'
});

/** The key for each answer of `appIdProblem` (`shared/appId.js`). */
const ID_PROBLEM_KEYS = Object.freeze({
  required: CREATE_ERROR_KEYS.idRequired,
  tooLong: CREATE_ERROR_KEYS.idTooLong,
  format: CREATE_ERROR_KEYS.idFormat,
  reserved: CREATE_ERROR_KEYS.idReserved
});

/** The ID shown as an example when the author's name yields none. */
const EXAMPLE_APP_ID = 'my-app';

/** The top-level key of an app that each field of the screen edits. */
const FIELD_OF_APP_KEY = Object.freeze({
  name: 'name',
  description: 'description',
  system: 'system',
  id: 'id',
  category: 'category',
  icon: 'icon',
  color: 'color',
  type: 'mode',
  iframeConfig: 'url',
  redirectConfig: 'url'
});

const hasText = value => typeof value === 'string' && value.trim() !== '';

/**
 * Whether the draft is a link app: a link to a website, or a website shown
 * inside iHub. Such an app has a website address and no instructions.
 *
 * @param {object|null|undefined} draft
 * @returns {boolean}
 */
export function isLinkDraft(draft) {
  return draft?.type === 'redirect' || draft?.type === 'iframe';
}

/**
 * The website address of a link draft, wherever its type keeps it.
 *
 * @param {object|null|undefined} draft
 * @returns {string}
 */
export function linkUrlOf(draft) {
  const config = draft?.type === 'iframe' ? draft?.iframeConfig : draft?.redirectConfig;
  return typeof config?.url === 'string' ? config.url : '';
}

/**
 * Whether a text is a full http(s) address, the only kind the app schema
 * accepts for a link app.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWebAddress(value) {
  if (!hasText(value) || /\s/.test(value.trim())) return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * The problem of an app ID as a field error, or null.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {(id: string) => boolean} [options.isTaken] - Whether an app has this ID.
 * @param {string} [options.name] - The app's name, for the example in the format message.
 * @returns {{ key: string, values: object }|null}
 */
export function idError(id, { isTaken, name } = {}) {
  const problem = appIdProblem(id);
  if (problem) {
    return {
      key: ID_PROBLEM_KEYS[problem],
      values: { id, example: slugifyAppId(name) || slugifyAppId(id) || EXAMPLE_APP_ID }
    };
  }
  if (typeof isTaken === 'function' && isTaken(id.toLowerCase())) {
    return { key: CREATE_ERROR_KEYS.idTaken, values: { id } };
  }
  return null;
}

/**
 * The checks the page runs before it sends anything.
 *
 * Name and short description are required in the language the screen edits.
 * A chat app needs instructions: the server does not ask for them, but an app
 * without instructions is the plain chat. A link app needs a full website
 * address instead.
 *
 * @param {object} draft - The app as the author sees it.
 * @param {object} options
 * @param {string} options.language - The language the screen edits.
 * @param {(id: string) => boolean} [options.isTaken] - Whether an app has this ID.
 * @param {boolean} [options.instructionsOptional=false] - A copy of an app
 *   that has no instructions may stay without them.
 * @param {boolean} [options.idFollowsName=false] - The author never edited
 *   the ID. While there is no name there is no ID either, and the missing
 *   name is the one thing to say.
 * @returns {Object<string, { key: string, values: object }>} Field errors by
 *   field; empty when the draft can be sent.
 */
export function validateDraft(
  draft,
  { language, isTaken, instructionsOptional = false, idFollowsName = false } = {}
) {
  const errors = {};
  const textOf = field => draft?.[field]?.[language];

  if (!hasText(textOf('name'))) {
    errors.name = { key: CREATE_ERROR_KEYS.nameRequired, values: {} };
  }
  if (!hasText(textOf('description'))) {
    errors.description = { key: CREATE_ERROR_KEYS.descriptionRequired, values: {} };
  }
  if (isLinkDraft(draft)) {
    if (!isWebAddress(linkUrlOf(draft))) {
      errors.url = { key: CREATE_ERROR_KEYS.urlFormat, values: {} };
    }
  } else if (!instructionsOptional && !hasText(textOf('system'))) {
    errors.system = { key: CREATE_ERROR_KEYS.instructionsRequired, values: {} };
  }

  const id = typeof draft?.id === 'string' ? draft.id.trim() : '';
  if (id === '' && idFollowsName && errors.name) return errors;
  const problem = idError(id, { isTaken, name: textOf('name') });
  if (problem) errors.id = problem;
  return errors;
}

/** The first segment of a JSON pointer (`/name/en`) or of a dotted path (`name.en`). */
function firstSegment(path) {
  return String(path ?? '')
    .split(/[/.]/)
    .find(segment => segment !== '');
}

/** A JSON pointer or a dotted path as the dotted path an admin knows from the config. */
function dottedPath(path) {
  return String(path ?? '')
    .split(/[/.]/)
    .filter(segment => segment !== '')
    .join('.');
}

/**
 * The places a validation answer names. The server sends them as
 * `errors[].pointer` (RFC 9457); `details.issues[].path` is read too.
 *
 * @param {object|undefined} problem - The response body.
 * @returns {string[]}
 */
function refusedPaths(problem) {
  const listed = Array.isArray(problem?.errors) ? problem.errors : [];
  const issues = Array.isArray(problem?.details?.issues) ? problem.details.issues : [];
  return [
    ...listed.map(entry => entry?.pointer),
    ...issues.map(entry => entry?.path ?? entry?.field)
  ].filter(path => typeof path === 'string' && path !== '');
}

/**
 * What a failed create request means for the page.
 *
 * @param {unknown} error - The rejected request (an axios error).
 * @param {object} [options]
 * @param {string} [options.id] - The ID that was sent.
 * @param {(field: string) => string} [options.labelOf] - The label of a field
 *   of the screen, for the list of refused entries.
 * @param {(error: unknown) => string} [options.detailOf] - The server's own
 *   sentence for an answer the page has no message for.
 * @returns {{
 *   conflict: boolean,
 *   fields: Object<string, { key: string|null, values: object }>,
 *   general: { key: string, values: object }|null
 * }} `conflict` is true when the ID is taken; `fields` marks fields;
 *   `general` is the message for the summary.
 */
export function readCreateFailure(error, { id = '', labelOf, detailOf } = {}) {
  const response = error?.response;
  if (!response) {
    return {
      conflict: false,
      fields: {},
      general: { key: CREATE_ERROR_KEYS.offline, values: {} }
    };
  }
  const problem = response.data;
  const status = response.status;
  const code = problem?.code;

  if (status === 409 || code === 'CONFLICT') {
    return {
      conflict: true,
      fields: { id: { key: CREATE_ERROR_KEYS.idTaken, values: { id } } },
      general: null
    };
  }
  if (status === 401 || status === 403) {
    return {
      conflict: false,
      fields: {},
      general: { key: CREATE_ERROR_KEYS.forbidden, values: {} }
    };
  }

  const paths = refusedPaths(problem);
  if (status === 400 && paths.length > 0) {
    const fields = {};
    const names = [];
    for (const path of paths) {
      const field = FIELD_OF_APP_KEY[firstSegment(path)];
      if (field) fields[field] = { key: null, values: {} };
      const name = field ? (labelOf ? labelOf(field) : field) : dottedPath(path);
      if (name && !names.includes(name)) names.push(name);
    }
    return {
      conflict: false,
      fields,
      general: { key: CREATE_ERROR_KEYS.validation, values: { fields: names.join(', ') } }
    };
  }

  const detail = detailOf ? detailOf(error) : problem?.detail;
  return {
    conflict: false,
    fields: {},
    general: {
      key: CREATE_ERROR_KEYS.unknown,
      values: { detail: typeof detail === 'string' ? detail : '' }
    }
  };
}
