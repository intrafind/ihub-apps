// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildBaseTemplate } from './baseTemplate.js';
import { buildPptx } from './buildPptx.js';

/**
 * Render a presentation spec, in the current thread (the render worker calls
 * this; see `../renderService.js`).
 *
 * The slides go into the admin's PowerPoint template when the document
 * template has one (`assets.powerpointTemplate`), otherwise into iHub's
 * built-in template made from the brand (`baseTemplate.js`).
 *
 * @param {Object} spec - See `buildPptx.js`; `brand` describes the built-in
 *   template, `layouts` names the template's layouts by kind.
 * @param {Object} [assets]
 * @param {Uint8Array} [assets.powerpointTemplate]
 * @param {{ data: Uint8Array, extension: string, width: number, height: number }} [assets.logo]
 * @returns {Promise<{ buffer: Buffer, meta: { slides: number }, warnings: string[] }>}
 */
export async function renderPptx(spec, assets = {}) {
  const template = assets?.powerpointTemplate
    ? Buffer.from(assets.powerpointTemplate)
    : await buildBaseTemplate({ ...spec.brand, logo: assets?.logo });
  const { buffer, slides, warnings } = await buildPptx(spec, {
    template,
    layouts: spec.layouts
  });
  // Read the result back: a package whose parts do not parse is an error,
  // not a download.
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { slides }, warnings };
}
