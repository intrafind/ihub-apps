// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import path from 'path';
import { tokenize } from 'espree';
import baseline from './live-region-ratchet.baseline.json';

/**
 * Ratchet for live regions (#3191, #3782): a page has one polite live region,
 * the `AnnouncerProvider` (client/src/shared/announce/AnnouncerProvider.jsx),
 * and everything that has something to say to a screen reader says it through
 * `useAnnounce()`. Two regions that speak at once cut each other off, and a
 * screen-reader user hears things twice.
 *
 * The test counts, per source file of the client, the live regions written in
 * the code: an `aria-live` attribute or key (except a literal `aria-live="off"`)
 * and a `role` of `status` or `alert` (JSX attribute, object key, or
 * `setAttribute('role', …)`; a `role={…}` expression counts once when it can
 * be one of them). Comments do not count. The provider and the toast host
 * (client/src/shared/components/ToastHost.jsx) are not counted.
 *
 * A count above the recorded baseline fails: say it through `useAnnounce()`
 * instead of adding a region. A file whose count went down must lower its
 * number (or drop its entry at zero), so nobody can add one back unnoticed:
 *
 *   UPDATE_LIVE_REGION_BASELINE=1 npx jest --config tests/config/jest.config.js \
 *     tests/unit/client/live-region-ratchet.test.jsx
 *
 * and commit `live-region-ratchet.baseline.json`. Never raise a number to make
 * the test pass.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const ROOTS = ['client/src', 'client/office', 'client/extension', 'client/nextcloud'];
const ALLOWED = new Set([
  'client/src/shared/announce/AnnouncerProvider.jsx',
  'client/src/shared/components/ToastHost.jsx'
]);
const baselinePath = path.join(__dirname, 'live-region-ratchet.baseline.json');
const LIVE_ROLES = new Set(['status', 'alert']);

const TOKENIZE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  ecmaFeatures: { jsx: true }
};

function sourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') sourceFiles(full, out);
    } else if (/\.(jsx?|mjs|cjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The text of a string token (`"status"`, `'status'`, a JSX attribute value), or null. */
function stringValue(token) {
  if (!token || (token.type !== 'String' && token.type !== 'JSXText')) return null;
  const match = /^(['"])(.*)\1$/s.exec(token.value);
  return match ? match[2] : null;
}

/** The string values of the tokens of a `{…}` expression starting at `start`. */
function expressionStrings(tokens, start) {
  const values = [];
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const { type, value } = tokens[i];
    if (type === 'Punctuator' && (value === '{' || value === '${')) depth += 1;
    if (type === 'Punctuator' && value === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    const text = stringValue(tokens[i]);
    if (text !== null) values.push(text);
  }
  return values;
}

/**
 * How many live regions a source declares.
 *
 * @param {string} code
 * @returns {number}
 */
export function countLiveRegions(code) {
  const tokens = tokenize(code, TOKENIZE_OPTIONS);
  let count = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const name =
      token.type === 'JSXIdentifier' || token.type === 'Identifier'
        ? token.value
        : stringValue(token);
    const next = tokens[i + 1];
    const separator =
      next?.type === 'Punctuator' && ['=', ':', ','].includes(next.value) ? next.value : null;
    if (!separator) continue;
    const valueToken = tokens[i + 2];
    const isExpression = valueToken?.type === 'Punctuator' && valueToken.value === '{';
    const values = isExpression ? expressionStrings(tokens, i + 2) : [stringValue(valueToken)];
    if (name === 'aria-live') {
      if (!(values.length === 1 && values[0] === 'off')) count += 1;
    } else if (name === 'role' && values.some(value => LIVE_ROLES.has(value))) {
      count += 1;
    }
  }
  return count;
}

function currentCounts() {
  const counts = {};
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/');
      if (ALLOWED.has(relative)) continue;
      const count = countLiveRegions(fs.readFileSync(file, 'utf8'));
      if (count > 0) counts[relative] = count;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
  );
}

describe('countLiveRegions', () => {
  test('counts aria-live and role status/alert in JSX, objects and setAttribute, not comments', () => {
    const code = `
      // <div role="status" aria-live="polite"> in a comment
      /* role="alert" */
      const a = <div role="status" aria-live="polite" />;
      const b = <p role={failed ? 'alert' : undefined} />;
      const c = <ul role="list" aria-live="off" />;
      const d = <p aria-live={busy ? 'polite' : 'off'} />;
      const e = { 'aria-live': 'assertive', role: 'alert' };
      el.setAttribute('role', 'status');
      const f = <div role="dialog" />;
    `;
    // a: 2, b: 1, d: 1, e: 2, setAttribute: 1
    expect(countLiveRegions(code)).toBe(7);
  });
});

describe('live region ratchet', () => {
  const counts = currentCounts();

  if (process.env.UPDATE_LIVE_REGION_BASELINE) {
    test('writes the baseline', () => {
      fs.writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
    });
    return;
  }

  test('no file declares more live regions than recorded; new ones speak through useAnnounce()', () => {
    const above = Object.entries(counts)
      .filter(([file, count]) => count > (baseline[file] || 0))
      .map(([file, count]) => `${file}: ${count} (baseline ${baseline[file] || 0})`);
    expect(above).toEqual([]);
  });

  test('the baseline is not looser than the code (lower it when a region goes)', () => {
    const below = Object.entries(baseline)
      .filter(([file, count]) => (counts[file] || 0) < count)
      .map(([file, count]) => `${file}: ${counts[file] || 0} (baseline ${count})`);
    expect(below).toEqual([]);
  });

  test('the announcer and the toast host are the only places allowed one', () => {
    expect(
      countLiveRegions(
        fs.readFileSync(
          path.join(repoRoot, 'client/src/shared/announce/AnnouncerProvider.jsx'),
          'utf8'
        )
      )
    ).toBe(2); // role="status" + aria-live="polite" on its one region
    expect(baseline['client/src/shared/announce/AnnouncerProvider.jsx']).toBeUndefined();
    expect(baseline['client/src/features/chat/components/RunAnnouncer.jsx']).toBeUndefined();
    expect(
      baseline['client/src/features/tasks/components/ScheduledTaskNotifier.jsx']
    ).toBeUndefined();
  });
});
