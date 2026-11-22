// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { ServiceError } from '../utils/ServiceError.js';

/**
 * The answer to an API path no route serves: a 404 problem+json body with the
 * code `NOT_FOUND` (docs/api-guidelines.md), not the framework's HTML page.
 * Registered after every route, so it only sees what nothing else answered;
 * the global error handler writes the body (the OAuth paths keep their RFC 6749
 * shape there).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export default function apiNotFound(req, _res, next) {
  next(new ServiceError('NOT_FOUND', `No API endpoint answers ${req.method} ${req.originalUrl}`));
}
