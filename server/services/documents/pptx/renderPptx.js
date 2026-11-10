// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildBaseTemplate } from './baseTemplate.js';
import { buildPptx, sanitizeSlides } from './buildPptx.js';
import { applySlideFrame, frameHasContent } from './slideFrame.js';

/**
 * Render a presentation spec, in the current thread (the render worker calls
 * this; see `../renderService.js`).
 *
 * The slides go into the admin's PowerPoint template when the document
 * template has one (`assets.powerpointTemplate`), otherwise into iHub's
 * built-in template made from the brand (`baseTemplate.js`).
 *
 * @param {Object} spec - See `buildPptx.js` (`templateMode: 'append'` keeps the
 *   slides of an uploaded deck); `brand` describes the built-in
 *   template, `layouts` names the template's layouts by kind.
 * @param {Object} [assets]
 * @param {Uint8Array} [assets.powerpointTemplate]
 * @param {{ data: Uint8Array, extension: string, width: number, height: number }} [assets.logo]
 * @returns {Promise<{ buffer: Buffer, meta: { slides: number }, warnings: string[] }>}
 */
export async function renderPptx(spec, assets = {}) {
  const framed = Boolean(spec.frame?.enabled) && frameHasContent(assets?.frame);
  const template = assets?.powerpointTemplate
    ? Buffer.from(assets.powerpointTemplate)
    : // With a frame the logo is the frame's; the built-in master keeps clear of it.
      await buildBaseTemplate({
        ...spec.brand,
        logo: framed ? undefined : assets?.logo,
        framed
      });
  let { buffer, slides, warnings } = await buildPptx(spec, {
    template,
    layouts: spec.layouts,
    keepTemplateSlides: spec.templateMode === 'append'
  });
  if (framed) {
    // The first slide becomes the cover when it is a title slide of the new deck.
    const first = sanitizeSlides(spec.slides, { warnings: [], imageBytes: 0 })[0];
    buffer = (
      await applySlideFrame(
        buffer,
        {
          ...assets.frame,
          logo: assets.logo,
          textColor: spec.brand?.textColor,
          font: spec.brand?.headingFont
        },
        {
          cover: first?.kind === 'title' && spec.templateMode !== 'append',
          footer: spec.frame.coverFooter,
          lang: spec.language
        }
      )
    ).buffer;
  }
  // Read the result back: a package whose parts do not parse is an error,
  // not a download.
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { slides }, warnings };
}

/**
 * Put a document template's slide frame on an existing presentation, in the
 * current thread (the render worker calls this).
 *
 * @param {Object} spec
 * @param {Object} [spec.options] - `cover`, `title`, `date`, `footer`, `lang`
 *   (see `slideFrame.js`).
 * @param {Object} [spec.brand] - `textColor`, `headingFont` for the cover texts.
 * @param {Object} assets
 * @param {Uint8Array} assets.deck - The .pptx.
 * @param {Object} assets.frame - The frame's pictures.
 * @param {Object} [assets.logo]
 * @returns {Promise<{ buffer: Buffer, meta: { slides: number, cover: boolean }, warnings: string[] }>}
 */
export async function renderPptxFrame(spec, assets) {
  if (!assets?.deck) throw new Error('A presentation is required.');
  const { buffer, slides, cover } = await applySlideFrame(
    Buffer.from(assets.deck),
    {
      ...assets.frame,
      logo: assets.logo,
      textColor: spec.brand?.textColor,
      font: spec.brand?.headingFont
    },
    spec.options
  );
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { slides, cover }, warnings: [] };
}
