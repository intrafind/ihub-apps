// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Compares a Nuclei JSONL export with `nuclei-expected.json` and writes a Markdown
 * summary to stdout (the DAST workflow appends it to the job summary).
 *
 * - A finding whose template is not listed fails the run (exit 1): a new exposure.
 * - A listed template without a finding is reported as a warning: either a default
 *   changed (update the list) or the template no longer matches (fix the template).
 *
 *   node tests/security/dast/check-nuclei-findings.mjs <findings.jsonl> [expected.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [findingsPath, expectedArg] = process.argv.slice(2);
if (!findingsPath) {
  console.error('Usage: check-nuclei-findings.mjs <findings.jsonl> [expected.json]');
  process.exit(2);
}
const expectedPath =
  expectedArg || path.join(path.dirname(fileURLToPath(import.meta.url)), 'nuclei-expected.json');
const expected = Object.fromEntries(
  Object.entries(JSON.parse(fs.readFileSync(expectedPath, 'utf8'))).filter(
    ([id]) => !id.startsWith('_')
  )
);

const findings = fs.existsSync(findingsPath)
  ? fs
      .readFileSync(findingsPath, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
  : [];

const cell = value => String(value ?? '').replace(/\|/g, '\\|');
const unexpected = findings.filter(f => !(f['template-id'] in expected));
const seen = new Set(findings.map(f => f['template-id']));
const missing = Object.keys(expected).filter(id => !seen.has(id));

const lines = ['### Nuclei', ''];
if (findings.length) {
  lines.push('| Template | Severity | Matched | Expected |', '|---|---|---|---|');
  for (const f of findings) {
    const id = f['template-id'];
    lines.push(
      `| ${cell(id)} | ${cell(f.info?.severity)} | ${cell(f['matched-at'])} | ${id in expected ? 'yes' : '**no**'} |`
    );
  }
} else {
  lines.push('No findings.');
}
if (missing.length) {
  lines.push(
    '',
    `:warning: Expected but not found (a default changed, or the template no longer matches): ${missing.map(id => `\`${id}\``).join(', ')}`
  );
}
if (unexpected.length) {
  lines.push(
    '',
    `**${unexpected.length} unexpected finding(s).** Fix them, or, if the behaviour is intended, add the template id with a reason to \`tests/security/dast/nuclei-expected.json\`.`
  );
}
console.log(lines.join('\n'));
process.exit(unexpected.length ? 1 : 0);
