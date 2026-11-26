// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRoutes, mentions } from '../../scripts/check-route-changes.js';

const route = (method, path) => ({ method, path });

test('mentions: a static prefix and the last two literal segments', () => {
  assert.deepEqual(mentions('/api/admin/projects/:id/items'), [
    '/api/admin/projects',
    '/admin/projects',
    '/projects/items'
  ]);
});

test('mentions: never an empty string, which would match any notes', () => {
  for (const path of ['/api', '/:lang/privacy', '/:id', '/:a/:b']) {
    assert.ok(mentions(path).length > 0, path);
    assert.ok(mentions(path).every(Boolean), path);
  }
});

test('mentions: a parameter-first route can be named whole', () => {
  assert.deepEqual(mentions('/:lang/privacy'), ['/:lang/privacy', '/{lang}/privacy']);
});

test('a removed route is documented when the notes name it, and not otherwise', () => {
  const removed = [route('POST', '/api/admin/x/enable')];
  const none = [];
  assert.equal(diffRoutes(removed, none, 'nothing about it').undocumented.length, 1);
  assert.equal(
    diffRoutes(removed, none, 'the route /api/admin/x/enable is gone').undocumented.length,
    0
  );
});

test('a removed parameter-first route is documented only by naming it whole', () => {
  const removed = [route('GET', '/:lang/privacy')];
  assert.equal(diffRoutes(removed, [], 'unrelated text').undocumented.length, 1);
  assert.equal(diffRoutes(removed, [], 'removed: GET /{lang}/privacy').undocumented.length, 0);
});

test('a route that moved to another method counts as removed and added', () => {
  const base = [route('PUT', '/api/a/:id')];
  const head = [route('POST', '/api/a/:id')];
  const { removed, added } = diffRoutes(base, head, '');
  assert.equal(removed.length, 1);
  assert.equal(added.length, 1);
});

test('sameDependencies: a changed dependency list makes the base install its own', async () => {
  const { sameDependencies } = await import('../../scripts/check-route-changes.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-'));
  const write = (dir, pkg) => {
    fs.mkdirSync(path.join(tmp, dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmp, dir, 'server', 'package.json'), JSON.stringify(pkg));
  };
  try {
    write('head', { dependencies: { b: '2', a: '1' } });
    write('same', { dependencies: { a: '1', b: '2' } });
    write('removed', { dependencies: { a: '1', b: '2', old: '1' } });
    const head = path.join(tmp, 'head');
    assert.equal(sameDependencies(path.join(tmp, 'same'), head, 'server'), true);
    assert.equal(sameDependencies(path.join(tmp, 'removed'), head, 'server'), false);
    assert.equal(sameDependencies(path.join(tmp, 'missing'), head, 'server'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('npmCliLocations: next to the Node binary, never through PATH', async () => {
  const { npmCliLocations } = await import('../../scripts/npm-cli.js');
  const path = await import('node:path');
  const [unix] = npmCliLocations('/opt/node24/bin/node');
  assert.equal(unix, path.join('/opt/node24/lib/node_modules/npm/bin/npm-cli.js'));
});
