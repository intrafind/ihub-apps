// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cache/refresh/rollup admin actions change state, so they are POST only.
 * They used to have GET aliases that called `app._router.handle`, which does not
 * exist in Express 5 and answered 500 (and made state changes reachable by GET).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import registerAdminCacheRoutes from '../routes/admin/cache.js';
import registerAdminUsageRoutes from '../routes/admin/usage.js';

const ACTIONS = [
  '/api/admin/cache/_refresh',
  '/api/admin/cache/_clear',
  '/api/admin/client/_refresh',
  '/api/admin/usage/_rollup'
];

function collectRoutes() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete', 'patch', 'use']) {
    app[method] = (path, ...handlers) => {
      routes.push({ method, path, handlers });
    };
  }
  registerAdminCacheRoutes(app);
  registerAdminUsageRoutes(app);
  return routes;
}

describe('state-changing admin actions are POST only', () => {
  const routes = collectRoutes();

  for (const action of ACTIONS) {
    it(`POST ${action} is registered behind auth and a handler`, () => {
      const route = routes.find(r => r.method === 'post' && r.path.endsWith(action));
      assert.ok(route, 'POST route exists');
      assert.ok(route.handlers.length >= 2, 'has auth middleware and a handler');
    });

    it(`GET ${action} is not registered`, () => {
      assert.equal(
        routes.some(r => r.method === 'get' && r.path.endsWith(action)),
        false
      );
    });
  }

  it('no route calls app._router (removed in Express 5)', () => {
    for (const r of routes) {
      for (const h of r.handlers) assert.ok(!String(h).includes('_router.handle'));
    }
  });
});
