#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Compares the server's route table with the one of a base ref and checks that
 * every route that disappeared (removed, renamed, or moved to another method) is
 * named in the unreleased release notes (`docs/releases/next/*.md`).
 *
 * A route counts as named when the notes contain its static prefix — the path up
 * to the first `:param`, so `DELETE /api/admin/x/:id` is covered by any mention
 * of `/api/admin/x` — or its last two literal segments (`/retention/run`), after
 * expanding the `{a,b}` groups the notes use. That is deliberately loose: the
 * point is that nobody can remove or rename an endpoint without the notes
 * saying where it lived.
 *
 * Usage:
 *   node scripts/check-route-changes.js [--base origin/main] [--strict] [--list]
 *     --strict  exit 1 when a removed route is not named in the notes
 *     --list    print every added and removed route
 *
 * The base is checked out into a temporary worktree (dependencies are linked from
 * this checkout), so it must be a ref git knows; the CI checkout needs history.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dumpRoutes } from './dump-routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const key = r => `${r.method} ${r.path.replace(/:\w+/g, ':')}`;

/** The route table of `ref`, dumped by this checkout's `dump-routes.js`. */
export function routesAtRef(ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-base-'));
  const work = path.join(tmp, 'wt');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('worktree', 'add', '--detach', work, ref);
    for (const dir of ['node_modules', 'server/node_modules', 'client/node_modules']) {
      if (fs.existsSync(path.join(root, dir))) {
        fs.symlinkSync(path.join(root, dir), path.join(work, dir));
      }
    }
    fs.copyFileSync(
      path.join(root, 'scripts/dump-routes.js'),
      path.join(work, 'scripts/dump-routes.js')
    );
    const out = path.join(tmp, 'routes.json');
    // process.execPath, not "node": the lookup must not depend on PATH.
    execFileSync(process.execPath, [path.join(work, 'scripts/dump-routes.js'), '--out', out], {
      cwd: work,
      stdio: 'pipe',
      env: { ...process.env, CONTENTS_DIR: process.env.CONTENTS_DIR || 'contents' }
    });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    try {
      git('worktree', 'remove', '--force', work);
    } catch {
      /* the temp directory is removed below */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      git('worktree', 'prune');
    } catch {
      /* nothing to prune */
    }
  }
}

/** `a/{b,c}/d` → `a/b/d a/c/d`: the notes group paths in braces to save space. */
function expandBraces(text) {
  let out = text;
  for (let i = 0; i < 4; i++) {
    out = out.replace(/(\S*)\{([^{}\s]+)\}(\S*)/g, (all, pre, group, post) =>
      group.includes(',')
        ? group
            .split(',')
            .map(alt => `${pre}${alt}${post}`)
            .join(' ')
        : all
    );
  }
  return out;
}

export function notesText() {
  const dir = path.join(root, 'docs/releases/next');
  const text = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n')
    .toLowerCase();
  return `${text}\n${expandBraces(text)}`;
}

/** What the notes may contain to name a route: its static prefix, or its last two literal segments. */
function mentions(routePath) {
  const prefix = routePath.split('/:')[0].toLowerCase();
  const literal = routePath
    .toLowerCase()
    .split('/')
    .filter(seg => seg && !seg.startsWith(':'));
  const tail = `/${literal.slice(-2).join('/')}`;
  return [prefix, prefix.replace(/^\/api/, ''), ...(literal.length > 1 ? [tail] : [])];
}

/** The base and head tables as sets of `METHOD path`, and what changed between them. */
export function diffRoutes(baseRoutes, headRoutes, notes = notesText()) {
  const head = new Set(headRoutes.map(key));
  const base = new Set(baseRoutes.map(key));
  const removed = baseRoutes.filter(r => !head.has(key(r)));
  const added = headRoutes.filter(r => !base.has(key(r)));
  const undocumented = removed.filter(r => {
    return !mentions(r.path).some(text => notes.includes(text));
  });
  return { removed, added, undocumented };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx > -1 ? argv[baseIdx + 1] : 'origin/main';
  const baseRoutes = routesAtRef(base);
  const headRoutes = await dumpRoutes();
  const { removed, added, undocumented } = diffRoutes(baseRoutes, headRoutes);
  if (argv.includes('--list')) {
    for (const r of removed) console.log(`REMOVED  ${r.method} ${r.path}`);
    for (const r of added) console.log(`ADDED    ${r.method} ${r.path}`);
  }
  for (const r of undocumented) {
    console.log(`UNDOCUMENTED  ${r.method} ${r.path} (removed, not named in docs/releases/next)`);
  }
  console.log(
    `${base}: ${baseRoutes.length} routes, now ${headRoutes.length}; ` +
      `${removed.length} removed, ${added.length} added, ${undocumented.length} removed without a release note`
  );
  process.exit(argv.includes('--strict') && undocumented.length ? 1 : 0);
}
