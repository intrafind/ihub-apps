// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// server/migrations/V239__header_tagline_translation_reference.js
export const version = '239';
export const description = 'header_tagline_translation_reference';

/**
 * The header tagline of a fresh install ("by IntraFind" / "von IntraFind") is no
 * longer fixed text in `ui.json`. It refers to the translation key
 * `product.tagline`, so an admin changes it for every language under Admin →
 * Translations like any other text.
 *
 * Only the untouched shipped value is replaced. A tagline an admin wrote, an
 * empty one (no tagline) and an install that has none stay as they are.
 */

const UI_FILE = 'config/ui.json';
const REFERENCE = '$t(product.tagline)';
const SHIPPED = Object.freeze({ en: 'by IntraFind', de: 'von IntraFind' });

export async function precondition(ctx) {
  return await ctx.fileExists(UI_FILE);
}

/** True when `tagline` is exactly the text the installer wrote. */
function isShippedTagline(tagline) {
  if (!tagline || typeof tagline !== 'object' || Array.isArray(tagline)) return false;
  const languages = Object.keys(tagline);
  return (
    languages.length === Object.keys(SHIPPED).length &&
    languages.every(language => tagline[language] === SHIPPED[language])
  );
}

export async function up(ctx) {
  const ui = await ctx.readJson(UI_FILE);
  if (!isShippedTagline(ui?.header?.tagline)) {
    ctx.log('Header tagline was changed or removed — skipping');
    return;
  }
  ui.header.tagline = Object.fromEntries(Object.keys(SHIPPED).map(l => [l, REFERENCE]));
  await ctx.writeJson(UI_FILE, ui);
  ctx.log('Header tagline now refers to the translation key product.tagline');
}
