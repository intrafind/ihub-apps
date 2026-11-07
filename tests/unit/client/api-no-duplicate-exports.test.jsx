// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Guard for issue #1743: the client API modules must not export the same name
 * twice. `api/index.js` star-re-exports `endpoints/*`, while admin screens
 * import `adminApi.js` directly, so a name defined in both silently gives a
 * component a different implementation (cached vs. admin-session-aware)
 * depending only on its import path.
 */
import fs from 'fs';
import path from 'path';

const API_DIR = path.resolve(__dirname, '../../../client/src/api');

const listModules = dir =>
  fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.js'))
    .map(file => path.join(dir, file));

const exportedNames = source => {
  const names = [];
  for (const match of source.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+(\w+)/gm
  )) {
    names.push(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const spec of match[1].split(',')) {
      const name = spec
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.push(name);
    }
  }
  return names;
};

describe('client API modules', () => {
  it('export each name from exactly one module', () => {
    const owners = new Map();
    for (const file of [...listModules(API_DIR), ...listModules(path.join(API_DIR, 'endpoints'))]) {
      const rel = path.relative(API_DIR, file);
      for (const name of exportedNames(fs.readFileSync(file, 'utf8'))) {
        owners.set(name, [...(owners.get(name) || []), rel]);
      }
    }

    const duplicates = [...owners.entries()]
      .filter(([, files]) => new Set(files).size > 1 || files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`);

    expect(duplicates).toEqual([]);
  });

  it('detects a duplicate (sanity check of the scanner)', () => {
    expect(
      exportedNames('export const a = 1;\nexport async function b() {}\nexport { c as d };')
    ).toEqual(['a', 'b', 'd']);
  });
});
