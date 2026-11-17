// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import {
  CHECKBOX_CLASS,
  RADIO_CLASS
} from '../../../client/src/features/admin/components/formStyles.js';

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
 * - `lowContrastFieldBorder` (counted per element, not per string): an `input`, `select` or
 *   `textarea` (not a checkbox, radio, range, colour, file or hidden input) whose `className`
 *   sets `border-gray-{100,200,300}` or `dark:border-gray-{500,600,700}`. Those measure 1.24:1
 *   to 1.94:1 against the field's background, below the 3:1 WCAG 1.4.11 asks for (PL-B6). Use
 *   `border-admin-control-border dark:border-admin-control-border-dark`, or `INPUT_CLASS`. The
 *   class is read from string and template literals in the attribute and from constants declared
 *   in the same file (followed through other constants); a constant imported from another file is
 *   not followed.
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

const LOW_FIELD_BORDER = /(?:^|\s)border-gray-(?:100|200|300)(?=\s|$)/;
const LOW_FIELD_BORDER_DARK = /(?:^|\s)dark:border-gray-(?:500|600|700)(?=\s|$)/;
const FIELD_ELEMENTS = new Set(['input', 'select', 'textarea']);
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'hidden']);

/** Field-level rules: given a field's resolved class text, does it violate the rule? */
export const FIELD_RULES = {
  lowContrastFieldBorder: value => LOW_FIELD_BORDER.test(value) || LOW_FIELD_BORDER_DARK.test(value)
};

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

/** Calls `visitor` for every AST node below `node`. */
function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(child => walk(child, visitor));
    return;
  }
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (child && typeof child === 'object') walk(child, visitor);
  }
}

/**
 * The class text of every text-like field element (`input`, `select`, `textarea`) in a source
 * file: the string and template literals in its `className`, plus those of same-file constants
 * it names (followed through other constants). Checkbox, radio and similar inputs are skipped;
 * so is an input whose dynamic `type` may make it one (its class names CHECKBOX/RADIO).
 */
function fieldClassTexts(source) {
  const ast = JsxParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const constants = {};
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      constants[node.id.name] = node.init;
    }
  });
  const textOf = (expression, seen = new Set()) => {
    const parts = [];
    walk(expression, node => {
      if (node.type === 'Literal' && typeof node.value === 'string') parts.push(node.value);
      else if (node.type === 'TemplateElement') parts.push(node.value.cooked ?? node.value.raw);
      else if (node.type === 'Identifier' && constants[node.name] && !seen.has(node.name)) {
        seen.add(node.name);
        parts.push(textOf(constants[node.name], seen));
      }
    });
    return parts.join(' ');
  };
  const texts = [];
  walk(ast, node => {
    if (node.type !== 'JSXOpeningElement' || node.name.type !== 'JSXIdentifier') return;
    if (!FIELD_ELEMENTS.has(node.name.name)) return;
    const attribute = name => node.attributes.find(a => a.name && a.name.name === name);
    const type = attribute('type');
    if (type?.value?.type === 'Literal' && NON_TEXT_INPUT_TYPES.has(type.value.value)) return;
    const className = attribute('className');
    if (!className?.value) return;
    const text = textOf(className.value);
    if (type?.value && type.value.type !== 'Literal' && /CHECKBOX|RADIO|accent-/.test(text)) return;
    texts.push(text);
  });
  return texts;
}

/** `{ rule: { 'relative/file.jsx': count } }` for the admin tree, without zero entries. */
export function countViolations(root = adminRoot) {
  const ruleNames = [...Object.keys(RULES), ...Object.keys(FIELD_RULES)];
  const counts = Object.fromEntries(ruleNames.map(rule => [rule, {}]));
  const add = (rule, file) => {
    counts[rule][file] = (counts[rule][file] || 0) + 1;
  };
  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    for (const value of classStrings(source)) {
      for (const [rule, matches] of Object.entries(RULES)) {
        if (matches(value)) add(rule, relative);
      }
    }
    for (const value of fieldClassTexts(source)) {
      for (const [rule, matches] of Object.entries(FIELD_RULES)) {
        if (matches(value)) add(rule, relative);
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

  test.each([...Object.keys(RULES), ...Object.keys(FIELD_RULES)])(
    '%s does not rise in any admin file',
    rule => {
      const allowed = baseline[rule] || {};
      const rises = Object.entries(current[rule])
        .filter(([file, count]) => count > (allowed[file] || 0))
        .map(([file, count]) => `${file}: ${count} (baseline ${allowed[file] || 0})`);
      expect(rises).toEqual([]);
    }
  );

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
    expect(FIELD_RULES.lowContrastFieldBorder('w-full border border-gray-300')).toBe(true);
    expect(FIELD_RULES.lowContrastFieldBorder('border border-gray-200')).toBe(true);
    expect(FIELD_RULES.lowContrastFieldBorder('border dark:border-gray-600')).toBe(true);
    expect(
      FIELD_RULES.lowContrastFieldBorder(
        'border border-admin-control-border dark:border-admin-control-border-dark'
      )
    ).toBe(false);
    expect(FIELD_RULES.lowContrastFieldBorder('border-b border-gray-500')).toBe(false);
  });

  test('lowContrastFieldBorder counts field elements only, through same-file constants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-hygiene-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'Form.jsx'),
        [
          "const FIELD = 'w-full border border-gray-300 dark:border-gray-600';",
          'const MONO = `${FIELD} font-mono`;',
          "const CARD = 'border border-gray-200';",
          'export default function Form() {',
          '  return (',
          '    <div className={CARD}>',
          '      <input type="text" className={MONO} />',
          '      <select className="border border-gray-200" />',
          '      <textarea className={FIELD} />',
          '      <input type="checkbox" className="border-gray-300" />',
          '      <input className="border border-admin-control-border" />',
          '    </div>',
          '  );',
          '}'
        ].join('\n')
      );
      expect(countViolations(dir).lowContrastFieldBorder).toEqual({ 'Form.jsx': 3 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkboxes and radios switch to the light accent in dark mode', () => {
    // indigo-600 (admin-accent) is 2.33:1 on the gray-800 card, below the 3:1 for the checked
    // fill and the focus outline; indigo-400 (admin-accent-fg-dark) passes.
    for (const value of [CHECKBOX_CLASS, RADIO_CLASS]) {
      expect(value).toContain('dark:accent-admin-accent-fg-dark');
      expect(value).toContain('dark:focus-visible:outline-admin-accent-fg-dark');
    }
    const css = fs.readFileSync(path.join(repoRoot, 'client/src/App.css'), 'utf8');
    expect(css).toMatch(
      /\[data-surface='admin'\]\[data-theme='dark'\]\s*:is\(input\[type='checkbox'\], input\[type='radio'\]\)[^{]*\{\s*accent-color: var\(--color-admin-accent-fg-dark\);/
    );
  });
});
