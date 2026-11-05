// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../utils/logger.js';
import { toErrorResponse } from '../utils/errorResponse.js';

/** Endpoints that answer in the RFC 6749 shape, with or without a base path. */
const RFC_ERROR_PATH = /(^|\/)(api\/oauth|\.well-known)(\/|$)/;

/**
 * The global Express error middleware: the one place an error becomes an HTTP
 * response. Register it after every route. Express 5 forwards the rejection of
 * an async handler here, so a handler only needs to throw.
 *
 * @param {unknown} error
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export default function errorHandler(error, req, res, next) {
  // The response has started: all that is left is Express's own handling,
  // which closes the connection.
  if (res.headersSent) return next(error);

  const { status, body, headers } = toErrorResponse(error, {
    rfc: RFC_ERROR_PATH.test(req.path || '')
  });

  if (status >= 500) {
    logger.error('Request failed', {
      component: 'ErrorHandler',
      method: req.method,
      path: req.path,
      status,
      error
    });
  } else {
    logger.debug('Request rejected', {
      component: 'ErrorHandler',
      method: req.method,
      path: req.path,
      status,
      code: body.code ?? body.error
    });
  }

  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  return res.status(status).json(body);
}
