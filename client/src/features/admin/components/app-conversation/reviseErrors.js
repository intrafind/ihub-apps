// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which sentence a failed turn of the conversation shows
 * (`POST /api/admin/apps/_revise`, `POST /api/apps/_revise`). The sentence is
 * chosen from the `code` of the problem response, and for `RATE_LIMITED` from
 * `details.limiter`; never from a text. A code the map does not name shows the
 * response's `detail`, the server's own sentence in the caller's language.
 *
 * Every value is a full translation key, so the i18n test of the app builder
 * checks each one in English and German. Pure: no React, no request.
 *
 * @module features/admin/components/app-conversation/reviseErrors
 */

import { isCancelledRequest } from '../app-create/generateErrors';

/** The model was asked and gave no usable answer: trying again can help. */
const NOT_ANSWERED = 'admin.apps.conversation.error.model';
/** The model cannot answer as it is configured: trying again cannot help. */
const NOT_SET_UP = 'admin.apps.conversation.error.modelSetup';

/** The name of the turn limit in `details.limiter` of a 429 answer. */
export const APP_REVISE_LIMITER = 'appRevise';

/**
 * Response `code` to message key. `null` means "show nothing" (the author
 * pressed Cancel). `RATE_LIMITED` is also the code of a throttled model
 * provider, so its message is picked by `details.limiter`;
 * `APP_GENERATOR_INVALID_ANSWER` by `details.reason`; `APP_REVISE_TOO_LONG` by
 * `details.field`. `other` stands for a
 * response without that detail.
 */
export const REVISE_ERROR_KEYS = Object.freeze({
  VALIDATION_FAILED: 'admin.apps.conversation.error.invalid',
  APP_GENERATOR_NO_MODEL: 'admin.apps.conversation.error.noModel',
  // Picked by `details.reason`: `not-json`, `truncated` or `incomplete`.
  APP_GENERATOR_INVALID_ANSWER: Object.freeze({
    truncated: 'admin.apps.conversation.error.truncated',
    other: 'admin.apps.conversation.error.unreadable'
  }),
  // Picked by `details.field`: the instructions, or any other content key.
  APP_REVISE_TOO_LONG: Object.freeze({
    system: 'admin.apps.conversation.error.tooLong',
    other: 'admin.apps.conversation.error.contentTooLong'
  }),
  QUOTA_EXCEEDED: 'admin.apps.conversation.error.quota',
  FEATURE_DISABLED: 'admin.apps.conversation.error.off',
  USER_APPS_DISABLED: 'admin.apps.conversation.error.userAppsOff',
  NETWORK: NOT_ANSWERED,
  PROVIDER_ERROR: NOT_ANSWERED,
  EMPTY_RESPONSE: NOT_ANSWERED,
  TIMEOUT: NOT_ANSWERED,
  AUTH_FAILED: NOT_SET_UP,
  MODEL_NOT_FOUND: NOT_SET_UP,
  INVALID_REQUEST: NOT_SET_UP,
  CONTEXT_WINDOW_EXCEEDED: NOT_SET_UP,
  CONTENT_POLICY: 'admin.apps.conversation.error.refused',
  RATE_LIMITED: Object.freeze({
    [APP_REVISE_LIMITER]: 'admin.apps.conversation.error.tooManyTurns',
    other: 'admin.apps.conversation.error.busy'
  }),
  ABORTED: null
});

/** The messages no response code picks: the browser's own timeout, and every other code. */
export const REVISE_CLIENT_ERROR_KEYS = Object.freeze({
  timeout: NOT_ANSWERED,
  other: 'admin.apps.conversation.error.failed'
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
 * The message for a failed turn.
 *
 * @param {unknown} error - What the request rejected with: an axios error, or
 *   any object with `code`, `details` and `detail`.
 * @returns {{ key: string, values?: { detail: string } } | null} `null` when
 *   nothing is to be shown (the author cancelled).
 *
 * @example
 * reviseErrorMessage({ response: { data: { code: 'RATE_LIMITED', details: { limiter: 'appRevise' } } } });
 * // → { key: 'admin.apps.conversation.error.tooManyTurns' }
 */
export function reviseErrorMessage(error) {
  if (isCancelledRequest(error)) return null;

  const problem = problemOf(error);
  const code = typeof problem.code === 'string' ? problem.code : '';

  if (Object.hasOwn(REVISE_ERROR_KEYS, code)) {
    const entry = REVISE_ERROR_KEYS[code];
    if (entry === null) return null;
    if (typeof entry === 'string') return { key: entry };
    const details = isRecord(problem.details) ? problem.details : {};
    const reason =
      code === 'RATE_LIMITED'
        ? details.limiter
        : code === 'APP_REVISE_TOO_LONG'
          ? details.field
          : details.reason;
    const picked = typeof reason === 'string' && Object.hasOwn(entry, reason) ? reason : 'other';
    return { key: entry[picked] };
  }

  if (!error?.response && TIMEOUT_CODES.has(code)) {
    return { key: REVISE_CLIENT_ERROR_KEYS.timeout };
  }

  const detail = typeof problem.detail === 'string' ? problem.detail.trim() : '';
  return { key: REVISE_CLIENT_ERROR_KEYS.other, values: { detail } };
}
