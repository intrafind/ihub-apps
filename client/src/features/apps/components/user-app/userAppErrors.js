// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiErrorMessage } from '../../../../utils/apiErrorMessage';

/**
 * The request's own error behind an error of the API module
 * (`api/endpoints/userApps.js` rejects with the enhanced error, which keeps
 * the request's error on `originalError`).
 *
 * @param {unknown} error
 * @returns {unknown}
 */
const requestError = error => error?.originalError ?? error;

/**
 * The registry code of a failed call of the personal apps API.
 *
 * @param {unknown} error
 * @returns {string|undefined} For example `ETAG_MISMATCH`.
 */
export const userAppErrorCode = error =>
  error?.code ?? requestError(error)?.response?.data?.code ?? undefined;

/**
 * The HTTP status of a failed call of the personal apps API.
 *
 * @param {unknown} error
 * @returns {number|undefined}
 */
export const userAppErrorStatus = error => requestError(error)?.response?.status ?? error?.status;

/**
 * The reasons of a 409 `CONFLICT` of the personal apps API that have a text of
 * their own (`userApps.conflict.<reason>`). `CONFLICT` is a generic code, so
 * without this the reader would get the server's English sentence.
 */
const CONFLICT_REASONS = Object.freeze([
  'owner',
  'noDirectShare',
  'promoted',
  'disabled',
  'published',
  'idTaken'
]);

/**
 * The text of a 403 `PERMISSION_DENIED` of the personal apps API, by what the
 * server says was missing (`details.required`, and for sharing
 * `details.reason`). The code is shared with scheduled tasks and projects, so
 * its registry text says only that something is not allowed; these say what.
 *
 * @param {{required?: string, reason?: string}|undefined} details
 * @returns {string|undefined} An i18n key, or `undefined` for the generic text.
 */
function permissionDeniedKey(details) {
  switch (details?.required) {
    case 'publish':
      return 'userApps.denied.publish';
    case 'edit':
      return 'userApps.denied.edit';
    case 'userApps':
      return 'userApps.denied.userApps';
    case 'userAppSharing':
      return details.reason === 'ownerMayNotShare'
        ? 'userApps.denied.ownerMayNotShare'
        : 'userApps.denied.share';
    default:
      return undefined;
  }
}

/**
 * A failed call of the personal apps API as a sentence: the text of a known
 * conflict or refusal, else the text of its code (`apiErrors.<code>`), else the server's
 * own sentence.
 *
 * @param {unknown} error
 * @param {(key: string, options?: Object) => string} t
 * @returns {string}
 *
 * @example
 * setError(userAppErrorMessage(error, t)); // "Too many open offers."
 */
export function userAppErrorMessage(error, t) {
  // The server names the limit of open offers; the sentence then says what to do.
  const max = requestError(error)?.response?.data?.details?.max;
  if (userAppErrorCode(error) === 'QUOTA_USER_APP_OFFERS' && Number.isFinite(max)) {
    return t('userApps.transfer.tooMany', { max });
  }
  const reason = requestError(error)?.response?.data?.details?.reason;
  if (userAppErrorCode(error) === 'CONFLICT' && CONFLICT_REASONS.includes(reason)) {
    return t(`userApps.conflict.${reason}`);
  }
  if (userAppErrorCode(error) === 'PERMISSION_DENIED') {
    const key = permissionDeniedKey(requestError(error)?.response?.data?.details);
    if (key) return t(key);
  }
  return apiErrorMessage(requestError(error), t, t('admin.apps.errorTitle'));
}
