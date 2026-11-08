// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helper for route drivers that call handlers directly: write the answer the global error
 * middleware gives for `error` onto a response double (`statusCode`, `body`, `headers`).
 */
import { toErrorResponse } from '../../utils/errorResponse.js';

/**
 * @param {{statusCode?: number, body?: unknown, headers?: Object}} res - A response double
 * @param {unknown} error - What a handler threw or passed to `next`
 * @returns {object} `res`
 */
export function answerWithError(res, error) {
  const { status, body, headers } = toErrorResponse(error);
  res.statusCode = status;
  res.body = body;
  res.headers = res.headers || {};
  for (const [name, value] of Object.entries(headers)) res.headers[name.toLowerCase()] = value;
  return res;
}
