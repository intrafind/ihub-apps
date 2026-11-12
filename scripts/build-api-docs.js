#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Build the OpenAPI documents served under `/api/docs` and write them as JSON,
 * so the server reads them instead of running `swagger-jsdoc` (see
 * `server/utils/apiDocSpecs.js`).
 *
 * Fails — exit code 1 — on a malformed `@swagger` block, the same check as
 * `server/tests/api-docs-parse.test.js`, or on a document without paths.
 *
 * Usage:
 *   node scripts/build-api-docs.js [outputDir]
 *
 * `outputDir` defaults to `server/generated/openapi`; the production build
 * writes into `dist/server/generated/openapi`.
 */
import path from 'node:path';
import {
  GENERATED_API_DOCS_DIR,
  buildApiDocSpecs,
  writeApiDocSpecs
} from '../server/utils/apiDocSpecs.js';

const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : GENERATED_API_DOCS_DIR;

try {
  const specs = await buildApiDocSpecs({ failOnErrors: true });
  for (const [name, spec] of Object.entries(specs)) {
    const count = Object.keys(spec.paths || {}).length;
    if (count === 0) throw new Error(`The ${name} API document has no paths`);
    console.log(`API document ${name}: ${count} paths`);
  }
  for (const file of await writeApiDocSpecs(specs, outputDir)) {
    console.log(`Wrote ${path.relative(process.cwd(), file)}`);
  }
} catch (error) {
  console.error(`Building the API documents failed: ${error.message}`);
  process.exit(1);
}
