// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every API call the clients make hits a route the server registers.
 * See scripts/check-client-api-contract.js for what is read and how a path is
 * matched; a failure names the call and the file that makes it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dumpRoutes } from '../../scripts/dump-routes.js';
import { checkContract, pathMatches } from '../../scripts/check-client-api-contract.js';

// Registering the routes starts a few timers; do not wait for them.
after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));

test('client API calls all have a server route', async () => {
  const routes = await dumpRoutes();
  assert.ok(routes.length > 300, `route table looks empty (${routes.length} routes)`);
  const { unmatched, missingDynamic, checked } = checkContract(routes);
  assert.ok(checked > 300, `client call extraction looks broken (${checked} calls)`);
  assert.deepEqual(
    [...unmatched, ...missingDynamic],
    [],
    'client calls without a matching server route (renamed or removed on the server?)'
  );
  // The route table must see routes mounted with router.use(path, router).
  assert.ok(
    routes.some(r => r.method === 'POST' && r.path === '/api/integrations/api-keys/:keyId/_rotate')
  );
});

test('pathMatches: literal, parameter, wildcard and prefix segments', () => {
  assert.equal(pathMatches('/api/apps/x1', '/api/apps/:appId'), true);
  assert.equal(pathMatches('/api/apps/x1/_duplicate', '/api/apps/:appId'), false);
  assert.equal(pathMatches('/api/admin/x1/_key-status', '/api/admin/models/_key-status'), true);
  assert.equal(
    pathMatches('/api/prompts/x1/_duplicate', '/api/prompts/:promptId/_duplicate'),
    true
  );
  assert.equal(pathMatches('/api/prompts/x1/_copy', '/api/prompts/:promptId/_duplicate'), false);
  assert.equal(pathMatches('/api/skills/a/files/b/c', '/api/skills/:name/files/*filePath'), true);
  assert.equal(pathMatches('/api/x/download.', '/api/x/download.zip'), true);
});
