// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Preloaded (`node --import`) into the server of the cross-user authorization
 * suite (`authz-server.mjs`). It changes nothing the server does: it remembers the
 * path every Express router was mounted on (Express 5 keeps no mount path on the
 * layer) and, when the server starts listening, writes every registered route
 * (method, full path, middleware names) to the JSON file named by
 * `AUTHZ_ROUTE_DUMP`. The suite's coverage guard reads that file, so the route
 * list is the live router stack, not a parse of the source.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
// The router module Express itself loads (server/node_modules/router).
const requireFromExpress = createRequire(
  createRequire(path.join(serverDir, 'package.json')).resolve('express')
);
const Router = requireFromExpress('router');

const originalUse = Router.prototype.use;
Router.prototype.use = function use(handler, ...rest) {
  let mountPath = '/';
  if (typeof handler !== 'function') {
    let arg = handler;
    while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
    if (typeof arg !== 'function') mountPath = handler;
  }
  const before = this.stack.length;
  const result = originalUse.call(this, handler, ...rest);
  for (let i = before; i < this.stack.length; i++) this.stack[i].authzMountPath = mountPath;
  return result;
};

function joinPath(prefix, segment) {
  if (segment instanceof RegExp) return `${prefix}<regexp:${segment.source}>`;
  const s = String(segment);
  if (s === '/' || s === '') return prefix || '/';
  return `${prefix.replace(/\/$/, '')}${s.startsWith('/') ? '' : '/'}${s}`;
}

function collect(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
      for (const p of paths) {
        for (const method of methods) {
          out.push({
            method: method === '_all' ? 'ALL' : method.toUpperCase(),
            path: joinPath(prefix, p),
            middleware: layer.route.stack.map(l => l.name)
          });
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const mounts = Array.isArray(layer.authzMountPath)
        ? layer.authzMountPath
        : [layer.authzMountPath ?? '/'];
      for (const mount of mounts) collect(layer.handle.stack, joinPath(prefix, mount), out);
    }
  }
  return out;
}

const target = process.env.AUTHZ_ROUTE_DUMP;
if (target) {
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function listen(...args) {
    const app = this.listeners('request').find(fn => fn && fn.router && fn.router.stack);
    if (app) {
      const routes = collect(app.router.stack, '', []);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(routes, null, 1)}\n`);
    }
    return originalListen.apply(this, args);
  };
}
