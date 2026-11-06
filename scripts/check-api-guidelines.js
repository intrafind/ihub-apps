#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * REST guideline ratchet for pull requests (docs/api-guidelines.md).
 *
 * The API predates the guidelines, so hundreds of lines in `server/` break them. This
 * script fails only on lines a change adds or modifies: new code meets the rules, old
 * code is brought in line as it is touched.
 *
 * What it looks for, on changed lines of `server/**\/*.js` (tests and migrations excluded):
 *
 *   hand-rolled-error  `res.status(4xx|5xx).json({ error … })` — throw a ServiceError instead
 *   success-envelope   `.json({ success: … })` / `.json({ message: '… successfully' })`
 *   status-422         `res.status(422)` — validation is 400 VALIDATION_FAILED
 *   route-verb         `router.post('/:id/run')` — a non-CRUD operation is an `_action` segment
 *   route-naming       a literal path segment that is not lower-case kebab-case
 *   pagination-param   `req.query.page|pageSize|offset|after|per_page` — use `limit` and `cursor`
 *   query-naming       a snake_case query parameter — query parameters are camelCase
 *
 * Endpoints that follow an external specification are exempt (see EXEMPT_FILES). A line
 * that has a good reason to break a rule carries `// api-guidelines-ignore: <reason>`
 * on the same or the previous line.
 *
 * Usage: node scripts/check-api-guidelines.js [base-ref]   (default: origin/main)
 *
 * Findings are printed as GitHub annotations, which show inline on the PR.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Files checked: server sources, not tests and not migrations. */
const CHECKED = /^server\/(?!tests\/|migrations\/).*\.js$/;

/** Endpoints whose shape an external specification fixes: OAuth, OIDC discovery, OpenAI, MCP. */
const EXEMPT_FILES =
  /^server\/routes\/(oauth|oauthAuthorize|oauthRegister|mcpOAuth|mcpServer|wellKnown|openaiProxy)\.js$|^server\/routes\/inference\//;

/** Last path segments that name an operation, not a resource. */
const ACTION_VERBS = [
  'run',
  'duplicate',
  'cancel',
  'rotate',
  'disconnect',
  'connect',
  'delete',
  'toggle',
  'enable',
  'disable',
  'sync',
  'refresh',
  'reload',
  'clear',
  'retry',
  'approve',
  'reject',
  'revoke',
  'restart',
  'reset',
  'test',
  'validate',
  'preview',
  'export',
  'import',
  'seen'
];

const IGNORE_MARKER = 'api-guidelines-ignore';
const PAGINATION_PARAMS = /^(page|pageSize|perPage|per_page|offset|after)$/;
const SNAKE_CASE = /^[a-z]+(_[a-z0-9]+)+$/;
const KEBAB_SEGMENT = /^[a-z][a-z0-9-]*(\.[a-z0-9]+)*$/;

const RULES = [
  {
    id: 'hand-rolled-error',
    pattern: /\.status\(\s*[45]\d\d\s*\)\s*\.(?:json|send)\(\s*\{[^}]*?\berror\s*:/gs,
    message:
      'Throw a ServiceError(code, message) instead of writing the error body; the error middleware shapes it (docs/api-guidelines.md#3-errors).'
  },
  {
    id: 'success-envelope',
    pattern: /\.json\(\s*\{\s*success\s*:/g,
    message:
      'No { success } envelope: the status code carries success. Return the resource, or 204 (docs/api-guidelines.md#2-methods-and-status-codes).'
  },
  {
    id: 'success-envelope',
    pattern: /\.json\(\s*\{[^}]*?\bmessage\s*:\s*(['"`])[^'"`\n]*\bsuccessfully\b/gs,
    message:
      "No { message: '… successfully' } envelope: return the resource, or 204 for a delete (docs/api-guidelines.md#2-methods-and-status-codes)."
  },
  {
    id: 'status-422',
    pattern: /\.status\(\s*422\s*\)/g,
    message:
      'Validation is 400 with code VALIDATION_FAILED, not 422 (docs/api-guidelines.md#2-methods-and-status-codes).'
  }
];

const ROUTE = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g;
const QUERY_PARAM = /\breq\.query\.([A-Za-z_][\w]*)/g;
const QUERY_DESTRUCTURE = /\{([^}]*)\}\s*=\s*req\.query\b/g;

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** A literal path segment: no parameter, template, wildcard or hidden-file part. */
function isLiteralSegment(segment) {
  return segment !== '' && !/[$:*{}()]/.test(segment) && !segment.startsWith('.');
}

/**
 * Violations of the REST guidelines in |source|.
 *
 * @param {string} source - File content
 * @param {string} file - Repository-relative path (exempt files give none)
 * @param {Set<number>|null} [changed] - Line numbers a change touched; null checks every line
 * @returns {{line: number, rule: string, message: string}[]}
 */
export function findViolations(source, file, changed = null) {
  if (EXEMPT_FILES.test(file)) return [];
  const lines = source.split('\n');
  const found = [];
  const seen = new Set();

  const add = (index, endIndex, rule, message) => {
    const line = lineOf(source, index);
    const endLine = lineOf(source, endIndex);
    if (changed) {
      let touched = false;
      for (let n = line; n <= endLine; n++) if (changed.has(n)) touched = true;
      if (!touched) return;
    }
    if (lines[line - 1]?.includes(IGNORE_MARKER) || lines[line - 2]?.includes(IGNORE_MARKER))
      return;
    const key = `${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ line, rule, message });
  };

  for (const { id, pattern, message } of RULES) {
    for (const match of source.matchAll(pattern)) {
      add(match.index, match.index + match[0].length, id, message);
    }
  }

  for (const match of source.matchAll(ROUTE)) {
    const [whole, method, , path] = match;
    // `app.get('platform')` reads an Express setting; a route starts with a slash or a template.
    if (!/^[/$]/.test(path)) continue;
    const segments = path.split('/');
    const last = segments[segments.length - 1];
    if (method !== 'get' && ACTION_VERBS.includes(last)) {
      add(
        match.index,
        match.index + whole.length,
        'route-verb',
        `'${path}' ends in a verb. A non-CRUD operation is an _action segment ('…/_${last}'), or a resource (docs/api-guidelines.md#actions-_action-segments).`
      );
    }
    for (const segment of segments) {
      if (!isLiteralSegment(segment) || segment.startsWith('_')) continue;
      if (!KEBAB_SEGMENT.test(segment)) {
        add(
          match.index,
          match.index + whole.length,
          'route-naming',
          `Path segment '${segment}' of '${path}' is not lower-case kebab-case (docs/api-guidelines.md#1-resources-and-urls).`
        );
        break;
      }
    }
  }

  const checkQueryName = (name, index, endIndex) => {
    if (PAGINATION_PARAMS.test(name)) {
      add(
        index,
        endIndex,
        'pagination-param',
        `Query parameter '${name}': lists page with 'limit' and an opaque 'cursor' and answer { items, nextCursor } (docs/api-guidelines.md#4-lists).`
      );
    } else if (SNAKE_CASE.test(name)) {
      add(
        index,
        endIndex,
        'query-naming',
        `Query parameter '${name}' is snake_case; query parameters are camelCase (docs/api-guidelines.md#1-resources-and-urls).`
      );
    }
  };
  for (const match of source.matchAll(QUERY_PARAM)) {
    checkQueryName(match[1], match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(QUERY_DESTRUCTURE)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':')[0].replace(/=.*/s, '').trim();
      if (name) checkQueryName(name, match.index, match.index + match[0].length);
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

/** Line numbers a zero-context hunk header ("@@ -a,b +c,d @@") adds or changes. */
function hunkLines(header) {
  const [, start, count = '1'] = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return Array.from({ length: Number(count) }, (_, i) => Number(start) + i);
}

/** Runs git with |args| (no shell). core.quotePath=false keeps non-ASCII paths unquoted. */
function git(...args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

/** Lines added or changed per checked file, from a zero-context diff against the merge base. */
function changedLines(base) {
  const diff = git(
    'diff',
    '--unified=0',
    '--diff-filter=ACMR',
    '--no-color',
    '--end-of-options',
    `${base}...HEAD`,
    '--',
    'server'
  );
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    // git ends the header with a tab when the path contains a space.
    const file = /^\+\+\+ b\/(.+?)\t?$/.exec(line)?.[1];
    if (file) {
      current = CHECKED.test(file) ? new Set() : null;
      if (current) files.set(file, current);
    } else if (current && line.startsWith('@@ ')) {
      for (const n of hunkLines(line)) current.add(n);
    }
  }
  return files;
}

function main() {
  const base = process.argv[2] || 'origin/main';
  // A ref, never an option: git would read "--output=…" as one.
  if (!/^\w[\w./~^@{}-]*$/.test(base)) {
    console.error(`Invalid base ref: ${base}`);
    process.exit(2);
  }

  const files = changedLines(base);
  if (files.size === 0) {
    console.log(`No server changes against ${base}; nothing to check.`);
    return;
  }

  let count = 0;
  for (const [file, lines] of files) {
    for (const v of findViolations(readFileSync(file, 'utf8'), file, lines)) {
      count++;
      console.log(
        `::error file=${file},line=${v.line},title=API guidelines (${v.rule})::${v.message}`
      );
    }
  }

  console.log(
    `\nChecked ${files.size} changed server file(s): ${count} API guideline violation(s) introduced by this change.`
  );
  if (count > 0) {
    console.log(
      `Fix them before merging; see docs/api-guidelines.md. A line with a real reason to break a rule carries "// ${IGNORE_MARKER}: <reason>".`
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
