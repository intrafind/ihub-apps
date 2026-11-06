// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { API_ERROR_CODES } from '../../shared/apiErrors.js';

/**
 * An error a route can answer with: a registry code, a message for developers
 * and callers without i18n, and structured details for the client's message.
 *
 * Services throw it (or a subclass); the global error middleware turns it into
 * the response. For a 4xx the message is sent as `error`, so write it to be shown.
 */
/** A non-empty list of objects that each carry a `message`: validation problems. */
function isProblemList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(entry => entry && typeof entry === 'object' && typeof entry.message === 'string')
  );
}

export class ServiceError extends Error {
  /**
   * @param {string} code - A code of `shared/apiErrors.js`
   * @param {string} message - What went wrong
   * @param {Object} [options]
   * @param {number} [options.status] - HTTP status; default is the code's
   * @param {Object} [options.details] - Interpolation parameters for the client's message
   * @param {unknown} [options.cause] - The underlying error, kept for logging
   */
  constructor(code, message, { status, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ServiceError';
    this.code = code;
    this.status = Number.isInteger(status) ? status : (API_ERROR_CODES[code] ?? 500);
    if (details !== undefined) {
      const plain = details && typeof details === 'object' && !Array.isArray(details);
      if (plain) this.details = details;
      // A list of problems (Zod issues, `{ field, message }`) is answered as `errors`; any other
      // list or value is kept as `details.value`.
      else this.details = isProblemList(details) ? { issues: details } : { value: details };
    }
  }
}
