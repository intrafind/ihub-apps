// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every `@swagger` block under `server/routes` is valid YAML. The API docs
 * (`server/routes/swagger.js`) are built at startup without `failOnErrors`, so
 * a broken block only logs "Error in <file>: YAMLSemanticError …" and its
 * endpoint is missing from /api/docs. A value such as
 * `description: e.g. {"a": true}` is the usual cause: it reads as a nested
 * mapping unless it is quoted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerJSDoc from 'swagger-jsdoc';

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes');

function buildSpec(apis) {
  return swaggerJSDoc({
    definition: { openapi: '3.0.0', info: { title: 'iHub', version: '0.0.0' } },
    apis,
    failOnErrors: true
  });
}

test('every @swagger block under server/routes parses', () => {
  const spec = buildSpec([path.join(routesDir, '**/*.js')]);
  assert.ok(Object.keys(spec.paths).length > 0, 'no documented paths found');
  assert.ok(spec.paths['/api/admin/apps/integration-status'], 'integration-status is documented');
});
