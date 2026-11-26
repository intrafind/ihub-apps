// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs/promises';
import { join } from 'node:path';
import zlib from 'node:zlib';

/**
 * Migration V265 — document templates take their design from their Office files
 *
 * A document template keeps a Word template, a PowerPoint template, the company
 * name, the brand colours (read from the files when not set), the margins of
 * PDFs and the fields of its Word template. Everything else goes: the design
 * lives in the Office files.
 *
 * What this migration changes, for every `document-templates/<id>/template.json`:
 *
 * - **PDF margins stay.** `document.margins` moves to `pdf.margins` (unless
 *   `pdf.margins` is set).
 * - **Settings that go** are removed: `brand.logo`, `brand.headingFont`,
 *   `brand.bodyFont`, `brand.fontSize`, `fonts`, `document` (the rest of it),
 *   `pdf.theme`, `pdf.letterhead`, `pdf.letterheadFollowing`, `pptx.layouts`,
 *   `pptx.slots`, `pptx.footer`, `pptx.slideNumbers` and `pptx.aspectRatio`.
 * - **Files that go** are deleted: the logo, the font files and the letterhead
 *   PDFs the template named.
 * - **Fields are declared.** Every `{{name}}` in the Word template that is not a
 *   built-in placeholder becomes an optional field (at most 50; the names that
 *   do not fit are logged), so that no placeholder prints with its braces.
 *
 * Idempotent: a template that already has the new shape is not written. Missing
 * files are skipped. Self-contained: no application module is imported (see
 * `server/migrations/README.md`); the Word template is read with a small ZIP
 * reader of this file.
 */

export const version = '265';
export const description = 'document_templates_rework';

const DIRECTORY = 'document-templates';
const CONFIG_FILE = 'template.json';
const FONT_FACES = ['normal', 'bold', 'italics', 'bolditalics'];

// Snapshot of the built-in placeholders and the field rules of
// documentTemplateSchema.js as of V265. Do NOT replace with an import.
const BUILT_IN_PLACEHOLDERS = new Set([
  'content',
  'toc',
  'title',
  'subtitle',
  'author',
  'date',
  'year',
  'company',
  'page',
  'pages'
]);
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_FIELDS = 50;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/gi;

/** The most a part of a Word template may unpack to, in bytes. */
const MAX_PART_BYTES = 20 * 1024 * 1024;

export async function precondition(ctx) {
  return (await ctx.listFiles(DIRECTORY)).length > 0;
}

function isMargins(value) {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(number => Number.isFinite(number) && number >= 18 && number <= 200)
  );
}

/**
 * A template in the new shape, and the files it no longer needs.
 *
 * @param {object} template - The stored `template.json`.
 * @returns {{ template: object, files: string[], changed: boolean }}
 */
export function migrateTemplate(template) {
  const next = structuredClone(template);
  const files = new Set();
  const take = name => {
    if (typeof name === 'string' && name) files.add(name);
  };

  take(next.brand?.logo);
  take(next.pdf?.letterhead);
  take(next.pdf?.letterheadFollowing);
  for (const font of Array.isArray(next.fonts) ? next.fonts : []) {
    for (const face of FONT_FACES) take(font?.[face]);
  }

  if (isMargins(next.document?.margins) && !next.pdf?.margins) {
    next.pdf = { ...next.pdf, margins: next.document.margins };
  }

  for (const key of ['logo', 'headingFont', 'bodyFont', 'fontSize']) delete next.brand?.[key];
  for (const key of ['theme', 'letterhead', 'letterheadFollowing']) delete next.pdf?.[key];
  for (const key of ['layouts', 'slots', 'footer', 'slideNumbers', 'aspectRatio']) {
    delete next.pptx?.[key];
  }
  delete next.fonts;
  delete next.document;

  return {
    template: next,
    files: [...files],
    changed: JSON.stringify(next) !== JSON.stringify(template)
  };
}

/**
 * The entries of a ZIP archive that are asked for, unpacked. Only stored and
 * deflated entries; an entry larger than `MAX_PART_BYTES` unpacked is skipped.
 *
 * @param {Buffer} buffer
 * @param {(name: string) => boolean} wanted
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function readZipEntries(buffer, wanted) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return [];
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count && at + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name) || localOffset + 30 > buffer.length) continue;
    const start =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    try {
      if (method === 0) entries.push({ name, data: raw });
      else if (method === 8) {
        entries.push({ name, data: zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES }) });
      }
    } catch {
      // A part that does not unpack is skipped: the placeholders in the others still count.
    }
  }
  return entries;
}

const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['amp', '&']
]);

/** Decodes the named and numeric (`&#123;`, `&#x7B;`) character references of XML text in one pass. */
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|lt|gt|quot|apos|amp);/gi, (match, ref) => {
    const named = NAMED_ENTITIES.get(ref.toLowerCase());
    if (named) return named;
    const code =
      ref[1].toLowerCase() === 'x'
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

/**
 * The names of the template's own fields in a Word template: every `{{name}}`
 * in its body, headers and footers that is not a built-in placeholder, also
 * when Word split the placeholder into several runs.
 *
 * @param {Buffer} buffer - A `.docx` or `.dotx`.
 * @returns {string[]} Lower case names, in the order they first appear.
 */
export function fieldNamesOfWordTemplate(buffer) {
  const parts = readZipEntries(buffer, name =>
    /^word\/(document|header\d*|footer\d*)\.xml$/.test(name)
  );
  const names = [];
  for (const { data } of parts) {
    const xml = data.toString('utf8');
    for (const paragraph of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
      const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
        .map(match => decodeXml(match[1]))
        .join('');
      for (const match of text.matchAll(PLACEHOLDER)) {
        const name = match[1].toLowerCase();
        if (
          FIELD_NAME_PATTERN.test(name) &&
          !BUILT_IN_PLACEHOLDERS.has(name) &&
          !names.includes(name)
        ) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

/**
 * Declares the placeholders of the template's Word file as fields, up to the
 * limit; the rest are logged. Returns whether a field was added.
 */
async function declareWordFields(ctx, id, template) {
  const word = template.docx?.template;
  if (typeof word !== 'string' || !word) return false;
  let buffer;
  try {
    buffer = await fs.readFile(join(ctx.contentsDir, DIRECTORY, id, word));
  } catch {
    ctx.warn(`${id}: the Word template ${word} could not be read; no fields were declared`);
    return false;
  }
  const fields = { ...template.fields };
  const skipped = [];
  let added = false;
  for (const name of fieldNamesOfWordTemplate(buffer)) {
    if (Object.hasOwn(fields, name)) continue;
    if (Object.keys(fields).length >= MAX_FIELDS) {
      skipped.push(name);
    } else {
      fields[name] = {};
      added = true;
    }
  }
  if (added) template.fields = fields;
  if (skipped.length) {
    ctx.warn(
      `${id}: ${MAX_FIELDS} fields are declared; these placeholders stay plain text: ${skipped.join(', ')}`
    );
  }
  return added;
}

/** Migrates one template; returns 1 when its `template.json` was written. */
async function migrateOne(ctx, id) {
  const file = `${DIRECTORY}/${id}/${CONFIG_FILE}`;
  if (!(await ctx.fileExists(file))) return 0;
  const { template, files, changed } = migrateTemplate(await ctx.readJson(file));
  const fieldsChanged = await declareWordFields(ctx, id, template);
  // The files go first: if one cannot be deleted, `template.json` still names it and
  // a later run tries again. A file that is already gone is fine.
  await Promise.all(
    files.map(name =>
      ctx.deleteFile(`${DIRECTORY}/${id}/${name}`).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      })
    )
  );
  if (changed || fieldsChanged) await ctx.writeJson(file, template);
  return changed || fieldsChanged ? 1 : 0;
}

export async function up(ctx) {
  const ids = await ctx.listFiles(DIRECTORY);
  const migrated = (await Promise.all(ids.map(id => migrateOne(ctx, id)))).reduce(
    (sum, count) => sum + count,
    0
  );
  ctx.log(
    migrated
      ? `Moved ${migrated} document template(s) to the Office-file model`
      : 'No document template needed changes'
  );
}
