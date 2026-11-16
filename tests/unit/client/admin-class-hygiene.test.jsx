// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import path from 'path';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

/**
 * Ratchet for the admin's Tailwind class strings (theme 4, "admin controls are visible").
 *
 * It counts, per file under client/src/features/admin, three kinds of class string that render
 * wrong, and fails when a count rises above the recorded baseline:
 *
 * - `borderlessBorderColor`: a neutral border colour (`border-gray-300`) with no border width
 *   (`border`, `border-b`, `border-2`, …). Tailwind 4 Preflight sets every border width to 0, so
 *   the colour paints nothing: the field or card has no visible edge. Use `INPUT_CLASS` from
 *   `features/admin/components/formStyles.js`, or add `border`.
 * - `primaryRamp`: a `*-primary-<n>` class. The theme has no `primary` ramp, so the class does
 *   nothing (the Cookies "Save" button was transparent, PL-B5). Use `PRIMARY_BUTTON_CLASS` or the
 *   `admin-accent` token.
 * - `grayTextWithoutDark`: `text-gray-600`…`text-gray-900` with no `dark:text-*` in the same
 *   string. In dark mode that is dark text on a dark card (ID-B9: 1.42:1 for gray-700 on
 *   gray-800). Add the matching `dark:text-gray-400`…`dark:text-gray-100`.
 *
 * Counts may only go down. When you fix strings, lower the baseline so nobody can add them back
 * (the test does not force this, so parallel branches that fix strings do not break each other):
 *
 *   UPDATE_ADMIN_CLASS_BASELINE=1 npx jest --config tests/config/jest.config.js \
 *     tests/unit/client/admin-class-hygiene.test.jsx
 *
 * and commit `admin-class-hygiene.baseline.json`. Never raise a number to make the test pass;
 * fix the class string instead. A string is one string literal or one template literal (its
 * static parts joined), so a multi-line template counts once.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const adminRoot = path.join(repoRoot, 'client/src/features/admin');
const baselinePath = path.join(__dirname, 'admin-class-hygiene.baseline.json');

const BORDER_WIDTH =
  /(?:^|\s)(?:[\w-]+:)*border(?:-[xytrbles])?(?:-(?:0|2|4|8|\[[^\]]+\]))?(?=\s|$)/;
const NEUTRAL_BORDER_COLOR = /(?:^|\s)border-(?:gray|slate|zinc|neutral|stone)-\d{2,3}(?=\s|$)/;
const PRIMARY_RAMP = /(?:^|[\s:])[\w]+-primary-\d/;
const GRAY_TEXT = /(?:^|\s)text-gray-(?:600|700|800|900)(?=\s|$)/;
const DARK_TEXT = /(?:^|\s)dark:text-/;

export const RULES = {
  borderlessBorderColor: value => NEUTRAL_BORDER_COLOR.test(value) && !BORDER_WIDTH.test(value),
  primaryRamp: value => PRIMARY_RAMP.test(value),
  grayTextWithoutDark: value => GRAY_TEXT.test(value) && !DARK_TEXT.test(value)
};

function sourceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(js|jsx)$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

// acorn, not @babel/parser: Babel 8 ships ESM only, which Jest cannot load from node_modules.
const JsxParser = Parser.extend(jsx());

/** Every string literal and template literal (static parts joined) in a source file. */
function classStrings(source) {
  const ast = JsxParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const strings = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    else if (node.type === 'TemplateLiteral') {
      strings.push(node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join(' '));
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(ast);
  return strings;
}

/** `{ rule: { 'relative/file.jsx': count } }` for the admin tree, without zero entries. */
export function countViolations(root = adminRoot) {
  const counts = Object.fromEntries(Object.keys(RULES).map(rule => [rule, {}]));
  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    for (const value of classStrings(fs.readFileSync(file, 'utf8'))) {
      for (const [rule, matches] of Object.entries(RULES)) {
        if (matches(value)) counts[rule][relative] = (counts[rule][relative] || 0) + 1;
      }
    }
  }
  return counts;
}

const total = byFile => Object.values(byFile).reduce((sum, n) => sum + n, 0);

describe('admin class hygiene ratchet', () => {
  const current = countViolations();

  if (process.env.UPDATE_ADMIN_CLASS_BASELINE) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

  test.each(Object.keys(RULES))('%s does not rise in any admin file', rule => {
    const allowed = baseline[rule] || {};
    const rises = Object.entries(current[rule])
      .filter(([file, count]) => count > (allowed[file] || 0))
      .map(([file, count]) => `${file}: ${count} (baseline ${allowed[file] || 0})`);
    expect(rises).toEqual([]);
  });

  test('no admin class string uses the non-existent primary ramp', () => {
    expect(total(current.primaryRamp)).toBe(0);
  });

  test('the rules recognise what they are meant to', () => {
    expect(RULES.borderlessBorderColor('mt-1 block w-full border-gray-300 rounded-md')).toBe(true);
    expect(RULES.borderlessBorderColor('w-full border border-gray-300')).toBe(false);
    expect(RULES.borderlessBorderColor('border-b border-gray-200')).toBe(false);
    expect(RULES.primaryRamp('bg-primary-600 hover:bg-primary-500')).toBe(true);
    expect(RULES.primaryRamp('bg-admin-accent')).toBe(false);
    expect(RULES.grayTextWithoutDark('text-sm font-medium text-gray-700')).toBe(true);
    expect(RULES.grayTextWithoutDark('text-gray-700 dark:text-gray-300')).toBe(false);
    expect(RULES.grayTextWithoutDark('text-gray-500')).toBe(false);
  });
});
