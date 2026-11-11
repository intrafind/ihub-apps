// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs';
import path from 'node:path';
import { DocumentGenerationError } from '../renderService.js';
import { getSystemSkillsDirectory } from '../../skillLoader.js';

/**
 * The `dashboard` preset of `create_web_artifact`.
 *
 * The model passes a small JSON spec (title, summary, KPI tiles, bar and line
 * charts, tables, method, sources) instead of writing a whole HTML page, which
 * a model needs a minute or more to stream and rarely writes the same way
 * twice. The page is a fixed layout that ships with the `dashboard` system
 * skill (`server/systemSkills/dashboard/assets/dashboard.html`); this module
 * checks the spec, says precisely what is wrong when it is not valid, and puts
 * the checked spec into that layout.
 *
 * Nothing from the spec is interpreted as markup: the layout reads it as JSON
 * and writes it into the page with `textContent`, and the JSON itself is
 * escaped so it cannot end its own `<script>` element.
 *
 * @module services/documents/webArtifacts/dashboardPreset
 */

export const DASHBOARD_PRESET = 'dashboard';

const MAX_SPEC_BYTES = 1024 * 1024;
const FORMATS = new Set(['int', 'decimal', 'percent', 'compact', 'text', 'status']);
const BLOCK_TYPES = ['bars', 'line', 'table', 'text'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const fail = message => {
  throw new DocumentGenerationError(`Invalid dashboard "data": ${message}`, 'invalid');
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

/** A text value (a number is taken as its text), trimmed and length-checked. */
function text(where, value, { max = 300, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${where} is required.`);
    return undefined;
  }
  if (typeof value !== 'string' && !isNumber(value)) fail(`${where} must be text.`);
  const result = String(value).trim();
  if (result.length > max) fail(`${where} is longer than ${max} characters.`);
  if (!result && required) fail(`${where} is required.`);
  return result || undefined;
}

function list(where, value, { min = 0, max }) {
  if (value === undefined || value === null) {
    if (min > 0) fail(`${where} is required.`);
    return [];
  }
  if (!Array.isArray(value)) fail(`${where} must be an array.`);
  if (value.length < min) fail(`${where} needs at least ${min} entr${min === 1 ? 'y' : 'ies'}.`);
  if (value.length > max) fail(`${where} has more than ${max} entries; summarise or cut it.`);
  return value;
}

function format(where, value) {
  if (value === undefined || value === null) return undefined;
  if (!FORMATS.has(value)) fail(`${where} must be one of ${[...FORMATS].join(', ')}.`);
  return value;
}

const compact = object =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function checkBars(where, block) {
  const items = list(`${where}.items`, block.items, { min: 1, max: 500 }).map((item, i) => {
    if (!isObject(item)) fail(`${where}.items[${i}] must be an object {label, value}.`);
    if (!isNumber(item.value) || item.value < 0) {
      fail(
        `${where}.items[${i}].value must be a number that is not negative (got ${JSON.stringify(item.value)}).`
      );
    }
    return compact({
      label: text(`${where}.items[${i}].label`, item.label, { max: 200, required: true }),
      value: item.value,
      note: text(`${where}.items[${i}].note`, item.note, { max: 300 })
    });
  });
  const marks = list(`${where}.marks`, block.marks, { max: 6 }).map((mark, i) => {
    if (!isObject(mark) || !isNumber(mark.value))
      fail(`${where}.marks[${i}] must be {label, value} with a number value.`);
    return {
      label: text(`${where}.marks[${i}].label`, mark.label, { max: 40, required: true }),
      value: mark.value
    };
  });
  if (block.sort !== undefined && !['desc', 'none'].includes(block.sort)) {
    fail(`${where}.sort must be "desc" (default) or "none".`);
  }
  if (
    block.top !== undefined &&
    !(Number.isInteger(block.top) && block.top >= 1 && block.top <= 50)
  ) {
    fail(`${where}.top must be a whole number from 1 to 50.`);
  }
  return {
    items,
    ...(marks.length ? { marks } : {}),
    ...compact({
      format: format(`${where}.format`, block.format),
      share: block.share === true ? true : undefined,
      top: block.top,
      sort: block.sort,
      otherLabel: text(`${where}.otherLabel`, block.otherLabel, { max: 80 }),
      labelHeader: text(`${where}.labelHeader`, block.labelHeader, { max: 60 }),
      valueHeader: text(`${where}.valueHeader`, block.valueHeader, { max: 60 })
    })
  };
}

function checkLine(where, block) {
  const x = list(`${where}.x`, block.x, { min: 1, max: 500 }).map((label, i) =>
    text(`${where}.x[${i}]`, label, { max: 60, required: true })
  );
  const series = list(`${where}.series`, block.series, { min: 1, max: 8 }).map((s, i) => {
    if (!isObject(s)) fail(`${where}.series[${i}] must be an object {name, values}.`);
    const values = list(`${where}.series[${i}].values`, s.values, { min: 1, max: 500 });
    if (values.length !== x.length) {
      fail(
        `${where}.series[${i}].values has ${values.length} entries but ${where}.x has ${x.length}; they must match one to one (use null for a gap).`
      );
    }
    values.forEach((v, k) => {
      if (v !== null && !isNumber(v))
        fail(`${where}.series[${i}].values[${k}] must be a number or null.`);
    });
    return {
      name: text(`${where}.series[${i}].name`, s.name, { max: 80, required: true }),
      values
    };
  });
  return {
    x,
    series,
    ...compact({
      format: format(`${where}.format`, block.format),
      xHeader: text(`${where}.xHeader`, block.xHeader, { max: 60 })
    })
  };
}

function checkTable(where, block) {
  const columns = list(`${where}.columns`, block.columns, { min: 1, max: 20 }).map((c, i) => {
    if (!isObject(c)) fail(`${where}.columns[${i}] must be an object {key, label}.`);
    if (c.align !== undefined && !['left', 'right'].includes(c.align)) {
      fail(`${where}.columns[${i}].align must be "left" or "right".`);
    }
    return compact({
      key: text(`${where}.columns[${i}].key`, c.key, { max: 60, required: true }),
      label: text(`${where}.columns[${i}].label`, c.label, { max: 80, required: true }),
      format: format(`${where}.columns[${i}].format`, c.format),
      align: c.align
    });
  });
  const keys = new Set(columns.map(c => c.key));
  if (keys.size !== columns.length) fail(`${where}.columns has a key twice.`);
  const rows = list(`${where}.rows`, block.rows, { min: 1, max: 2000 }).map((row, i) => {
    if (!isObject(row)) fail(`${where}.rows[${i}] must be an object keyed by column key.`);
    const out = {};
    for (const key of keys) {
      const cell = row[key];
      if (cell === undefined || cell === null || typeof cell === 'string' || isNumber(cell)) {
        if (cell !== undefined) out[key] = typeof cell === 'string' ? cell.slice(0, 500) : cell;
      } else if (isObject(cell) && typeof cell.text === 'string') {
        out[key] = compact({ text: cell.text.slice(0, 200), status: cell.status });
      } else {
        fail(`${where}.rows[${i}].${key} must be text, a number, null or {text, status}.`);
      }
    }
    return out;
  });
  if (block.sort !== undefined) {
    if (!isObject(block.sort) || !keys.has(block.sort.key))
      fail(`${where}.sort.key must be one of the column keys.`);
    if (block.sort.dir !== undefined && !['asc', 'desc'].includes(block.sort.dir))
      fail(`${where}.sort.dir must be "asc" or "desc".`);
  }
  if (
    block.visibleRows !== undefined &&
    !(Number.isInteger(block.visibleRows) && block.visibleRows >= 0 && block.visibleRows <= 200)
  ) {
    fail(`${where}.visibleRows must be a whole number from 0 (all rows) to 200.`);
  }
  return {
    columns,
    rows,
    ...compact({
      visibleRows: block.visibleRows,
      sort: block.sort ? compact({ key: block.sort.key, dir: block.sort.dir }) : undefined
    })
  };
}

function checkText(where, block) {
  return {
    paragraphs: list(`${where}.paragraphs`, block.paragraphs, { min: 1, max: 20 }).map((p, i) =>
      text(`${where}.paragraphs[${i}]`, p, { max: 2000, required: true })
    )
  };
}

const BLOCK_CHECKS = { bars: checkBars, line: checkLine, table: checkTable, text: checkText };

/**
 * Check a dashboard spec and return the part of it the page reads.
 *
 * @param {unknown} spec - Parsed JSON
 * @returns {Object} The checked spec, with unknown fields dropped
 * @throws {DocumentGenerationError} With a message that names the field at fault
 */
export function checkDashboardSpec(spec) {
  if (!isObject(spec)) fail('it must be a JSON object.');
  if (spec.lang !== undefined && !(typeof spec.lang === 'string' && LANG_RE.test(spec.lang))) {
    fail('lang must be a language code such as "en" or "de".');
  }

  const sources = list('sources', spec.sources, { max: 20 }).map((s, i) => {
    if (!isObject(s)) fail(`sources[${i}] must be an object {id, name}.`);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id))
      fail(`sources[${i}].id must be letters, digits, "-" or "_" (at most 40).`);
    return compact({
      id: s.id,
      name: text(`sources[${i}].name`, s.name, { max: 120, required: true }),
      description: text(`sources[${i}].description`, s.description, { max: 800 }),
      formula: text(`sources[${i}].formula`, s.formula, { max: 2000 })
    });
  });
  const sourceIds = new Set(sources.map(s => s.id));
  if (sourceIds.size !== sources.length) fail('sources has an id twice.');

  const kpis = list('kpis', spec.kpis, { max: 8 }).map((k, i) => {
    if (!isObject(k)) fail(`kpis[${i}] must be an object {label, value}.`);
    if (!(isNumber(k.value) || (typeof k.value === 'string' && k.value.trim()))) {
      fail(`kpis[${i}].value must be a number or a text.`);
    }
    return compact({
      label: text(`kpis[${i}].label`, k.label, { max: 80, required: true }),
      value: typeof k.value === 'string' ? k.value.trim().slice(0, 40) : k.value,
      format: format(`kpis[${i}].format`, k.format),
      note: text(`kpis[${i}].note`, k.note, { max: 160 })
    });
  });

  const blocks = list('blocks', spec.blocks, { max: 20 }).map((block, i) => {
    const where = `blocks[${i}]`;
    if (!isObject(block) || !BLOCK_TYPES.includes(block.type)) {
      fail(`${where}.type must be one of ${BLOCK_TYPES.join(', ')}.`);
    }
    const source = text(`${where}.source`, block.source, { max: 40 });
    if (source && !sourceIds.has(source))
      fail(`${where}.source "${source}" is not the id of an entry in "sources".`);
    return {
      type: block.type,
      ...compact({
        title: text(`${where}.title`, block.title, { max: 160, required: block.type !== 'text' }),
        description: text(`${where}.description`, block.description, { max: 500 }),
        source
      }),
      ...BLOCK_CHECKS[block.type](where, block)
    };
  });
  if (!blocks.length && !kpis.length) fail('give at least one entry in "kpis" or "blocks".');

  let method;
  if (spec.method !== undefined && spec.method !== null) {
    if (!isObject(spec.method)) fail('method must be an object {title, paragraphs}.');
    method = compact({
      title: text('method.title', spec.method.title, { max: 120 }),
      paragraphs: list('method.paragraphs', spec.method.paragraphs, { max: 10 }).map((p, i) =>
        text(`method.paragraphs[${i}]`, p, { max: 1200, required: true })
      )
    });
  }

  let labels;
  if (spec.labels !== undefined && spec.labels !== null) {
    if (!isObject(spec.labels)) fail('labels must be an object of interface texts.');
    labels = Object.fromEntries(
      Object.entries(spec.labels)
        .filter(([key, value]) => /^[A-Za-z]{1,20}$/.test(key) && typeof value === 'string')
        .map(([key, value]) => [key, value.slice(0, 120)])
    );
  }

  const notes = list('notes', spec.notes, { max: 6 }).map((n, i) =>
    text(`notes[${i}]`, n, { max: 400, required: true })
  );

  return compact({
    lang: spec.lang,
    title: text('title', spec.title, { max: 200, required: true }),
    summary: text('summary', spec.summary, { max: 800 }),
    notes: notes.length ? notes : undefined,
    asOf: text('asOf', spec.asOf, { max: 60 }),
    kpis: kpis.length ? kpis : undefined,
    blocks: blocks.length ? blocks : undefined,
    method: method?.paragraphs?.length ? method : undefined,
    sources: sources.length ? sources : undefined,
    labels: labels && Object.keys(labels).length ? labels : undefined
  });
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
 * The dashboard page for a spec.
 *
 * @param {unknown} data - The spec, as an object or as its JSON text
 * @returns {string} A complete HTML document
 * @throws {DocumentGenerationError} When the spec is missing or not valid
 */
export function renderDashboard(data) {
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
  return layoutHtml().replace(/\{\{(LANG|TITLE|DATA)\}\}/g, (_, key) => values[key]);
}
