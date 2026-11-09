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
 *                      (a body with `error_description` is RFC 6749/6750 and stays)
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
 * The script does not run git itself: it reads the zero-context diff of the change from
 * standard input, so it spawns no process and its core stays a pure function of text.
 *
 * Usage:
 *   git diff --unified=0 --diff-filter=ACMR --no-color origin/main...HEAD -- server \
 *     | node scripts/check-api-guidelines.js
 *
 * Findings are printed as GitHub annotations, which show inline on the PR.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Files checked: server sources, not tests and not migrations. */
const CHECKED = /^server\/(?!tests\/|migrations\/).*\.js$/;

/** Endpoints whose shape an external specification fixes: OAuth, OIDC discovery, OpenAI, MCP. */
const EXEMPT_FILES =
  /^server\/routes\/(oauth|oauthAuthorize|oauthRegister|mcpOAuth|mcpServer|wellKnown|openaiProxy)\.js$|^server\/routes\/inference\/|^server\/services\/inference\//;

/** Last path segments that name an operation, not a resource. */
const ACTION_VERBS = new Set([
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
]);

const IGNORE_MARKER = 'api-guidelines-ignore';
const PAGINATION_PARAMS = /^(page|pageSize|perPage|per_page|offset|after)$/;
const SNAKE_CASE = /^[a-z]+(_[a-z0-9]+)+$/;
const KEBAB_SEGMENT = /^[a-z][a-z0-9-]*(\.[a-z0-9]+)*$/;

const RULES = [
  {
    id: 'hand-rolled-error',
    // a status that is not a 1xx-3xx literal: 4xx, 5xx, or a variable (`error.status`)
    pattern: /\.status\((?!\s*[123]\d\d\s*\))[^()]*\)\s*\.(?:json|send)\(\s*\{[^}]*?\berror\s*:/gs,
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
const QUERY_PARAM = /\breq\.query\.([A-Za-z_]\w*)/g;
const QUERY_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*req\.query\b/g;
/** `const query = req.query || {}`: the name the rest of the handler reads the parameters by. */
const QUERY_ALIAS = /\b(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*req\.query\b/g;

/** 1-based line number of the character at |index|. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** A literal path segment: no parameter, template, wildcard or hidden-file part. */
function isLiteralSegment(segment) {
  return segment !== '' && !/[$:*{}()]/.test(segment) && !segment.startsWith('.');
}

/**
 * Collects violations of one file. `add` records one, unless the change did not touch
 * its lines, the line carries the ignore marker, or the same rule already fired there.
 */
function createReporter(source, changed) {
  const lines = source.split('\n');
  const found = [];
  const seen = new Set();

  const touched = (line, endLine) => {
    if (!changed) return true;
    for (let n = line; n <= endLine; n++) if (changed.has(n)) return true;
    return false;
  };

  const add = (index, endIndex, rule, message) => {
    const line = lineOf(source, index);
    if (!touched(line, lineOf(source, endIndex))) return;
    if (lines[line - 1]?.includes(IGNORE_MARKER) || lines[line - 2]?.includes(IGNORE_MARKER))
      return;
    const key = `${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ line, rule, message });
  };

  return { add, found };
}

/** `{ error, error_description }` is the body RFC 6749 / 6750 fix for OAuth and bearer tokens. */
function isRfc6749Body(source, index) {
  const end = source.indexOf('}', index);
  return end > -1 && /\berror_description\b/.test(source.slice(index, end));
}

function checkPatterns(source, add) {
  for (const { id, pattern, message } of RULES) {
    for (const match of source.matchAll(pattern)) {
      if (id === 'hand-rolled-error' && isRfc6749Body(source, match.index)) continue;
      add(match.index, match.index + match[0].length, id, message);
    }
  }
}

function checkRoute(match, add) {
  const [whole, method, , path] = match;
  // `app.get('platform')` reads an Express setting; a route starts with a slash or a template.
  if (!/^[/$]/.test(path)) return;
  const end = match.index + whole.length;
  const segments = path.split('/');
  const last = segments.at(-1);
  if (method !== 'get' && ACTION_VERBS.has(last)) {
    add(
      match.index,
      end,
      'route-verb',
      `'${path}' ends in a verb. A non-CRUD operation is an _action segment ('…/_${last}'), or a resource (docs/api-guidelines.md#actions-_action-segments).`
    );
  }
  const badSegment = segments.find(
    segment => isLiteralSegment(segment) && !segment.startsWith('_') && !KEBAB_SEGMENT.test(segment)
  );
  if (badSegment !== undefined) {
    add(
      match.index,
      end,
      'route-naming',
      `Path segment '${badSegment}' of '${path}' is not lower-case kebab-case (docs/api-guidelines.md#1-resources-and-urls).`
    );
  }
}

function checkRoutes(source, add) {
  for (const match of source.matchAll(ROUTE)) checkRoute(match, add);
}

function checkQueryName(name, index, endIndex, add) {
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
}

function checkQueryParams(source, add) {
  for (const [, alias] of source.matchAll(QUERY_ALIAS)) {
    const aliased = new RegExp(`\\b${alias}\\.([A-Za-z_]\\w*)`, 'g');
    for (const match of source.matchAll(aliased)) {
      checkQueryName(match[1], match.index, match.index + match[0].length, add);
    }
  }
  for (const match of source.matchAll(QUERY_PARAM)) {
    checkQueryName(match[1], match.index, match.index + match[0].length, add);
  }
  for (const match of source.matchAll(QUERY_DESTRUCTURE)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':')[0].replace(/=.*/s, '').trim();
      if (name) checkQueryName(name, match.index, match.index + match[0].length, add);
    }
  }
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
  const { add, found } = createReporter(source, changed);
  checkPatterns(source, add);
  checkRoutes(source, add);
  checkQueryParams(source, add);
  return found.sort((a, b) => a.line - b.line);
}

/** Line numbers a zero-context hunk header ("@@ -a,b +c,d @@") adds or changes. */
function hunkLines(header) {
  const [, start, count = '1'] = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return Array.from({ length: Number(count) }, (_, i) => Number(start) + i);
}

/**
 * The lines a unified diff (made with `--unified=0`) adds or changes, per checked file.
 *
 * @param {string} diff - Output of `git diff --unified=0 --no-color`
 * @returns {Map<string, Set<number>>}
 */
export function parseChangedLines(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    // git ends the header with a tab when the path contains a space.
    const file = /^\+\+\+ b\/(.+?)\t?$/.exec(line)?.[1];
    if (file) {
      current = CHECKED.test(file) && !file.includes('..') ? new Set() : null;
      if (current) files.set(file, current);
    } else if (current && line.startsWith('@@ ')) {
      for (const n of hunkLines(line)) current.add(n);
    }
  }
  return files;
}

/**
 * The whole of stdin. Not `readFileSync(0)`: a pipe is non-blocking, so that
 * throws EAGAIN whenever the producer (`git diff`) has not written yet.
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.stdin.isTTY) {
    console.error(
      'Pipe the diff in: git diff --unified=0 --diff-filter=ACMR --no-color origin/main...HEAD -- server | node scripts/check-api-guidelines.js'
    );
    process.exit(2);
  }

  const files = parseChangedLines(await readStdin());
  if (files.size === 0) {
    console.log('No changed server files to check.');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
