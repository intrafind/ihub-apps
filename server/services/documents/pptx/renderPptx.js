// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildBaseTemplate } from './baseTemplate.js';
import { buildPptx } from './buildPptx.js';
import { restylePptx } from './restylePptx.js';

/**
 * Render a presentation spec, in the current thread (the render worker calls
 * this; see `../renderService.js`).
 *
 * The slides go into the admin's PowerPoint template when the document
 * template has one (`assets.powerpointTemplate`), otherwise into iHub's
 * built-in template made from the brand (`baseTemplate.js`).
 *
 * @param {Object} spec - See `buildPptx.js` (`templateMode: 'append'` keeps the
 *   slides of an uploaded deck); `brand` describes the built-in template.
 * @param {Object} [assets]
 * @param {Uint8Array} [assets.powerpointTemplate]
 * @returns {Promise<{ buffer: Buffer, meta: { slides: number }, warnings: string[] }>}
 */
export async function renderPptx(spec, assets = {}) {
  const template = assets?.powerpointTemplate
    ? Buffer.from(assets.powerpointTemplate)
    : await buildBaseTemplate(spec.brand);
  const { buffer, slides, warnings } = await buildPptx(spec, {
    template,
    keepTemplateSlides: spec.templateMode === 'append'
  });
  // Read the result back: a package whose parts do not parse is an error,
  // not a download.
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { slides }, warnings };
}

/**
 * Move an existing presentation onto the document template's PowerPoint
 * template (or iHub's built-in one made from the brand), in the current thread
 * (the render worker calls this).
 *
 * @param {Object} spec - `brand` (the built-in template), `footer`, `slideNumbers`,
 *   `title`, `author`, `language`.
 * @param {Object} assets
 * @param {Uint8Array} assets.deck - The presentation to restyle.
 * @param {Uint8Array} [assets.powerpointTemplate]
 * @returns {Promise<{ buffer: Buffer, meta: { slides: number }, warnings: string[] }>}
 */
export async function renderPptxRestyle(spec, assets = {}) {
  if (!assets.deck) throw new Error('A presentation is required.');
  const template = assets.powerpointTemplate
    ? Buffer.from(assets.powerpointTemplate)
    : await buildBaseTemplate(spec.brand);
  const { buffer, slides, warnings } = await restylePptx(Buffer.from(assets.deck), template, {
    footer: spec.footer,
    slideNumbers: spec.slideNumbers,
    title: spec.title,
    author: spec.author,
    language: spec.language
  });
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { slides }, warnings };
}
