// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildXlsx } from './buildXlsx.js';
import { mergeIntoWorkbook } from './mergeWorkbook.js';

/**
 * Render an Excel workbook spec in the current thread (called by the render
 * worker; see `../renderService.js`).
 *
 * @param {Object} spec - See `buildXlsx.js`.
 * @param {Object} [assets]
 * @param {Uint8Array} [assets.sourceWorkbook] - Uploaded workbook to add the sheets to.
 * @returns {Promise<{ buffer: Buffer, meta: { sheets: number }, warnings: string[] }>}
 */
export async function renderXlsx(spec, assets = {}) {
  // With an uploaded workbook (`assets.sourceWorkbook`) the spec's sheets are
  // merged into it instead of making a new file.
  const { buffer, sheets, warnings, added, replaced } = assets?.sourceWorkbook
    ? await mergeIntoWorkbook(Buffer.from(assets.sourceWorkbook), spec)
    : await buildXlsx(spec);
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { sheets, added, replaced }, warnings };
}
