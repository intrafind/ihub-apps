// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildDocx, labelsFor } from './buildDocx.js';
import {
  inspectWordTemplate,
  mergeIntoWordTemplate,
  readWordTemplateLayout
} from './wordTemplate.js';

/** The year in a date such as `2026-11-26` or `26 November 2026`; this year when there is none. */
function yearOf(date) {
  return /\b(?:19|20)\d{2}\b/.exec(String(date))?.[0] || String(new Date().getFullYear());
}

/**
 * The placeholders of an uploaded Word file that are not built in and are
 * still in the finished document: they had no value, so they print as written.
 * (A placeholder in a body that was cleared is gone, and is not reported.)
 *
 * @param {Buffer} template - The uploaded file.
 * @param {Buffer} result - The finished document.
 * @returns {Promise<string[]>} Names, in the order they appear in the file.
 */
async function unfilledFields(template, result) {
  const [wanted, left] = await Promise.all([
    inspectWordTemplate(template),
    inspectWordTemplate(result)
  ]);
  const remaining = new Set(left.customFields);
  return wanted.customFields.filter(name => remaining.has(name));
}

/** What the model is told about placeholders of an uploaded file that had no value. */
function unfilledWarning(names) {
  const list = names.map(name => `{{${name}}}`).join(', ');
  return `The uploaded file has placeholders that are not built in and had no value, so they stay as written: ${list}. Ask the user for their values if you do not know them, then create the document again with "fields" set, for example {"${names[0]}": "…"}.`;
}

/**
 * Render a Word document spec, in the current thread (the render worker
 * calls this; see `../renderService.js`).
 *
 * With a Word template in `assets.wordTemplate` the content is built for the
 * template's page and merged into it (`wordTemplate.js`); otherwise the
 * document carries its own styles, header and footer (`buildDocx.js`).
 *
 * @param {import('./buildDocx.js').DocxSpec} spec
 * @param {Object} [assets]
 * @param {Uint8Array} [assets.wordTemplate]
 * @param {string} [spec.templateMode] - `auto`, `styles_only`, `fill_placeholders`
 *   or `append` for a template that is an uploaded document.
 * @param {Object<string, string>} [spec.fields] - Values of the template's own
 *   fields (`{{department}}` …), by name.
 * @param {boolean} [spec.toc] - A table of contents. A template with `{{toc}}`
 *   shows one there unless this is `false`.
 * @returns {Promise<{ buffer: Buffer, meta: Object, warnings: string[] }>}
 */
export async function renderDocx(spec, assets = {}) {
  let buffer;
  let warnings;
  if (assets?.wordTemplate) {
    const template = Buffer.from(assets.wordTemplate);
    const layout = await readWordTemplateLayout(template);
    // Without a brand colour, table headers and bullets take the template's
    // accent colour.
    const colors = {
      ...spec.colors,
      primary: spec.colors?.primary || (layout.accent ? `#${layout.accent}` : undefined)
    };
    // A template with `{{toc}}` decides where the table of contents goes: the
    // content then has none of its own.
    const tocInTemplate = layout.tocMarker;
    const tocWanted = tocInTemplate ? spec.toc !== false : Boolean(spec.toc);
    const built = await buildDocx(
      {
        ...spec,
        colors,
        toc: tocWanted && !tocInTemplate,
        titleInTemplate: layout.placeholders.has('title')
      },
      { forTemplate: true, setupOverride: layout.setup }
    );
    warnings = built.warnings;
    // An uploaded document (`spec.templateMode` is set by `templateFileId`)
    // that has no `{{content}}` marker is used for its look only: its old body
    // is cleared instead of having the new content appended to it.
    const mode =
      spec.templateMode === 'auto'
        ? layout.placeholders.has('content')
          ? 'fill_placeholders'
          : 'styles_only'
        : spec.templateMode;
    const date = spec.date || new Date().toISOString().slice(0, 10);
    buffer = await mergeIntoWordTemplate(built.buffer, template, {
      mode,
      values: {
        // The template's own fields first: a built-in placeholder wins.
        ...spec.fields,
        title: spec.title || '',
        subtitle: spec.subtitle || '',
        author: spec.author || '',
        date,
        year: yearOf(date),
        company: spec.company || ''
      },
      toc: tocWanted,
      tocTitle: labelsFor(spec.language).contents,
      updateFields: tocWanted,
      accent: layout.accent,
      properties: {
        title: spec.title,
        author: spec.author,
        subject: spec.subtitle,
        language: spec.language
      }
    });
    // An uploaded file's own placeholders get their values from `fields`; report what is left.
    if (spec.templateMode) {
      const unfilled = await unfilledFields(template, buffer);
      if (unfilled.length) warnings = [...warnings, unfilledWarning(unfilled)];
    }
  } else {
    ({ buffer, warnings } = await buildDocx(spec));
  }
  // Read the result back: a package that does not open is an error, not a
  // download.
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: {}, warnings };
}
