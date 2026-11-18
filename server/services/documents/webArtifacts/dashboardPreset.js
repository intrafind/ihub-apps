// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';
import { DocumentGenerationError } from '../renderService.js';
import { getSystemSkillsDirectory } from '../../skillLoader.js';
import { checkDashboardSpec } from './dashboardSpec.js';

/**
 * The page `create_dashboard` lays out.
 *
 * The model passes a small spec (title, summary, KPI tiles, bar and line
 * charts, tables, method, sources) instead of writing a whole HTML page, which
 * a model needs a minute or more to stream and rarely writes the same way
 * twice. The page is a fixed layout that ships with the `dashboard` system
 * skill (`server/systemSkills/dashboard/assets/dashboard.html`); this module
 * checks the spec (the Zod schema in `dashboardSpec.js`, which says precisely
 * what is wrong when it is not valid), warns of what looks wrong but may be
 * right (a date far from today), and puts the checked spec into that layout. The spec stays in the page as JSON, which
 * is what `edit_dashboard` changes ({@link dashboardSourceOf}).
 *
 * Nothing from the spec is interpreted as markup: the layout reads it as JSON
 * and writes it into the page with `textContent`, and the JSON itself is
 * escaped so it cannot end its own `<script>` element.
 *
 * @module services/documents/webArtifacts/dashboardPreset
 */

/** Months before today from which an `asOf` date is reported as old. */
export const STALE_AS_OF_MONTHS = 3;

const MAX_SPEC_BYTES = 1024 * 1024;

const fail = message => {
  throw new DocumentGenerationError(`Invalid dashboard "data": ${message}`, 'invalid');
};

export { checkDashboardSpec };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of the `asOf` day (UTC), in milliseconds. */
function asOfTime(asOf) {
  const [year, month, day] = asOf.split(/[-T ]/).map(Number);
  return Date.UTC(year, month - 1, day || 1);
}

/** Whole months from the `asOf` date to `now`; negative for a date after it. */
function monthsBefore(asOf, now) {
  const [year, month, day] = asOf.split(/[-T ]/).map(Number);
  const months = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month);
  return months - (now.getUTCDate() < (day || 1) ? 1 : 0);
}

/**
 * What looks wrong about a checked spec without making it unusable: the model
 * is told, so it reconsiders before it answers. Today that is the date of the
 * data: one months before today, or after it, is the mark of figures written
 * from memory instead of copied from the data of the conversation.
 *
 * @param {{asOf?: string}} spec - A checked spec ({@link checkDashboardSpec})
 * @param {{now?: Date}} [options] - `now` is for tests
 * @returns {string[]}
 */
export function dashboardWarnings(spec, { now = new Date() } = {}) {
  const warnings = [];
  if (!spec?.asOf) return warnings;
  const today = now.toISOString().slice(0, 10);
  const months = monthsBefore(spec.asOf, now);
  if (months > STALE_AS_OF_MONTHS) {
    warnings.push(
      `asOf "${spec.asOf}" is ${months} months before today (${today}). If the figures come from this conversation (a tool result, a file, a table the user gave), asOf is the date of that data: correct it, and check that every figure is copied from the data. If you wrote the figures from memory, do not: get them from a tool or ask the user. If the data really is that old, keep asOf and say so in the answer.`
    );
  } else if (asOfTime(spec.asOf) > now.getTime() + DAY_MS) {
    warnings.push(
      `asOf "${spec.asOf}" is after today (${today}). Use the date of the data, not a date that has not happened yet.`
    );
  }
  return warnings;
}

const escapeHtml = value =>
  String(value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/** JSON that cannot end its `<script>` element or break a line terminator. */
const scriptJson = value =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');

let layout = null;
function layoutHtml() {
  if (!layout) {
    layout = fs.readFileSync(
      path.join(getSystemSkillsDirectory(), 'dashboard', 'assets', 'dashboard.html'),
      'utf8'
    );
  }
  return layout;
}

/**
 * Check a spec and lay the page out.
 *
 * @param {unknown} data - The spec, as an object or as its JSON text
 * @returns {{html: string, spec: Object}} The complete HTML document and the checked spec it holds
 * @throws {DocumentGenerationError} When the spec is missing or not valid
 */
export function prepareDashboard(data) {
  let spec = data;
  if (typeof data === 'string' && !data.trim()) spec = undefined;
  else if (typeof data === 'string') {
    if (data.length > MAX_SPEC_BYTES) fail('it is larger than 1 MB; summarise the data.');
    try {
      spec = JSON.parse(data);
    } catch (error) {
      fail(`it is not valid JSON (${error.message}).`);
    }
  }
  if (spec === undefined || spec === null || spec === '') {
    fail('pass the dashboard spec as JSON text in "data".');
  }
  const checked = checkDashboardSpec(spec);
  const json = scriptJson(checked);
  if (json.length > MAX_SPEC_BYTES) fail('it is larger than 1 MB; summarise the data.');
  const values = { LANG: checked.lang || 'en', TITLE: escapeHtml(checked.title), DATA: json };
  // One pass with function lookup: a value that contains "{{DATA}}" is not expanded again.
  const html = layoutHtml().replace(/\{\{(LANG|TITLE|DATA)\}\}/g, (_, key) => values[key]);
  return { html, spec: checked };
}

/**
 * The dashboard page for a spec.
 *
 * @param {unknown} data - The spec, as an object or as its JSON text
 * @returns {string} A complete HTML document
 * @throws {DocumentGenerationError} When the spec is missing or not valid
 */
export function renderDashboard(data) {
  return prepareDashboard(data).html;
}

const EMBEDDED_SPEC_RE =
  /<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/;

/**
 * The spec a dashboard page was made from, read back out of its HTML, as the
 * indented JSON `edit_dashboard` changes and `chat_artifacts_read` shows. The
 * same spec always gives the same text, so an `oldText` copied from a read
 * matches the text an edit is applied to.
 *
 * @param {string} html - A stored `.html` file
 * @returns {{spec: Object, text: string}|null} null when the file is not a dashboard page
 */
export function dashboardSourceOf(html) {
  const match = EMBEDDED_SPEC_RE.exec(String(html || ''));
  if (!match) return null;
  try {
    const spec = JSON.parse(match[1]);
    return isObject(spec) ? { spec, text: JSON.stringify(spec, null, 2) } : null;
  } catch {
    return null;
  }
}
