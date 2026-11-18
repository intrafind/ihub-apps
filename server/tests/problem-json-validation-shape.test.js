// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shape of a validation failure as the client reads it: RFC 9457
 * problem+json with one `errors[]` entry per field, each an RFC 6901 JSON
 * Pointer plus a `code` and an English `message` (docs/api-guidelines.md).
 *
 * The serialized answer must equal `tests/contract/problem-validation.json`;
 * the client test of `mapProblemErrorsToFields` reads the same file, so a
 * change of shape on either side fails a test (IN-B4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toErrorResponse } from '../utils/errorResponse.js';
import { ServiceError } from '../utils/ServiceError.js';
import { checkInstallValues } from '../validators/integrationDefinitionSchema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, '../../tests/contract/problem-validation.json'), 'utf8')
);

const definition = {
  install: [
    { key: 'baseUrl', type: 'url', scope: 'admin', required: true, title: { en: 'URL' } },
    { key: 'maxRows', type: 'number', scope: 'admin', min: 1, max: 50, title: { en: 'Rows' } }
  ]
};

test('invalid install values serialize to errors[] with pointers, codes and messages', () => {
  // As InstalledIntegrationService (IntegrationError, a ServiceError) answers a
  // failed install or test; the route test in integrations/adminRoutes.test.js
  // covers the same answer end to end.
  const valueErrors = checkInstallValues(definition, { maxRows: 99 });
  const error = new ServiceError('INVALID_VALUES', 'Invalid install values', {
    details: {
      issues: valueErrors.map(({ kind, key, message }) => ({
        path: ['values', key],
        code: kind,
        message
      }))
    }
  });

  const { status, body, headers } = toErrorResponse(error);
  expect(status).toBe(400);
  expect(headers['Content-Type']).toBe('application/problem+json');
  expect(body).toEqual(fixture);
  // The issues move to `errors`; nothing is left under `details.issues`.
  expect(body.details).toBeUndefined();
});
