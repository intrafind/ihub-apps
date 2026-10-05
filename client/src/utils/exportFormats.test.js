#!/usr/bin/env node

/**
 * Tests for the download filename helpers in `exportFormats.js`.
 *
 * The export files themselves are generated on the server (`POST
 * /api/exports`, EU AI Act Art. 50); the browser only names a download when
 * the response carries no `Content-Disposition` filename, and date-stamps
 * other saved files (e.g. the `/verify` report). The server-side renderers
 * have their own tests (spreadsheet formula injection included).
 *
 * Run directly: `node client/src/utils/exportFormats.test.js`.
 */

import {
  EXPORT_FILE_EXTENSIONS,
  buildExportFallbackFilename,
  formatDateTimeForFilename,
  slugifyForFilename
} from './exportFormats.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 slugifyForFilename\n');

check(
  'markdown markers and punctuation collapse into single dashes',
  slugifyForFilename('**Pricing** discussion: Q3?') === 'pricing-discussion-q3'
);
check(
  'accents are stripped',
  slugifyForFilename('Überprüfung für Äpfel') === 'uberprufung-fur-apfel'
);
check(
  'fenced code is dropped',
  slugifyForFilename('Fix ```const a = 1;``` please') === 'fix-please'
);
check('links keep their text', slugifyForFilename('[Docs](https://x.y) page') === 'docs-page');
check(
  'the slug is capped without a trailing dash',
  slugifyForFilename('aaaa bbbb cccc', 6) === 'aaaa-b' &&
    !slugifyForFilename('aaaa bbbb', 5).endsWith('-')
);
check(
  'non-strings yield an empty slug',
  slugifyForFilename(null) === '' && slugifyForFilename(42) === ''
);

console.log('\n🧪 formatDateTimeForFilename\n');

const fixed = new Date(2026, 5, 9, 15, 3);
check(
  'formats local time as YYYY-MM-DD_HHmm',
  formatDateTimeForFilename(fixed) === '2026-06-09_1503',
  formatDateTimeForFilename(fixed)
);

console.log('\n🧪 buildExportFallbackFilename\n');

check(
  'title slug, date stamp and format extension',
  buildExportFallbackFilename({
    title: 'Sales Assistant — Pricing',
    format: 'pdf',
    date: fixed
  }) === 'sales-assistant-pricing-2026-06-09_1503.pdf'
);
check(
  'markdown maps to the .md extension',
  buildExportFallbackFilename({ title: 'Notes', format: 'markdown', date: fixed }).endsWith('.md')
);
check(
  'a missing title falls back to "export"',
  buildExportFallbackFilename({ format: 'docx', date: fixed }) === 'export-2026-06-09_1503.docx'
);
check(
  'every server export format has an extension',
  ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'markdown', 'html', 'json', 'jsonl'].every(
    format => typeof EXPORT_FILE_EXTENSIONS[format] === 'string'
  )
);

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
