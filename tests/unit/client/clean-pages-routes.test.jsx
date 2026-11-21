/**
 * @jest-environment node
 */
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `CLEAN_PAGES` in tests/e2e/accessibility.spec.js lists the pages the accessibility check holds
 * at zero violations. The check opens each path and fails when the browser ends up somewhere
 * else, but the browser suite does not run on every pull request, so a page that is removed,
 * renamed or turned into a redirect in `client/src/App.jsx` is only noticed there later. This
 * test pins the list to the routes: every path in it opens a page of its own.
 *
 * A path that no route matches is worse than a redirect: the "not found" page renders under the
 * same URL, so the browser check passes while it scans the wrong page.
 *
 * When this fails, change `CLEAN_PAGES` in the commit that changes the route.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Parser } from 'acorn';
import { appRoutes, matchRoute, routesInSource } from '../../utils/appRoutes.js';

const SPEC = path.resolve(__dirname, '../../e2e/accessibility.spec.js');

/** The string elements of `const <name> = [ ... ]` at the top level of a module's source. */
function stringArray(source, name) {
  const ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.name !== name || declaration.init?.type !== 'ArrayExpression') continue;
      return declaration.init.elements.map(element => {
        if (element?.type !== 'Literal' || typeof element.value !== 'string') {
          throw new Error(`${name} holds an entry that is not a plain string`);
        }
        return element.value;
      });
    }
  }
  throw new Error(`${name} not found`);
}

/** Why opening `pagePath` does not show a page of its own, or `null` when it does. */
function pageProblem(pagePath, routes) {
  const route = matchRoute(pagePath, routes);
  if (!route) return `${pagePath}: no route in client/src/App.jsx`;
  if (route.redirectTo) return `${pagePath}: redirects to ${route.redirectTo}`;
  return null;
}

describe('CLEAN_PAGES of the accessibility check', () => {
  const routes = appRoutes();
  const cleanPages = stringArray(readFileSync(SPEC, 'utf8'), 'CLEAN_PAGES');

  test('is read from the spec', () => {
    expect(cleanPages.length).toBeGreaterThan(30);
    expect(cleanPages.filter(page => !page.startsWith('/'))).toEqual([]);
  });

  test('every path opens a page of its own in client/src/App.jsx', () => {
    expect(cleanPages.map(page => pageProblem(page, routes)).filter(Boolean)).toEqual([]);
  });

  test('lists no path twice', () => {
    expect(cleanPages.filter((page, i) => cleanPages.indexOf(page) !== i)).toEqual([]);
  });
});

describe('the route check itself', () => {
  const routes = routesInSource(`
    const App = () => (
      <Routes>
        <Route path="login" element={<Login />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Home />} />
          {flags.tasks && (
            <>
              <Route path="tasks" element={<Tasks />} />
              <Route path="tasks/:taskId" element={<Task />} />
            </>
          )}
          <Route path="admin" element={<AdminLayout />}>
            {show('home') && <Route index element={<Overview />} />}
            <Route path="models" element={<Models />} />
            <Route path="docs/*" element={<Docs />} />
            <Route path="system" element={<Navigate replace to="/admin/models" />} />
          </Route>
          <Route path="settings" element={<SettingsLayout />}>
            <Route path="usage" element={<Usage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    );
  `);

  test('reads nested, flagged and index routes as full paths', () => {
    expect(routes.map(route => route.pattern)).toEqual([
      '/login',
      '/',
      '/tasks',
      '/tasks/:taskId',
      '/admin',
      '/admin/models',
      '/admin/docs/*',
      '/admin/system',
      '/settings/usage',
      '/*'
    ]);
  });

  test('accepts a page, a parameter route and a splat route', () => {
    for (const page of ['/', '/tasks', '/tasks/abc', '/admin', '/admin/docs', '/admin/docs/a/b']) {
      expect(pageProblem(page, routes)).toBeNull();
    }
  });

  test('reports a removed page, although the catch-all route would render something', () => {
    expect(pageProblem('/scheduled', routes)).toBe('/scheduled: no route in client/src/App.jsx');
    expect(pageProblem('/admin/tasks', routes)).toBe(
      '/admin/tasks: no route in client/src/App.jsx'
    );
  });

  test('reports a layout route that has no page of its own', () => {
    expect(pageProblem('/settings', routes)).toBe('/settings: no route in client/src/App.jsx');
  });

  test('reports a redirect with its target', () => {
    expect(pageProblem('/admin/system', routes)).toBe('/admin/system: redirects to /admin/models');
  });
});
