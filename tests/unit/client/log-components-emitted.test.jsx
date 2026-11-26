// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import path from 'path';
import { LOG_COMPONENTS } from '../../../client/src/features/admin/utils/logComponents';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

/**
 * Admin → Logging offers only components the server logs with (OB-B3). A
 * component nobody emits turns the filter into silence; the review found
 * three such ids (`AdminRoutes`, `MistralAdapter`, `ModelsLoader`).
 *
 * A component is emitted when `server/` holds `component: '<id>'` or
 * `COMPONENT = '<id>'` (the constant the loop modules log with).
 */

const serverDir = path.resolve(__dirname, '../../../server');

function sourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

const emitted = new Set();
for (const file of sourceFiles(serverDir)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\b(?:component:|COMPONENT\s*=)\s*'([A-Za-z0-9_.-]+)'/g)) {
    emitted.add(match[1]);
  }
}

const lookup = (catalog, key) =>
  key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), catalog);

test('the server source was found', () => {
  expect(emitted.size).toBeGreaterThan(100);
});

test.each(LOG_COMPONENTS.map(c => [c.id]))('the server logs with component %s', id => {
  expect(emitted.has(id)).toBe(true);
});

test('every table line is a complete entry', () => {
  for (const component of LOG_COMPONENTS) {
    expect(component.id).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(component.name).toBeTruthy();
    expect(component.description).toBeTruthy();
  }
});

test('the web search engines named are the ones iHub ships (Tavily was removed)', () => {
  const webSearch = LOG_COMPONENTS.find(c => c.id === 'WebSearch');
  for (const text of [
    webSearch.description,
    lookup(en, webSearch.descriptionKey),
    lookup(de, webSearch.descriptionKey)
  ]) {
    expect(text).not.toMatch(/Tavily/);
    expect(text).toMatch(/Brave, Staan/);
  }
});

test('ids are unique', () => {
  const ids = LOG_COMPONENTS.map(c => c.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('components found missing in the review are offered', () => {
  const ids = LOG_COMPONENTS.map(c => c.id);
  expect(ids).toEqual(expect.arrayContaining(['WorkflowEngine', 'NtlmAuth', 'IFinderService']));
});

test('every localized entry has its keys in English and German', () => {
  for (const component of LOG_COMPONENTS) {
    for (const key of [component.nameKey, component.descriptionKey].filter(Boolean)) {
      expect([key, typeof lookup(en, key)]).toEqual([key, 'string']);
      expect([key, typeof lookup(de, key)]).toEqual([key, 'string']);
    }
  }
});
