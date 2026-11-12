// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every `@swagger` block under `server/routes` is valid YAML. The API docs
 * (`server/utils/apiDocSpecs.js`) are built on first use without `failOnErrors`, so
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
import { apiDocGlobs } from '../utils/apiDocSpecs.js';

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes');

function buildSpec(apis) {
  return swaggerJSDoc({
    definition: { openapi: '3.0.0', info: { title: 'iHub', version: '0.0.0' } },
    apis,
    failOnErrors: true
  });
}

test('every @swagger block under server/routes parses', () => {
  // glob takes `/` only: a Windows `\` would read as an escape and match nothing.
  const spec = buildSpec([`${routesDir.split(path.sep).join('/')}/**/*.js`]);
  assert.ok(Object.keys(spec.paths).length > 0, 'no documented paths found');
  assert.ok(spec.paths['/api/admin/apps/integration-status'], 'integration-status is documented');
});

test('the API document globs use forward slashes, also for a Windows routes directory', () => {
  const globs = apiDocGlobs('C:\\ihub\\server\\routes', '\\');
  const all = [...globs.normal, ...globs.admin, ...globs.openai];
  assert.ok(all.length > 0);
  for (const pattern of all) {
    assert.ok(!pattern.includes('\\'), `backslash in ${pattern}`);
    assert.ok(pattern.startsWith('C:/ihub/server/routes/'), pattern);
  }
  assert.ok(globs.admin.includes('C:/ihub/server/routes/admin/**/*.js'));
});

test('each API document built from the server globs has paths', () => {
  const globs = apiDocGlobs(routesDir);
  for (const [name, apis] of Object.entries(globs)) {
    const spec = buildSpec(apis);
    assert.ok(Object.keys(spec.paths).length > 0, `${name} API document is empty`);
  }
});
