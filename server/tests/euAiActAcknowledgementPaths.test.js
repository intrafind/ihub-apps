// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The acknowledgement APIs live under `eu-ai-act` (step 9). The old layout never
// shipped, so there is no shim: a leftover caller of an old path would 404.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'contents',
  'test-results'
]);
const SCAN_ROOTS = ['server', 'client', 'shared', 'tests', 'docs', 'scripts'];
const EXT = /\.(js|jsx|mjs|cjs|ts|tsx|json|md)$/;
// The CSV download keeps its file name; only URL paths are checked.
const OLD_PATHS = [
  /\/ai-acknowledgements\/me\b/,
  /\/ai-acknowledgements\/_/,
  /(?<!eu-ai-act\/)\/ai-acknowledgements['"`)\s]/,
  /auth\/users\/[^'"`\s]*ai-acknowledgements/
];
const SELF = path.relative(root, fileURLToPath(import.meta.url));

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXT.test(entry.name)) yield full;
  }
}

test('invariant: no caller or doc uses an old acknowledgement path', () => {
  const offenders = [];
  for (const base of SCAN_ROOTS) {
    const start = path.join(root, base);
    if (!fs.existsSync(start)) continue;
    for (const file of walk(start)) {
      const rel = path.relative(root, file);
      // The release notes name the removed paths, as the route check requires.
      if (rel === SELF || rel.startsWith('docs/releases/')) continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (OLD_PATHS.some(re => re.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'use /api/eu-ai-act/acknowledgements/... and /api/admin/eu-ai-act/...'
  );
});
