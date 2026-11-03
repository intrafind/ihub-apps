// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildDocx } from './buildDocx.js';
import { mergeIntoWordTemplate, readWordTemplateLayout } from './wordTemplate.js';

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
    const built = await buildDocx(
      { ...spec, colors, titleInTemplate: layout.placeholders.has('title') },
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
    buffer = await mergeIntoWordTemplate(built.buffer, template, {
      mode,
      values: {
        title: spec.title || '',
        subtitle: spec.subtitle || '',
        author: spec.author || '',
        date: spec.date || new Date().toISOString().slice(0, 10),
        company: spec.company || ''
      },
      updateFields: Boolean(spec.toc),
      accent: layout.accent,
      properties: {
        title: spec.title,
        author: spec.author,
        subject: spec.subtitle,
        language: spec.language
      }
    });
  } else {
    ({ buffer, warnings } = await buildDocx(spec));
  }
  // Read the result back: a package that does not open is an error, not a
  // download.
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: {}, warnings };
}
