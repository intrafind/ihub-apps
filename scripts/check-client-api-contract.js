#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every API call the clients make must hit a route the server registers.
 *
 * The client side is read from source: `apiClient.<verb>(...)`,
 * `makeAdminApiCall(...)`, `buildApiUrl(...)` + `{ method }`, with the template
 * literals and the `const`/arrow-function path builders in the same file
 * resolved. The server side is the route table from `scripts/dump-routes.js`
 * (nothing listens). A call fails the check when no route has its method and a
 * path of the same shape; `x1` marks a dynamic segment (a `${...}` the source
 * does not reveal) and matches any server segment.
 *
 * A path the client assembles from a variable it cannot resolve (an action that
 * is chosen at runtime) is checked against `DYNAMIC_CALLS` instead — list every
 * value it can take, so a renamed server route breaks here and not in a browser.
 *
 * Usage:  node scripts/check-client-api-contract.js [--routes <routes.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_ROOTS = [
  'client/src',
  'client/extension',
  'client/office',
  'client/nextcloud',
  'browser-extension',
  'shared',
  'teams'
];

/**
 * Calls whose last segment is chosen at runtime. `routes` is every method and
 * path the call can reach; each one must exist. `source` is where the choice is
 * made.
 */
export const DYNAMIC_CALLS = [
  {
    source: 'client/src/features/admin/pages/AdminOfficeIntegrationPage.jsx',
    routes: [
      'POST /api/admin/office-integration/_enable',
      'POST /api/admin/office-integration/_disable'
    ]
  },
  {
    source: 'client/src/features/admin/pages/AdminNextcloudEmbedPage.jsx',
    routes: ['POST /api/admin/nextcloud-embed/_enable', 'POST /api/admin/nextcloud-embed/_disable']
  },
  {
    source: 'client/src/features/admin/pages/AdminBrowserExtensionPage.jsx',
    routes: [
      'POST /api/admin/browser-extension/_enable',
      'POST /api/admin/browser-extension/_disable'
    ]
  },
  {
    source: 'client/src/features/admin/pages/AdminCopilotAgentPage.jsx',
    routes: ['POST /api/admin/copilot-agent/_enable', 'POST /api/admin/copilot-agent/_disable']
  },
  {
    source: 'client/src/features/workflows/hooks/useWorkflowExecution.js',
    routes: ['POST /api/workflows/executions/:id/_cancel']
  },
  {
    source: 'client/src/api/userIntegrationsApi.js',
    routes: [
      'POST /api/integrations/:id/_connect',
      'POST /api/integrations/:id/_reconnect',
      'POST /api/integrations/:id/_disconnect'
    ]
  },
  {
    source: 'client/src/api/integrationsAdminApi.js',
    routes: [
      'POST /api/admin/integrations/installed/:id/_migrate',
      'POST /api/admin/integrations/installed/:id/_restore',
      'POST /api/admin/integrations/installed/:id/_revert',
      'POST /api/admin/integrations/installed/:id/_adopt'
    ]
  },
  {
    source: 'client/src/api/adminApi.js',
    routes: [
      'POST /api/admin/projects/_merge',
      'POST /api/admin/projects/_move',
      'GET /api/admin/projects/_settings',
      'PUT /api/admin/projects/_settings'
    ]
  }
];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(jsx?|mjs|ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The source of the call whose opening parenthesis is at `idx` (balanced). */
function callBody(src, idx) {
  let depth = 0;
  let i = idx;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(idx, i + 1);
}

function expand(raw, consts) {
  let out = raw;
  for (let i = 0; i < 4; i++) {
    out = out.replace(/\$\{\s*([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\}/g, (all, fn) =>
      consts.fns[fn] === undefined ? all : consts.fns[fn]
    );
    out = out.replace(/\$\{\s*([A-Za-z_]\w*)\s*\}/g, (all, name) =>
      consts.vars[name] === undefined ? all : consts.vars[name]
    );
  }
  return out;
}

/** A call's path as `/api/...` with `x1` for dynamic segments; null when unreadable. */
function normalize(raw, base, consts) {
  let out = expand(raw, consts);
  out = out.replace(/(?<=[^/\s])\$\{.*$/s, '');
  out = out.replace(/\$\{\s*encodeURIComponent\([^)]*\)\s*\}/g, 'x1');
  let p = out.replace(/\$\{[^}]*\}/g, 'x1').split('?')[0];
  if (out.startsWith('${')) return null;
  if (!p.startsWith('/') && base) p = `/${p}`;
  if (p === '/' || p === '') return null;
  return p.startsWith('/api/') ? p : base + p;
}

/** The string constants and the template-literal path builders of one source file. */
function readConstants(src) {
  const consts = { vars: {}, fns: {} };
  for (const c of src.matchAll(
    /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(['"`])((?:(?!\2)[^\\\n])*)\2\s*;/g
  )) {
    consts.vars[c[1]] = c[3];
  }
  for (const c of src.matchAll(
    /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\(([\w\s,={}'"]*)\)|(\w+))\s*=>\s*`([^`]*)`/g
  )) {
    const params = (c[2] ?? c[3] ?? '')
      .split(',')
      .map(x => x.trim().split('=')[0].trim())
      .filter(Boolean);
    let body = c[4];
    for (const name of params) body = body.split(`\${${name}}`).join('x1');
    consts.fns[c[1]] = body.replace(/\$\{\s*encodeURIComponent\(\s*\w+\s*\)\s*\}/g, 'x1');
  }
  return consts;
}

const methodOf = body => (body.match(/method:\s*['"](\w+)['"]/)?.[1] || 'GET').toUpperCase();

/** The `[method, path]` pairs of the API calls in one source file. */
function readCalls(src, consts) {
  const found = [];
  for (const c of src.matchAll(/makeAdminApiCall\(\s*([A-Za-z_]\w*)\s*[,)]/g)) {
    if (consts.vars[c[1]] === undefined) continue;
    const body = callBody(src, c.index + 'makeAdminApiCall'.length);
    found.push([methodOf(body), normalize(consts.vars[c[1]], '/api', consts)]);
  }
  for (const m of src.matchAll(/makeAdminApiCall\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const body = callBody(src, m.index + 'makeAdminApiCall'.length);
    found.push([methodOf(body), normalize(m[2], '/api', consts)]);
  }
  for (const m of src.matchAll(
    /apiClient\.(get|post|put|patch|delete)\(\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g
  )) {
    found.push([m[1].toUpperCase(), normalize(m[3], '/api', consts)]);
  }
  for (const m of src.matchAll(
    /buildApiUrl\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\)([\s\S]{0,200})/g
  )) {
    found.push([methodOf(m[3]), normalize(m[2], '/api', consts)]);
  }
  return found;
}

export function findClientCalls() {
  const calls = new Map();
  for (const sourceRoot of SOURCE_ROOTS) {
    for (const file of walk(path.join(root, sourceRoot))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const [method, p] of readCalls(src, readConstants(src))) {
        if (!p) continue;
        const key = `${method} ${p}`;
        if (!calls.has(key)) calls.set(key, new Set());
        calls.get(key).add(path.relative(root, file));
      }
    }
  }
  return calls;
}

const segments = p => p.split('/').filter(Boolean);

/** Does the client path (with `x1` wildcards) have the shape of this server route? */
export function pathMatches(clientPath, routePath) {
  const c = segments(clientPath);
  const r = segments(routePath);
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith('*') || r[i].startsWith('{*')) return c.length >= i;
    if (i >= c.length) return false;
    if (r[i].startsWith(':') || c[i] === 'x1') continue;
    if (/[._]$/.test(c[i]) ? !r[i].startsWith(c[i]) : c[i] !== r[i]) return false;
  }
  return c.length === r.length;
}

const methodMatches = (callMethod, routeMethod) =>
  routeMethod === callMethod || routeMethod === 'ALL';

/** Server route that a literal `METHOD /path` (`:id` allowed) names. */
const routeExists = (routes, spec) => {
  const [method, p] = spec.split(' ');
  return routes.some(
    route =>
      methodMatches(method, route.method) &&
      route.path.replace(/:\w+/g, ':') === p.replace(/:\w+/g, ':')
  );
};

/**
 * @param {{method:string,path:string}[]} routes the server route table
 * @returns {{unmatched: string[], missingDynamic: string[], checked: number}}
 */
export function checkContract(routes, calls = findClientCalls()) {
  const unmatched = [];
  for (const [key, files] of [...calls].sort(([a], [b]) => a.localeCompare(b))) {
    const [method, p] = key.split(' ');
    const ok = routes.some(
      route => methodMatches(method, route.method) && pathMatches(p, route.path)
    );
    if (!ok) unmatched.push(`${key}  <- ${[...files].slice(0, 2).join(', ')}`);
  }
  const missingDynamic = DYNAMIC_CALLS.flatMap(entry =>
    entry.routes
      .filter(spec => !routeExists(routes, spec))
      .map(spec => `${spec}  <- ${entry.source}`)
  );
  return { unmatched, missingDynamic, checked: calls.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const idx = process.argv.indexOf('--routes');
  let routes;
  if (idx > -1) {
    routes = JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8'));
  } else {
    const { dumpRoutes } = await import('./dump-routes.js');
    routes = await dumpRoutes();
  }
  const { unmatched, missingDynamic, checked } = checkContract(routes);
  for (const line of unmatched) console.log(`NO ROUTE    ${line}`);
  for (const line of missingDynamic) console.log(`NO ROUTE    ${line}  (dynamic call)`);
  console.log(
    `${checked} client calls checked against ${routes.length} routes: ` +
      `${unmatched.length + missingDynamic.length} without a server route`
  );
  process.exit(unmatched.length + missingDynamic.length ? 1 : 0);
}
