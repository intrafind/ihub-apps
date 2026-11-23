// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which message a failed draft shows (`POST /api/admin/apps/_generate`). The
 * message is chosen from the `code` of the problem response, and for
 * `RATE_LIMITED` from `details.limiter`; never from a text.
 *
 * Every value is a full translation key, so the i18n test of the app builder
 * can check that each one is a text in English and German. Pure: no React, no
 * request, and no function modifies its argument.
 *
 * @module features/admin/components/app-create/generateErrors
 */

import {
  APP_GENERATOR_DESCRIPTION_MAX,
  APP_GENERATOR_LIMITER
} from '../../../../../../shared/appGenerator.js';

/** The model was asked and gave no usable sign of life: trying again can help. */
const NOT_ANSWERED = 'admin.apps.create.error.model';
/** The model cannot answer as it is configured: trying again cannot help. */
const NOT_SET_UP = 'admin.apps.create.error.modelSetup';

/**
 * Response `code` to message key. `null` means "show nothing". `RATE_LIMITED`
 * is the code of the draft limit, of the admin limit and of a throttled model
 * provider, so its message is picked by `details.limiter`; `other` stands for
 * a response without that detail.
 */
export const GENERATE_ERROR_KEYS = Object.freeze({
  APP_GENERATOR_NO_MODEL: 'admin.apps.create.error.noModel',
  APP_GENERATOR_INVALID_ANSWER: 'admin.apps.create.error.unreadable',
  NETWORK: NOT_ANSWERED,
  PROVIDER_ERROR: NOT_ANSWERED,
  EMPTY_RESPONSE: NOT_ANSWERED,
  TIMEOUT: NOT_ANSWERED,
  AUTH_FAILED: NOT_SET_UP,
  MODEL_NOT_FOUND: NOT_SET_UP,
  INVALID_REQUEST: NOT_SET_UP,
  CONTEXT_WINDOW_EXCEEDED: NOT_SET_UP,
  QUOTA_EXCEEDED: 'admin.apps.create.error.quota',
  CONTENT_POLICY: 'admin.apps.create.error.refused',
  RATE_LIMITED: Object.freeze({
    [APP_GENERATOR_LIMITER]: 'admin.apps.create.error.tooManyDrafts',
    other: 'admin.apps.create.error.busy'
  }),
  FEATURE_DISABLED: 'admin.apps.create.generatorOff',
  // The author pressed Cancel.
  ABORTED: null
});

/**
 * The messages that no response code picks: the request's own timeout, the
 * two checks of the description before a request is sent, and every code the
 * map above does not name (`other`, which takes the response's `detail`).
 */
export const GENERATE_CLIENT_ERROR_KEYS = Object.freeze({
  timeout: NOT_ANSWERED,
  empty: 'admin.apps.create.error.empty',
  tooLong: 'admin.apps.create.error.tooLong',
  other: 'admin.apps.create.error.failed'
});

/** What axios reports when the request ran into its own timeout. */
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The problem body of a failed request, or of an error that already carries its fields. */
function problemOf(error) {
  const data = error?.response?.data ?? error?.originalError?.response?.data;
  if (isRecord(data)) return data;
  return isRecord(error) ? error : {};
}

/**
 * True when the request was stopped in the browser (an aborted `AbortSignal`)
 * and not answered by the server.
 *
 * @param {unknown} error - What the request rejected with.
 * @returns {boolean}
 */
export function isCancelledRequest(error) {
  if (!isRecord(error) || error.response) return false;
  return (
    error.code === 'ERR_CANCELED' ||
    error.code === 'aborted' ||
    error.name === 'CanceledError' ||
    error.name === 'AbortError'
  );
}

/**
 * The message for a failed draft.
 *
 * @param {unknown} error - What the request rejected with: an axios error, or
 *   any object with `code`, `details` and `detail`.
 * @returns {{ key: string, values?: { detail: string } } | null} `null` when
 *   nothing is to be shown (the author cancelled).
 *
 * @example
 * generateErrorMessage({ response: { data: { code: 'RATE_LIMITED', details: { limiter: 'appGenerator' } } } });
 * // → { key: 'admin.apps.create.error.tooManyDrafts' }
 */
export function generateErrorMessage(error) {
  if (isCancelledRequest(error)) return null;

  const problem = problemOf(error);
  const code = typeof problem.code === 'string' ? problem.code : '';

  if (Object.hasOwn(GENERATE_ERROR_KEYS, code)) {
    const entry = GENERATE_ERROR_KEYS[code];
    if (entry === null) return null;
    if (typeof entry === 'string') return { key: entry };
    const limiter = isRecord(problem.details) ? problem.details.limiter : undefined;
    const picked = typeof limiter === 'string' && Object.hasOwn(entry, limiter) ? limiter : 'other';
    return { key: entry[picked] };
  }

  if (!error?.response && TIMEOUT_CODES.has(code)) {
    return { key: GENERATE_CLIENT_ERROR_KEYS.timeout };
  }

  // `detail` is the server's own sentence, already in the caller's language.
  const detail = typeof problem.detail === 'string' ? problem.detail.trim() : '';
  return { key: GENERATE_CLIENT_ERROR_KEYS.other, values: { detail } };
}

/**
 * Why a description cannot be sent, checked before the request. Its length
 * is counted as the server counts it: after trimming.
 *
 * @param {unknown} description
 * @returns {{ key: string } | null}
 */
export function descriptionProblem(description) {
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) return { key: GENERATE_CLIENT_ERROR_KEYS.empty };
  if (text.length > APP_GENERATOR_DESCRIPTION_MAX) {
    return { key: GENERATE_CLIENT_ERROR_KEYS.tooLong };
  }
  return null;
}
