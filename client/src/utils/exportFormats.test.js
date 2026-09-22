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

import { sanitizeForSpreadsheet, getExportSettingsRows } from './exportFormats.js';

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
      if (/[",\r\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };
    return escapeCSV('=1,2') === '"\'=1,2"';
  })()
);

console.log('\n🧪 getExportSettingsRows\n');

// ExportDialog always passes an object whose fields may all be undefined;
// exporters must not emit an empty "Settings" section for it (#2452).
check(
  'all-undefined settings object yields no rows',
  getExportSettingsRows({
    model: undefined,
    style: undefined,
    outputFormat: undefined,
    temperature: undefined,
    variables: undefined
  }).length === 0
);
check('null settings yields no rows', getExportSettingsRows(null).length === 0);
check(
  'variables alone do not produce a settings section',
  getExportSettingsRows({ variables: { foo: 'bar' } }).length === 0
);
check('null temperature is skipped', getExportSettingsRows({ temperature: null }).length === 0);
check(
  'temperature 0 is kept',
  JSON.stringify(getExportSettingsRows({ temperature: 0 })) ===
    JSON.stringify([['Temperature', '0']])
);
check(
  'populated settings yield rows in stable order',
  JSON.stringify(
    getExportSettingsRows({
      outputFormat: 'markdown',
      style: 'concise',
      model: 'gpt',
      temperature: 0.7
    })
  ) ===
    JSON.stringify([
      ['Model', 'gpt'],
      ['Temperature', '0.7'],
      ['Style', 'concise'],
      ['Output Format', 'markdown']
    ])
);

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
