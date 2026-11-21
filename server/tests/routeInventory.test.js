// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The route inventory (#3785): every route that reaches a run, an interaction
 * or a chat has a row in `routeInventory.table.js` that says which check it
 * makes, with which intent, and what five callers get.
 *
 * Three things are tested:
 *
 * 1. The routes the server registers (read from the Express router, as
 *    `scripts/dump-routes.js` does) and the table list the same routes. A
 *    route without a row fails, and so does a row without a route.
 * 2. The rows with `probe` are true: the real route answers each caller with
 *    the status the row gives.
 * 3. The check itself: a scratch route added below `/api/runs` without a row
 *    is reported.
 * 4. A module that decides through run access has a row for every route it
 *    registers, also outside the prefixes (`/api/mcp-apps`, `/api/feedback`):
 *    each module is registered alone and its routes are compared with the table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dumpRoutes, listRoutes } from '../../scripts/dump-routes.js';
import { byCodeUnit } from './golden/byCodeUnit.js';
import { startRunAccessHarness, USERS } from './helpers/runAccessHarness.js';
import {
  CALLERS,
  INVENTORY_PREFIXES,
  ROUTE_INVENTORY,
  RUN_ACCESS_ROUTE_FILES
} from './routeInventory.table.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Whether a registered path lies below one of the inventory's prefixes.
 *
 * @param {string} routePath
 * @returns {boolean}
 */
function inInventory(routePath) {
  return INVENTORY_PREFIXES.some(
    prefix => routePath === prefix || routePath.startsWith(`${prefix}/`)
  );
}

/**
 * Compare registered routes with the rows of a table.
 *
 * @param {Array<{method: string, path: string}>} routes - the registered routes
 * @param {ReadonlyArray<{route: string}>} table - the inventory rows
 * @returns {{missingRows: string[], staleRows: string[], duplicateRows: string[]}}
 *   `missingRows`: inventory routes without a row; `staleRows`: rows whose
 *   route is not registered; `duplicateRows`: routes with more than one row
 */
function compareInventory(routes, table) {
  const registered = new Set(routes.map(route => `${route.method} ${route.path}`));
  const rows = table.map(row => row.route);
  const known = new Set(rows);
  return {
    missingRows: [...registered]
      .filter(route => inInventory(route.slice(route.indexOf(' ') + 1)) && !known.has(route))
      .sort(byCodeUnit),
    staleRows: rows.filter(route => !registered.has(route)).sort(byCodeUnit),
    duplicateRows: rows.filter((route, index) => rows.indexOf(route) !== index).sort(byCodeUnit)
  };
}

/**
 * The routes that have no row, whatever their path.
 *
 * @param {Array<{method: string, path: string}>} routes
 * @param {ReadonlyArray<{route: string}>} table - the inventory rows
 * @returns {string[]} `METHOD /path`, sorted
 */
function routesWithoutRow(routes, table) {
  const known = new Set(table.map(row => row.route));
  return routes
    .map(route => `${route.method} ${route.path}`)
    .filter(route => !known.has(route))
    .sort(byCodeUnit);
}

/**
 * The routes one route module registers, read from a bare Express app that
 * holds nothing else.
 *
 * @param {string} file - the module, relative to the repository root
 * @returns {Promise<Array<{method: string, path: string}>>}
 */
async function routesOfModule(file) {
  const { default: express } = await import('express');
  const module = await import(pathToFileURL(path.join(REPO_ROOT, file)).href);
  assert.equal(
    typeof module.default,
    'function',
    `${file}: a route module registers its routes with its default export`
  );
  const app = express();
  module.default(app, { getLocalizedError: async key => key, DEFAULT_TIMEOUT: 30000 });
  return listRoutes(app);
}

let h;
before(async () => {
  // First: the harness points the server's contents directory at a scratch
  // directory before any server module loads.
  h = await startRunAccessHarness();
});
// No `process.exit` here: it would end the process before the test runner has
// set the exit code, so a failing test run as a plain script would exit 0. The
// timers that registering every route starts do not keep the process alive.
after(async () => {
  await h.stop();
});

describe('route inventory: the table and the router list the same routes', () => {
  it('has a row for every registered route below the inventory prefixes, and no other', async () => {
    const routes = await dumpRoutes();
    assert.ok(routes.length > 300, `route table looks empty (${routes.length} routes)`);
    const { missingRows, staleRows, duplicateRows } = compareInventory(routes, ROUTE_INVENTORY);
    assert.deepEqual(
      missingRows,
      [],
      'routes without a row in server/tests/routeInventory.table.js: say which access check the route makes, with which intent, and what each caller gets'
    );
    assert.deepEqual(staleRows, [], 'rows whose route the server no longer registers');
    assert.deepEqual(duplicateRows, [], 'routes with more than one row');
    // The prefixes select something: a typo in one would let every route pass.
    for (const prefix of INVENTORY_PREFIXES) {
      assert.ok(
        routes.some(route => inInventory(route.path) && route.path.startsWith(prefix)),
        `no registered route below ${prefix}`
      );
    }
  });

  it('gives every case a check, an intent and a status for each of the five callers', () => {
    for (const row of ROUTE_INVENTORY) {
      assert.match(row.route, /^(GET|POST|PUT|PATCH|DELETE) \/api\//, row.route);
      assert.ok(Array.isArray(row.cases) && row.cases.length > 0, `${row.route}: no case`);
      for (const entry of row.cases) {
        const where = `${row.route} (${entry.intent})`;
        assert.ok(typeof entry.check === 'string' && entry.check, `${where}: check`);
        assert.ok(typeof entry.intent === 'string' && entry.intent, `${where}: intent`);
        assert.deepEqual(Object.keys(entry.expect), [...CALLERS], `${where}: callers`);
        for (const caller of CALLERS) {
          assert.ok(
            Number.isInteger(entry.expect[caller]) && entry.expect[caller] >= 200,
            `${where}: status of ${caller}`
          );
        }
        // Asked of the real route, or stated with the suite that tests it.
        assert.ok(
          Boolean(entry.probe) !== Boolean(entry.declared),
          `${where}: exactly one of probe and declared`
        );
      }
    }
  });

  it('asks the real route for every row below /api/runs that run access decides', () => {
    const unprobed = ROUTE_INVENTORY.filter(row => row.route.includes(' /api/runs'))
      .flatMap(row => row.cases.map(entry => ({ route: row.route, ...entry })))
      .filter(entry => /authorizeRun|authorizeInteraction/.test(entry.check) && !entry.probe)
      .map(entry => `${entry.route} (${entry.intent})`);
    assert.deepEqual(unprobed, []);
  });

  it('lists every route module that decides through run access', () => {
    const importing = [];
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (
          entry.name.endsWith('.js') &&
          /from '[./]+\/services\/loop\/runAccess\.js'/.test(fs.readFileSync(file, 'utf8'))
        ) {
          importing.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'server/routes'));
    assert.deepEqual(
      importing.sort(byCodeUnit),
      [...RUN_ACCESS_ROUTE_FILES],
      'a route module that starts to use run access is listed in RUN_ACCESS_ROUTE_FILES, and its routes get rows'
    );
  });

  it('has a row for every route such a module registers, whatever its path', async () => {
    for (const file of RUN_ACCESS_ROUTE_FILES) {
      const routes = await routesOfModule(file);
      assert.ok(routes.length > 0, `${file} registered no route`);
      assert.deepEqual(
        routesWithoutRow(routes, ROUTE_INVENTORY),
        [],
        `routes of ${file} without a row in server/tests/routeInventory.table.js: the module decides through run access, so say for each of its routes which check it makes and with which intent`
      );
    }
  });
});

describe('route inventory: the probed rows are true', () => {
  /**
   * The run a caller addresses, and who the caller is. `owner`, `otherUser`
   * and `admin` address a signed-in user's run; the two anonymous callers the
   * run of an anonymous visitor.
   */
  async function sceneFor(caller, probe) {
    const guest = caller === 'guestWithCookie' || caller === 'idHolder';
    const run = guest ? await h.seedGuestRun() : await h.seedUserRun();
    let interactionId = 'none';
    if (probe.interaction) {
      const raised = await h.interactionService.raise({
        runId: run.runId,
        kind: 'approval',
        origin: 'policy',
        prompt: { message: 'Send the mail?', inputType: 'confirm' },
        source: guest
          ? { chatId: run.chatId, principalId: run.runId, anonymous: true }
          : { chatId: run.chatId, principalId: run.principalId, identityMode: 'default' }
      });
      interactionId = raised.id;
    }
    const as = {
      owner: { user: USERS.owner },
      otherUser: { user: USERS.otherUser },
      admin: { user: USERS.admin },
      guestWithCookie: { cookie: run.cookie },
      idHolder: {}
    }[caller];
    return { run, interactionId, as };
  }

  for (const row of ROUTE_INVENTORY) {
    for (const entry of row.cases.filter(candidate => candidate.probe)) {
      it(`${row.route}${entry.when ? ` (${entry.when})` : ''}: ${entry.intent}`, async () => {
        const [method, template] = row.route.split(' ');
        for (const caller of CALLERS) {
          const { run, interactionId, as } = await sceneFor(caller, entry.probe);
          const url = template
            .replace(':runId', run.runId)
            .replace(':interactionId', interactionId);
          assert.equal(url.includes(':'), false, `${row.route}: a parameter has no value`);
          const res = await h.send(method.toLowerCase(), url, as, entry.probe.body);
          assert.equal(
            res.status,
            entry.expect[caller],
            `${row.route} as ${caller}: ${JSON.stringify(res.body)}`
          );
        }
      });
    }
  }
});

describe('route inventory: a route without a row is found', () => {
  it('fails for a scratch route added below /api/runs', () => {
    h.extra.get('/api/runs/:runId/scratch', (req, res) => res.json({}));
    const routes = listRoutes(h.app);
    assert.ok(
      routes.some(route => route.path === '/api/runs/:runId/human-events'),
      'the harness app holds the run routes'
    );
    const { missingRows } = compareInventory(routes, ROUTE_INVENTORY);
    assert.deepEqual(missingRows, ['GET /api/runs/:runId/scratch']);
  });

  it('ignores a route outside the prefixes and one that only shares a prefix as text', () => {
    const { missingRows, staleRows } = compareInventory(
      [
        { method: 'GET', path: '/api/runs-export' },
        { method: 'GET', path: '/api/apps/:appId/chatty' },
        { method: 'POST', path: '/api/admin/runs/:runId/_cancel' },
        { method: 'GET', path: '/api/interactions/pending' }
      ],
      [{ route: 'GET /api/interactions/pending' }, { route: 'GET /api/runs/:runId/gone' }]
    );
    assert.deepEqual(missingRows, []);
    assert.deepEqual(staleRows, ['GET /api/runs/:runId/gone']);
  });

  it('fails for a route of a run access module outside the prefixes', async () => {
    // What the prefixes do not see: a steer route added to the MCP app module.
    const routes = [
      ...(await routesOfModule('server/routes/mcpAppRoutes.js')),
      { method: 'POST', path: '/api/mcp-apps/runs/:runId/steer' }
    ];
    assert.deepEqual(compareInventory(routes, ROUTE_INVENTORY).missingRows, []);
    assert.deepEqual(routesWithoutRow(routes, ROUTE_INVENTORY), [
      'POST /api/mcp-apps/runs/:runId/steer'
    ]);
    // And a row that is taken out is missed.
    const withoutApproval = ROUTE_INVENTORY.filter(
      row => row.route !== 'POST /api/mcp-apps/tools/call/approval'
    );
    assert.deepEqual(
      routesWithoutRow(await routesOfModule('server/routes/mcpAppRoutes.js'), withoutApproval),
      ['POST /api/mcp-apps/tools/call/approval']
    );
  });

  it('finds a second row for one route', () => {
    const { duplicateRows } = compareInventory(
      [{ method: 'GET', path: '/api/runs' }],
      [{ route: 'GET /api/runs' }, { route: 'GET /api/runs' }]
    );
    assert.deepEqual(duplicateRows, ['GET /api/runs']);
  });
});
