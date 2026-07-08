#!/usr/bin/env node

/**
 * Tests for spreadsheet-formula-injection sanitization in chat exports.
 *
 * exportToCSV/exportToXLSX write message content (LLM output, pasted user
 * text) directly into spreadsheet cells. Values starting with =, +, -, @,
 * tab, or CR are interpreted as formulas by Excel/LibreOffice on open — a
 * classic CSV-injection vector. sanitizeForSpreadsheet neutralizes this by
 * prefixing such values with a single quote (OWASP guidance).
 *
 * Run directly: `node client/src/utils/exportFormats.test.js`.
 */

import { sanitizeForSpreadsheet } from './exportFormats.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 sanitizeForSpreadsheet\n');

check(
  'formula starting with = gets a leading quote',
  sanitizeForSpreadsheet('=HYPERLINK("http://evil","click")') ===
    '\'=HYPERLINK("http://evil","click")'
);
check('value starting with + gets a leading quote', sanitizeForSpreadsheet('+1234') === "'+1234");
check(
  'value starting with - gets a leading quote',
  sanitizeForSpreadsheet('-cmd|calc') === "'-cmd|calc"
);
check(
  'value starting with @ gets a leading quote',
  sanitizeForSpreadsheet('@SUM(1)') === "'@SUM(1)"
);
check(
  'value starting with a tab gets a leading quote',
  sanitizeForSpreadsheet('\t=1+1') === "'\t=1+1"
);
check(
  'value starting with a carriage return gets a leading quote',
  sanitizeForSpreadsheet('\r=1+1') === "'\r=1+1"
);

check('plain text is left unchanged', sanitizeForSpreadsheet('Hello, world!') === 'Hello, world!');
check(
  'text mentioning a formula mid-string is left unchanged',
  sanitizeForSpreadsheet('the result was =5') === 'the result was =5'
);

check('null becomes empty string', sanitizeForSpreadsheet(null) === '');
check('undefined becomes empty string', sanitizeForSpreadsheet(undefined) === '');
check('empty string stays empty', sanitizeForSpreadsheet('') === '');

check(
  'sanitized formula still combines correctly with CSV comma/quote escaping',
  (() => {
    // Mirrors exportToCSV's escapeCSV: sanitize first, then quote-wrap if needed.
    const escapeCSV = value => {
      const stringValue = sanitizeForSpreadsheet(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };
    return escapeCSV('=1,2') === '"\'=1,2"';
  })()
);

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
