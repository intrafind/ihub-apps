#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Prints every route the server registers as JSON: `[{ method, path }]`, sorted.
 *
 * It registers the worker's routes (`server/startup/routes.js`) on a bare Express
 * app and reads the router stack — nothing listens, no config is changed and no
 * rate limit applies. Used by the client-contract test and by
 * `scripts/check-route-changes.js`.
 *
 * Usage:  node scripts/dump-routes.js --out <file>
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Walk an Express 5 router stack; `prefix` is the mount path collected so far. */
function collect(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const routePaths = [].concat(layer.route.path);
      for (const rp of routePaths) {
        const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
        // `app.all()` registers every HTTP method; list it once.
        const names = methods.length > 8 ? ['ALL'] : methods.map(m => m.toUpperCase());
        for (const name of names) out.add(`${name} ${join(prefix, rp)}`);
      }
    } else if (layer.handle?.stack) {
      collect(layer.handle.stack, join(prefix, mountPath(layer)), out);
    }
  }
}

function join(a, b) {
  const joined = `${a}/${b}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * The mount path of a `router.use(path, subRouter)` layer. Express 5 keeps only a
 * compiled matcher, so `recordMountPaths` tags the sub-router with its path.
 */
function mountPath(layer) {
  return layer.handle?.__mountPath ?? '';
}

/** Tag every router mounted with `use(path, router)` with that path. */
function recordMountPaths(router) {
  const proto = Object.getPrototypeOf(router);
  const original = proto.use;
  proto.use = function use(...args) {
    const [first, ...rest] = args;
    if (typeof first === 'string' || Array.isArray(first)) {
      for (const fn of rest.flat(Infinity)) {
        if (typeof fn === 'function' && Array.isArray(fn.stack)) {
          fn.__mountPath = [].concat(first)[0];
        }
      }
    }
    return original.apply(this, args);
  };
}

export async function dumpRoutes() {
  // express lives in server/node_modules, not next to this script.
  const express = createRequire(path.join(root, 'server', 'package.json'))('express');
  const { registerAllRoutes } = await import(path.join(root, 'server/startup/routes.js'));
  const app = express();
  recordMountPaths(app.router);
  await registerAllRoutes(app, {
    ownsClusterSingletons: false,
    isPackaged: false,
    rootDir: root,
    basePath: '',
    DEFAULT_TIMEOUT: 30000
  });
  const out = new Set();
  collect(app.router.stack, '', out);
  return [...out].sort().map(line => {
    const [method, ...rest] = line.split(' ');
    return { method, path: rest.join(' ') };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const routes = await dumpRoutes();
  const outIdx = process.argv.indexOf('--out');
  if (outIdx < 0 || !process.argv[outIdx + 1]) {
    // The server logs to stdout, so the table always goes to a file.
    console.error('usage: node scripts/dump-routes.js --out <file>');
    process.exit(2);
  }
  fs.writeFileSync(process.argv[outIdx + 1], `${JSON.stringify(routes, null, 2)}\n`);
  process.exit(0);
}
