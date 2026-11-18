// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { DocumentGenerationError } from '../renderService.js';

/**
 * The dashboard spec: what a model passes to `create_dashboard` as `data`.
 *
 * One Zod schema says what a spec may hold (fields, limits, formats), and the
 * few rules that look across fields live next to it (`blockRules`,
 * `specRules`). The model reads the messages, so every schema carries its own
 * wording ("must be a number (got "97,529")."), and {@link describeIssue} puts
 * the path in front: "blocks[0].items[1].value must be a number (got ...)."
 * Unlike a fail-fast check, a spec with several faults reports them all at
 * once (up to {@link MAX_PROBLEMS}), so the model fixes them in one call.
 *
 * The result is the part of the spec the page reads: unknown fields are
 * dropped, text is trimmed, empty optional values and empty lists are left
 * out. Stored dashboards carry this checked spec (`dashboardPreset.js`), so
 * its shape is what `edit_dashboard` and `chat_artifacts_read` show.
 *
 * @module services/documents/webArtifacts/dashboardSpec
 */

/** Most faults one message lists; a spec with more is far from valid anyway. */
const MAX_PROBLEMS = 8;

const FORMATS = ['int', 'decimal', 'percent', 'compact', 'text', 'status'];
export const BLOCK_TYPES = ['bars', 'line', 'table', 'text'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const LABEL_KEY_RE = /^[A-Za-z]{1,20}$/;
// The date of the data: `2026-11-09`, `2026-11` or a timestamp (`2026-11-09T10:15:00Z`), checked in parts.
const AS_OF_DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const AS_OF_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const AS_OF_TIME_RE = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const absent = value => value === undefined || value === null;

// ── building blocks ─────────────────────────────────────────────────────────
// Messages here start after the path: the formatter adds "blocks[0].title".

/** A missing value, `null` included, reads as "required"; a value of the wrong type as the type. */
const typeError = (required, wrong) => iss => (absent(iss.input) ? required : wrong);

const numberAsText = value => (isNumber(value) ? String(value) : value);

/**
 * Text: a number is taken as its text, the value is trimmed and length-checked.
 * Optional text treats `""` and `null` as absent.
 */
function text({ max = 300, required = false } = {}) {
  const base = z
    .string({ error: typeError('is required.', 'must be text.') })
    .trim()
    .max(max, `is longer than ${max} characters.`);
  if (required) return z.preprocess(numberAsText, base.min(1, 'is required.'));
  return z
    .preprocess(
      value => (value === '' || value === null ? undefined : numberAsText(value)),
      base.optional()
    )
    .transform(value => value || undefined);
}

const number = z.number({ error: iss => `must be a number (got ${JSON.stringify(iss.input)}).` });

/** A whole number from `min` to `max`, optional. */
function whole(min, max, message) {
  return optional(z.number({ error: message }).int(message).min(min, message).max(max, message));
}

/** `null` is as good as absent for an optional value. */
const optional = schema =>
  z.preprocess(value => (value === null ? undefined : value), schema.optional());

const oneOf = (values, message = `must be one of ${values.join(', ')}.`) =>
  z.enum(values, { error: message });

/** A list of `min` to `max` entries; a list that is not required may be left out. */
function list(item, { min = 0, max }) {
  let array = z.array(item, { error: typeError('is required.', 'must be an array.') });
  if (min > 0) array = array.min(min, `needs at least ${min} entr${min === 1 ? 'y' : 'ies'}.`);
  array = array.max(max, `has more than ${max} entries; summarise or cut it.`);
  return min > 0 ? array : optional(array);
}

/** An object of known fields (the others are dropped); `hint` says what it looks like. */
const object = (shape, hint = '') => {
  const looksLike = hint ? ` ${hint}` : '';
  return z.object(shape, { error: `must be an object${looksLike}.` });
};

// ── the parts of a spec ─────────────────────────────────────────────────────

const kpi = object(
  {
    label: text({ max: 80, required: true }),
    value: z.union(
      [
        z.number(),
        z
          .string()
          .trim()
          .min(1)
          .transform(value => value.slice(0, 40))
      ],
      {
        error: 'must be a number or a text.'
      }
    ),
    format: optional(oneOf(FORMATS)),
    note: text({ max: 160 })
  },
  '{label, value}'
);

const idMessage = 'must be letters, digits, "-" or "_" (at most 40).';
const source = object(
  {
    id: z.string({ error: idMessage }).regex(ID_RE, idMessage),
    name: text({ max: 120, required: true }),
    description: text({ max: 800 }),
    formula: text({ max: 2000 }),
    ref: text({ max: 300 }),
    url: text({ max: 500 }).superRefine((url, ctx) => {
      if (url !== undefined && !URL_RE.test(url)) {
        ctx.addIssue({
          code: 'custom',
          message: `must be an http(s) address without spaces (got ${JSON.stringify(url)}).`
        });
      }
    })
  },
  '{id, name}'
);

/** The fields every block has, `type` first. */
const blockHead = (type, { titled = true } = {}) => ({
  type: z.literal(type),
  title: text({ max: 160, required: titled }),
  description: text({ max: 500 }),
  source: text({ max: 40 })
});

const barsShape = {
  ...blockHead('bars'),
  items: list(
    object(
      { label: text({ max: 200, required: true }), value: number, note: text({ max: 300 }) },
      '{label, value}'
    ),
    { min: 1, max: 500 }
  ),
  marks: list(
    object(
      { label: text({ max: 40, required: true }), value: number },
      '{label, value} with a number value'
    ),
    { max: 6 }
  ),
  format: optional(oneOf(FORMATS)),
  share: z.preprocess(value => (value === true ? true : undefined), z.literal(true).optional()),
  top: whole(1, 50, 'must be a whole number from 1 to 50.'),
  sort: optional(oneOf(['desc', 'none'], 'must be "desc" (default) or "none".')),
  otherLabel: text({ max: 80 }),
  labelHeader: text({ max: 60 }),
  valueHeader: text({ max: 60 })
};

const lineShape = {
  ...blockHead('line'),
  x: list(text({ max: 60, required: true }), { min: 1, max: 500 }),
  series: list(
    object(
      {
        name: text({ max: 80, required: true }),
        values: list(z.number({ error: 'must be a number or null.' }).nullable(), {
          min: 1,
          max: 500
        })
      },
      '{name, values}'
    ),
    { min: 1, max: 8 }
  ),
  format: optional(oneOf(FORMATS)),
  xHeader: text({ max: 60 })
};

const tableShape = {
  ...blockHead('table'),
  columns: list(
    object(
      {
        key: text({ max: 60, required: true }),
        label: text({ max: 80, required: true }),
        format: optional(oneOf(FORMATS)),
        align: optional(oneOf(['left', 'right'], 'must be "left" or "right".'))
      },
      '{key, label}'
    ),
    { min: 1, max: 20 }
  ),
  rows: list(
    z.record(z.string(), z.unknown(), { error: 'must be an object keyed by column key.' }),
    {
      min: 1,
      max: 2000
    }
  ),
  visibleRows: whole(0, 200, 'must be a whole number from 0 (all rows) to 200.'),
  sort: optional(
    object(
      {
        key: z.string({ error: 'must be one of the column keys.' }),
        dir: optional(oneOf(['asc', 'desc'], 'must be "asc" or "desc".'))
      },
      '{key, dir}'
    )
  )
};

const textShape = {
  ...blockHead('text', { titled: false }),
  paragraphs: list(text({ max: 2000, required: true }), { min: 1, max: 20 })
};

/** What a table cell may hold: text, a number, nothing, or `{text, status}`. */
const isCell = cell =>
  cell === undefined ||
  cell === null ||
  typeof cell === 'string' ||
  isNumber(cell) ||
  (isObject(cell) && typeof cell.text === 'string');

/** Rules that look across the fields of one block. Paths are relative to the block. */
function blockRules(block, ctx) {
  const problem = (path, message) => ctx.addIssue({ code: 'custom', path, message });
  if (block.type === 'bars' && block.share) {
    // A bar is drawn left of the zero line when it is negative (a loss, a decline).
    // Parts of a whole are never negative, so a share of them is refused here.
    block.items.forEach((item, i) => {
      if (item.value < 0) {
        problem(
          ['items', i, 'value'],
          `is negative (${item.value}), which "share" cannot show: parts of a whole are not negative. Remove "share" from this block, or leave the item out.`
        );
      }
    });
  }
  if (block.type === 'line') {
    block.series.forEach((s, i) => {
      if (s.values.length !== block.x.length) {
        // `{block}` becomes the path of the block: the formatter knows the index.
        problem(
          ['series', i, 'values'],
          `has ${s.values.length} entries but {block}.x has ${block.x.length}; they must match one to one (use null for a gap).`
        );
      }
    });
  }
  if (block.type === 'table') {
    const keys = new Set(block.columns.map(column => column.key));
    if (keys.size !== block.columns.length) problem(['columns'], 'has a key twice.');
    if (block.sort && !keys.has(block.sort.key))
      problem(['sort', 'key'], 'must be one of the column keys.');
    block.rows.forEach((row, i) => {
      for (const key of keys) {
        if (!isCell(row[key]))
          problem(['rows', i, key], 'must be text, a number, null or {text, status}.');
      }
    });
  }
}

/** The block as the page reads it: table cells only of known columns, long texts cut. */
function cleanBlock(block) {
  if (block.type === 'bars' && !block.marks?.length) delete block.marks;
  if (block.type === 'table') {
    const keys = block.columns.map(column => column.key);
    block.rows = block.rows.map(row =>
      Object.fromEntries(
        keys
          .filter(key => row[key] !== undefined)
          .map(key => {
            const cell = row[key];
            if (typeof cell === 'string') return [key, cell.slice(0, 500)];
            if (isObject(cell))
              return [key, { text: cell.text.slice(0, 200), status: cell.status }];
            return [key, cell];
          })
      )
    );
  }
  return block;
}

const block = z
  .discriminatedUnion(
    'type',
    [z.object(barsShape), z.object(lineShape), z.object(tableShape), z.object(textShape)],
    {
      // An object without a usable `type` is reported at its `type`; anything else at the block.
      error: iss =>
        isObject(iss.input)
          ? `must be one of ${BLOCK_TYPES.join(', ')}.`
          : `must be an object whose "type" is one of ${BLOCK_TYPES.join(', ')}.`
    }
  )
  .superRefine(blockRules)
  .transform(cleanBlock);

/** The date of the data, as `YYYY-MM-DD`, `YYYY-MM` or a timestamp. */
export function isDateOfData(value) {
  const [date, ...times] = String(value).split(/[T ]/);
  const match = AS_OF_DATE_RE.exec(date);
  if (!match) return false;
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 1;
  // A time of day belongs to a whole date, and there is at most one.
  const timeFits =
    times.length === 0 ||
    (match[3] !== undefined &&
      times.length === 1 &&
      AS_OF_TIME_RE.test(times[0].replace(AS_OF_ZONE_RE, '')));
  return timeFits && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

const asOf = text({ max: 40, required: true }).superRefine((value, ctx) => {
  if (!isDateOfData(value)) {
    ctx.addIssue({
      code: 'custom',
      message: `must be the date of the data as YYYY-MM-DD (for example "2026-11-09"), got ${JSON.stringify(value)}. Take it from the data itself (a tool result, the file, the user), never from your own idea of the date.`
    });
  }
});

const langMessage = 'must be a language code such as "en" or "de".';

const pageShape = {
  lang: z.string({ error: langMessage }).regex(LANG_RE, langMessage).optional(),
  title: text({ max: 200, required: true }),
  summary: text({ max: 800 }),
  notes: list(text({ max: 400, required: true }), { max: 6 }),
  asOf,
  kpis: list(kpi, { max: 8 }),
  blocks: list(block, { max: 20 }),
  method: optional(
    object(
      {
        title: text({ max: 120 }),
        paragraphs: list(text({ max: 1200, required: true }), { max: 10 })
      },
      '{title, paragraphs}'
    )
  ),
  // At least one: a figure nobody can trace is what the sources are there to prevent.
  sources: list(source, { min: 1, max: 20 }),
  labels: optional(
    z.preprocess(
      value =>
        isObject(value)
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key, text]) => LABEL_KEY_RE.test(key) && typeof text === 'string')
                .map(([key, text]) => [key, text.slice(0, 120)])
            )
          : value,
      z.record(z.string(), z.string(), { error: 'must be an object of interface texts.' })
    )
  )
};

/** Rules that look across the whole spec. Paths are absolute. */
function specRules(spec, ctx) {
  const problem = (path, message) => ctx.addIssue({ code: 'custom', path, message });
  const ids = new Set(spec.sources.map(entry => entry.id));
  if (ids.size !== spec.sources.length) problem(['sources'], 'has an id twice.');
  (spec.blocks ?? []).forEach((entry, i) => {
    if (entry.source && !ids.has(entry.source)) {
      problem(['blocks', i, 'source'], `"${entry.source}" is not the id of an entry in "sources".`);
    }
  });
  if (!spec.blocks?.length && !spec.kpis?.length) {
    problem([], 'needs at least one entry in "kpis" or "blocks".');
  }
}

/** A copy without the keys whose value is `undefined`, all the way down. */
function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefined(entry)])
  );
}

/** The spec without what is empty or undefined, in the order of the schema. */
function tidy(spec) {
  const out = withoutUndefined(spec);
  for (const key of ['notes', 'kpis', 'blocks']) if (!out[key]?.length) delete out[key];
  if (!out.method?.paragraphs?.length) delete out.method;
  if (out.labels && !Object.keys(out.labels).length) delete out.labels;
  return out;
}

export const dashboardSpecSchema = z
  .object(pageShape, { error: 'must be a JSON object.' })
  .superRefine(specRules)
  .transform(tidy);

/** The field names of each part of a spec, for the test that the reference documents them all. */
export const SPEC_FIELDS = Object.freeze({
  page: Object.keys(pageShape),
  bars: Object.keys(barsShape),
  line: Object.keys(lineShape),
  table: Object.keys(tableShape),
  text: Object.keys(textShape)
});

// ── what the model reads ────────────────────────────────────────────────────

/** `blocks[0].items[1].value` for the path `['blocks', 0, 'items', 1, 'value']`. */
function pathText(path) {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${part}` : String(part);
  }
  return out;
}

/** One fault as a sentence that names the field. */
function describeIssue(issue) {
  const message = issue.message.replaceAll('{block}', pathText(issue.path.slice(0, 2)));
  const where = pathText(issue.path);
  return where ? `${where} ${message}` : `it ${message}`;
}

/** All faults, each once, the first {@link MAX_PROBLEMS} of them. */
function problemsOf(issues) {
  const all = [...new Set(issues.map(describeIssue))];
  const shown = all.slice(0, MAX_PROBLEMS);
  if (shown.length === 1) return shown[0];
  const more = all.length > shown.length ? ` (${all.length - shown.length} more after these)` : '';
  const numbered = shown.map((problem, i) => `(${i + 1}) ${problem}`).join(' ');
  return `${all.length} problems${more}. ${numbered} Fix all of them in the next call.`;
}

/**
 * Check a dashboard spec and return the part of it the page reads.
 *
 * @param {unknown} spec - Parsed JSON
 * @returns {Object} The checked spec, with unknown fields dropped
 * @throws {DocumentGenerationError} With a message that names every field at fault
 */
export function checkDashboardSpec(spec) {
  const parsed = dashboardSpecSchema.safeParse(spec);
  if (parsed.success) return parsed.data;
  throw new DocumentGenerationError(
    `Invalid dashboard "data": ${problemsOf(parsed.error.issues)}`,
    'invalid'
  );
}
