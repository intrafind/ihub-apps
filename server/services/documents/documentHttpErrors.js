// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { ServiceError } from '../../utils/ServiceError.js';
import { DocumentGenerationError } from './renderService.js';
import { DocumentTemplateError } from './templates/DocumentTemplateService.js';

const TEMPLATE_STATUS_CODES = { 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE' };

/**
 * Maps the document services' own errors to the {@link ServiceError} the global error
 * middleware answers with, keeping each one's HTTP status. Any other error is returned
 * unchanged so the caller decides (log it, answer 500).
 *
 * @param {unknown} error
 * @returns {unknown} a ServiceError for a document error, otherwise `error`
 */
export function toDocumentServiceError(error) {
  if (error instanceof DocumentTemplateError) {
    return new ServiceError(TEMPLATE_STATUS_CODES[error.status] || 'BAD_REQUEST', error.message, {
      status: error.status,
      cause: error
    });
  }
  if (error instanceof DocumentGenerationError) {
    if (error.code === 'busy') return new ServiceError('SERVICE_UNAVAILABLE', error.message);
    if (error.code === 'timeout') return new ServiceError('TIMEOUT', error.message);
    return new ServiceError('BAD_REQUEST', error.message, { status: 422, cause: error });
  }
  return error;
}
