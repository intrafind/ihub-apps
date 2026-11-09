// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `toDocumentServiceError` maps the document services' own errors to the
 * ServiceError the global error middleware answers with.
 */
import { toDocumentServiceError } from '../services/documents/documentHttpErrors.js';
import { ServiceError } from '../utils/ServiceError.js';
import { DocumentGenerationError } from '../services/documents/renderService.js';
import { DocumentTemplateError } from '../services/documents/templates/DocumentTemplateService.js';

describe('toDocumentServiceError', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE']
  ])('maps a DocumentTemplateError with status %i to %s', (status, code) => {
    const source = new DocumentTemplateError('template problem', status);
    const result = toDocumentServiceError(source);
    expect(result).toBeInstanceOf(ServiceError);
    expect(result.code).toBe(code);
    expect(result.status).toBe(status);
    expect(result.message).toBe('template problem');
  });

  it('maps a busy generation error to SERVICE_UNAVAILABLE (503)', () => {
    const result = toDocumentServiceError(new DocumentGenerationError('busy now', 'busy'));
    expect(result).toBeInstanceOf(ServiceError);
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.status).toBe(503);
  });

  it('maps a timed out generation error to TIMEOUT (504)', () => {
    const result = toDocumentServiceError(new DocumentGenerationError('too slow', 'timeout'));
    expect(result).toBeInstanceOf(ServiceError);
    expect(result.code).toBe('TIMEOUT');
    expect(result.status).toBe(504);
  });

  it.each(['invalid', 'failed'])('maps a %s generation error to 422 BAD_REQUEST', code => {
    const result = toDocumentServiceError(new DocumentGenerationError('bad input', code));
    expect(result).toBeInstanceOf(ServiceError);
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.status).toBe(422);
    expect(result.message).toBe('bad input');
  });

  it('returns an unrelated error unchanged', () => {
    const error = new Error('boom');
    expect(toDocumentServiceError(error)).toBe(error);
  });
});
