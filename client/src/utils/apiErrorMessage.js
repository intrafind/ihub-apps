// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { GENERIC_ERROR_CODES, apiErrorI18nKey } from '../../../shared/apiErrors.js';

/**
 * The message for a failed API request, localized from the response's `code`.
 *
 * A specific code (one that is not in `GENERIC_ERROR_CODES`) names what went wrong, so
 * its message is `t('apiErrors.<code>', details)`. A generic code (`BAD_REQUEST`,
 * `NOT_FOUND`, ...) says too little, so the English `detail` of the problem response is
 * shown. Without a code, the error's own message, then `fallback`.
 *
 * @param {unknown} error - A rejected axios request
 * @param {(key: string, options?: Object) => string} t - i18next `t`
 * @param {string} [fallback] - Shown when the response says nothing
 * @returns {string|undefined}
 */
export function apiErrorMessage(error, t, fallback) {
  const data = error?.response?.data;
  const code = data?.code;
  if (typeof code === 'string' && !Object.hasOwn(GENERIC_ERROR_CODES, code)) {
    const key = apiErrorI18nKey(code);
    const message = t(key, { ...data.details, defaultValue: data.detail || '' });
    if (message && message !== key) return message;
  }
  return data?.detail || error?.message || fallback;
}
