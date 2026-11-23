// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The client routes of `client/src/App.jsx`, read from its source, for tests that pin a list of
 * paths kept elsewhere (a docs page's `adminPage`, the pages the accessibility check opens) to
 * the routes that exist.
 *
 * The file is parsed, not imported: App.jsx pulls in the whole client. Every `<Route>` element is
 * read wherever it sits (behind a feature flag, in a fragment, in a ternary), because a test
 * cannot know which flags an installation has on; a route that exists behind a flag exists.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

// acorn, not @babel/parser: Babel 8 ships ESM only, which Jest cannot load from node_modules.
const JsxParser = Parser.extend(jsx());

const APP_JSX = path.resolve(__dirname, '../../client/src/App.jsx');

/** The value of a JSX attribute that is a plain string (`path="apps"` or `path={'apps'}`). */
function stringAttribute(element, name) {
  const attribute = element.openingElement.attributes.find(
    attr => attr.type === 'JSXAttribute' && attr.name.name === name
  );
  if (!attribute) return undefined;
  const value = attribute.value;
  if (value?.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (
    value?.type === 'JSXExpressionContainer' &&
    value.expression.type === 'Literal' &&
    typeof value.expression.value === 'string'
  ) {
    return value.expression.value;
  }
  return undefined;
}

/** Where `element={<Navigate to="/x" />}` sends the browser, or undefined for a page. */
function redirectTarget(element) {
  const attribute = element.openingElement.attributes.find(
    attr => attr.type === 'JSXAttribute' && attr.name.name === 'element'
  );
  const rendered = attribute?.value?.expression;
  if (rendered?.type !== 'JSXElement' || rendered.openingElement.name.name !== 'Navigate') {
    return undefined;
  }
  return stringAttribute(rendered, 'to') ?? '(computed)';
}

const hasAttribute = (element, name) =>
  element.openingElement.attributes.some(
    attr => attr.type === 'JSXAttribute' && attr.name.name === name
  );

/** Whether a `<Route>` element sits anywhere below `node`. */
function containsRoute(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsRoute);
  if (node.type === 'JSXElement' && node.openingElement.name.name === 'Route') return true;
  return Object.values(node).some(containsRoute);
}

function joinPaths(parent, child) {
  if (child.startsWith('/')) return child;
  return `${parent.replace(/\/$/, '')}/${child}`;
}

/**
 * Every route in JSX source, as full path patterns (`/admin/models/:modelId`, `/admin/docs/*`).
 * A layout route without an index child is not a page and is not listed; the catch-all (`*` or
 * `/*`) is listed as `/*` with `catchAll: true`.
 *
 * @param {string} source JSX source text
 * @returns {Array<{ pattern: string, redirectTo?: string, catchAll?: true }>}
 */
export function routesInSource(source) {
  const ast = JsxParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const routes = [];

  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (node.type === 'JSXElement' && node.openingElement.name.name === 'Route') {
      const ownPath = stringAttribute(node, 'path');
      const isIndex = hasAttribute(node, 'index');
      const full = ownPath === undefined ? parent : joinPaths(parent, ownPath);
      // A route with child routes renders a layout around them; it is a page of its own only
      // through an index child.
      if (isIndex || (ownPath !== undefined && !containsRoute(node.children))) {
        const redirectTo = redirectTarget(node);
        routes.push({
          pattern: full || '/',
          ...(redirectTo !== undefined && { redirectTo }),
          ...((ownPath === '*' || ownPath === '/*') && { catchAll: true })
        });
      }
      visit(node.children, full);
      return;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') visit(child, parent);
    }
  };
  visit(ast, '');
  return routes;
}

/** The routes of `client/src/App.jsx`. */
export function appRoutes() {
  return routesInSource(readFileSync(APP_JSX, 'utf8'));
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternToRegExp(pattern) {
  const segments = pattern
    .split('/')
    .filter(Boolean)
    .map(segment => {
      if (segment === '*') return '.*';
      if (segment.startsWith(':')) return '[^/]+';
      return escapeRegExp(segment);
    });
  // `docs/*` also matches `docs` itself, as in React Router.
  const body = segments.join('/').replace(/\/\.\*$/, '(?:/.*)?');
  return new RegExp(`^/${body}/?$`);
}

/**
 * How React Router ranks a route pattern (`computeScore` in react-router): every segment counts,
 * a static one most, a parameter less, and a splat costs. So `/admin/system` wins over
 * `/admin/:id`, and `/files/:id` over `/files/*`.
 */
function routeScore(pattern) {
  const segments = pattern.split('/');
  const initial = segments.length + (segments.includes('*') ? -2 : 0);
  return segments
    .filter(segment => segment !== '*')
    .reduce(
      (score, segment) => score + (/^:[\w-]+$/.test(segment) ? 3 : segment === '' ? 1 : 10),
      initial
    );
}

/**
 * The route a concrete path (`/admin/models/new`) opens, or undefined when only the catch-all
 * "not found" route would take it. Routes are ranked as React Router ranks them, so
 * `/admin/system` is reported as the redirect it is and not as some `/admin/:id`.
 *
 * @param {string} pathname
 * @param {ReturnType<typeof routesInSource>} routes
 */
export function matchRoute(pathname, routes) {
  const candidates = routes.filter(
    route => !route.catchAll && patternToRegExp(route.pattern).test(pathname)
  );
  return candidates.sort((a, b) => routeScore(b.pattern) - routeScore(a.pattern))[0];
}
