// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import errorHandler from '../../middleware/errorHandler.js';

/**
 * Run one route handler against a response double the way Express 5 does: an error it
 * throws, rejects with or passes to `next` is answered by the global error middleware.
 *
 * @param {Function} handler - The route's handler
 * @param {Object} req - Request double
 * @param {Object} res - Response double (needs `status`, `json` and `setHeader`)
 * @returns {Promise<void>}
 */
export async function runHandler(handler, req, res) {
  try {
    await handler(req, res, error => {
      if (error) throw error;
    });
  } catch (error) {
    errorHandler(error, req, res, () => {});
  }
}
