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
 * A failed call of the personal apps API as a sentence: the text of its code
 * (`apiErrors.<code>`), else the server's own sentence.
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
  return apiErrorMessage(requestError(error), t, t('admin.apps.errorTitle'));
}
