#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Observability guideline ratchet for pull requests (docs/observability-guidelines.md).
 *
 * Like `check-api-guidelines.js`, it fails only on lines a change adds or modifies, so new
 * code follows the rules and existing code is brought in line as it is touched.
 *
 * What it looks for, on changed lines of `server/**\/*.js` (tests excluded):
 *
 *   raw-tracer          `getTracer(` outside `server/telemetry/` — start spans through the
 *                       helpers of `server/telemetry/spans.js` / `traces.js`
 *   raw-instrument      `createCounter|createHistogram|createUpDownCounter|createObservableGauge(`
 *                       outside `server/telemetry/` — define instruments in `metrics.js`
 *   record-exception    `recordException(` anywhere but the span helper — provider errors echo
 *                       prompts and keys; set `error.type` (span.fail)
 *   raw-user-id         a `'user.id'` attribute outside `server/telemetry/identity.js` — name a
 *                       user only through `userSpanAttributes()`
 *
 * A line with a good reason carries `// observability-guidelines-ignore: <reason>` on the
 * same or the previous line.
 *
 * Usage:
 *   git diff --unified=0 --diff-filter=ACMR --no-color origin/main...HEAD -- server \
 *     | node scripts/check-observability-guidelines.js
 *
 * Findings are printed as GitHub annotations, which show inline on the PR.
 */

import { defineRatchet } from './lib/guidelineRatchet.js';

/** Files checked: server sources, not tests. */
const CHECKED = /^server\/(?!tests\/|node_modules\/).*\.(?:js|mjs)$/;

/** Where telemetry is implemented: the rules about using its helpers do not apply there. */
const TELEMETRY_DIR = /^server\/telemetry\//;

const IGNORE_MARKER = 'observability-guidelines-ignore';

const RULES = [
  {
    id: 'raw-tracer',
    pattern: /\bgetTracer\s*\(/g,
    applies: file => !TELEMETRY_DIR.test(file),
    message:
      'Start spans through server/telemetry/spans.js (withSpan / startSpan) or traces.js, not trace.getTracer() (docs/observability-guidelines.md#3-spans).'
  },
  {
    id: 'raw-instrument',
    pattern: /\bcreate(?:Counter|Histogram|UpDownCounter|ObservableGauge|ObservableCounter)\s*\(/g,
    applies: file => !TELEMETRY_DIR.test(file),
    message:
      'Define metric instruments in server/telemetry/metrics.js behind a recordX() function (docs/observability-guidelines.md#4-metrics).'
  },
  {
    id: 'record-exception',
    pattern: /\brecordException\s*\(/g,
    applies: file => file !== 'server/telemetry/spans.js',
    message:
      'Do not record exceptions on spans: provider errors echo prompts and keys. Use span.fail(err), which sets error.type (docs/observability-guidelines.md#3-spans).'
  },
  {
    id: 'raw-user-id',
    pattern: /['"]user\.id['"]\s*[:,\]]/g,
    applies: file =>
      file !== 'server/telemetry/identity.js' && file !== 'server/telemetry/spans.js',
    message:
      'Name a user on a span only through userSpanAttributes() in server/telemetry/identity.js, never as a raw user.id (docs/observability-guidelines.md#5-privacy-and-security).'
  }
];

/** 1-based line number of a character offset. */
function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Whether a line, or the one before it, carries the ignore marker. */
function ignored(lines, line) {
  return [lines[line - 1], lines[line - 2]].some(text => text?.includes(IGNORE_MARKER));
}

/**
 * The violations on the changed lines of one file.
 *
 * @param {string} source - The file's content
 * @param {string} file - Repository-relative path
 * @param {Set<number>} changed - Line numbers the change adds or modifies
 * @returns {Array<{line: number, rule: string, message: string}>}
 */
export function findViolations(source, file, changed) {
  const lines = source.split('\n');
  const found = [];
  for (const rule of RULES) {
    if (!rule.applies(file)) continue;
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const line = lineOf(source, match.index);
      if (!changed.has(line) || ignored(lines, line)) continue;
      found.push({ line, rule: rule.id, message: rule.message });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** The lines a unified diff (`--unified=0`) adds or changes, per checked file. */
export const { parseChangedLines } = defineRatchet(import.meta.url, {
  script: 'scripts/check-observability-guidelines.js',
  checked: CHECKED,
  findViolations,
  title: 'Observability guidelines',
  docs: 'docs/observability-guidelines.md',
  ignoreMarker: IGNORE_MARKER
});
