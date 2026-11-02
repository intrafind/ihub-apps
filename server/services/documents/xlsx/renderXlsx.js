// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { assertWellFormed, openPackage } from '../ooxml/opcPackage.js';
import { buildXlsx } from './buildXlsx.js';

/**
 * Render an Excel workbook spec in the current thread (called by the render
 * worker; see `../renderService.js`).
 *
 * @param {Object} spec - See `buildXlsx.js`.
 * @returns {Promise<{ buffer: Buffer, meta: { sheets: number }, warnings: string[] }>}
 */
export async function renderXlsx(spec) {
  const { buffer, sheets, warnings } = await buildXlsx(spec);
  await assertWellFormed(await openPackage(buffer));
  return { buffer, meta: { sheets }, warnings };
}
