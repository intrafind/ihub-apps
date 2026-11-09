// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The error `validateAndPersistExternalUser` throws for a deactivated account, and the check for it.
 * Callers tell it apart by its `code`, not by its message text.
 *
 * @module utils/accountDisabledError
 */

/** The `code` of an {@link AccountDisabledError}. */
export const ACCOUNT_DISABLED = 'ACCOUNT_DISABLED';

/** A sign-in refused because the user's account is deactivated. */
export class AccountDisabledError extends Error {
  /**
   * @param {{id?: string, email?: string}} user - The deactivated account
   */
  constructor(user) {
    super(
      `User account is disabled. User ID: ${user.id}, Email: ${user.email}. Please contact your administrator.`
    );
    this.name = 'AccountDisabledError';
    this.code = ACCOUNT_DISABLED;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean} Whether `error` is an {@link AccountDisabledError}
 */
export function isAccountDisabledError(error) {
  return error?.code === ACCOUNT_DISABLED;
}
