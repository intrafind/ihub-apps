// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Coverage guard of the cross-user authorization suite: every non-admin route
 * with a path parameter must be attacked by a matrix of `resources.js`
 * (`RESOURCES`, `GROUP_GATED`, `ADMIN_ONLY`) or listed in `EXEMPT_ROUTES` with a
 * reason, so a new `/:id` route cannot ship untested.
 *
 * The route list is the running server's own router stack, written when it
 * started listening by `tests/config/authz-route-dump.mjs` (preloaded by
 * `authz-server.mjs`): what Express registered, including routers mounted with
 * `app.use(path, router)`, not a parse of the source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { ADMIN_ONLY, EXEMPT_ROUTES, GROUP_GATED, RESOURCES } from './resources.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROUTE_DUMP = path.join(
  root,
  process.env.AUTHZ_CONTENTS_DIR || 'contents-e2e-authz',
  '.authz-routes.json'
);

/** Admin routes have their own audit (`scripts/audit-admin-endpoints.js`). */
const isAdminPath = routePath => /^\/api\/admin(\/|$)/.test(routePath);
const hasParameter = routePath => /[:*]|\{\*/.test(routePath);

function registeredRoutes() {
  const routes = JSON.parse(fs.readFileSync(ROUTE_DUMP, 'utf8'));
  const keys = new Set();
  for (const { method, path: routePath } of routes) {
    if (isAdminPath(routePath) || !hasParameter(routePath)) continue;
    // `app.all` registers every method; such routes have no parameter today.
    keys.add(`${method} ${routePath}`);
  }
  return keys;
}

function coveredRoutes() {
  const covered = new Map();
  const add = (route, where) => {
    if (!covered.has(route)) covered.set(route, where);
  };
  for (const resource of RESOURCES) {
    for (const entry of resource.routes) add(entry.route, resource.name);
  }
  for (const entry of GROUP_GATED) add(entry.route, 'GROUP_GATED');
  for (const entry of ADMIN_ONLY) add(entry.route, 'ADMIN_ONLY');
  return covered;
}

test('the route table was dumped by the server under test', () => {
  expect(fs.existsSync(ROUTE_DUMP), `${ROUTE_DUMP} (written by authz-route-dump.mjs)`).toBe(true);
  // Sanity: the dump holds the routes of the whole app, admin included.
  const routes = JSON.parse(fs.readFileSync(ROUTE_DUMP, 'utf8'));
  expect(routes.some(route => route.path === '/api/chats/:chatId')).toBe(true);
  expect(routes.some(route => route.path.startsWith('/api/admin/'))).toBe(true);
  expect(routes.some(route => route.path === '/api/integrations/api-keys/:keyId')).toBe(true);
});

test('every parameterised non-admin route is attacked or exempted with a reason', () => {
  const registered = registeredRoutes();
  const covered = coveredRoutes();
  const exempt = new Set(Object.keys(EXEMPT_ROUTES));

  const untested = [...registered].filter(route => !covered.has(route) && !exempt.has(route));
  expect(
    untested,
    'New parameterised routes: add them to RESOURCES (resources.js) or, with a reason, to EXEMPT_ROUTES'
  ).toEqual([]);

  // The lists stay honest: nothing in them that the server no longer registers,
  // and nothing both attacked and exempted.
  const stale = [...covered.keys(), ...exempt].filter(route => !registered.has(route));
  expect(stale, 'Routes in the matrix or the exemptions that the server does not register').toEqual(
    []
  );
  const both = [...exempt].filter(route => covered.has(route));
  expect(both, 'Routes both attacked and exempted').toEqual([]);
});
