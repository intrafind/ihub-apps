// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every icon name the client passes literally to <Icon name="…"> (and the
 * defaults the admin editors seed, such as an agent's `icon: 'robot'`) must
 * resolve to a bundled icon. An unknown name falls back to /icons/{name}.svg,
 * which does not exist for these names and shows as a 404 and an empty box.
 */
import fs from 'fs';
import path from 'path';
import { render } from '@testing-library/react';

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: p => `/${p}`
}));

const Icon = require('../../../client/src/shared/components/Icon').default;

const SRC = path.resolve('client/src');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const names = new Set();
for (const file of sourceFiles(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/<Icon\b[^>]*?\sname="([^"]+)"/g)) names.add(match[1]);
}
// Defaults seeded into new records and rendered through <Icon name={record.icon}>.
names.add('robot');

describe('literal icon names', () => {
  it('are found in the source', () => {
    expect(names.size).toBeGreaterThan(50);
  });

  it.each([...names].sort())('"%s" renders a bundled icon, not a /icons/ file', name => {
    const { container } = render(<Icon name={name} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
