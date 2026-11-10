// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// server/migrations/V240__footer_text_translation_reference.js
export const version = '240';
export const description = 'footer_text_translation_reference';

/**
 * The footer text of a fresh install ("© 2025 IntraFind Software AG. All rights reserved.")
 * is no longer fixed text in `ui.json`. It refers to the translation key `footer.legal`, so
 * an admin changes it for every language under Admin → Translations like any other text, and
 * the year is the current one instead of 2025.
 *
 * Only the untouched shipped value is replaced. A footer text an admin wrote, an empty one and
 * an install that has none (the footer then shows `footer.copyright`) stay as they are.
 */

const UI_FILE = 'config/ui.json';
const REFERENCE = '$t(footer.legal)';
const SHIPPED = Object.freeze({
  en: '© 2025 IntraFind Software AG. All rights reserved.',
  de: '© 2025 IntraFind Software AG. Alle Rechte vorbehalten.'
});

export async function precondition(ctx) {
  return await ctx.fileExists(UI_FILE);
}

/** True when `text` is exactly what the installer wrote. */
function isShippedFooterText(text) {
  if (!text || typeof text !== 'object' || Array.isArray(text)) return false;
  const languages = Object.keys(text);
  return (
    languages.length === Object.keys(SHIPPED).length &&
    languages.every(language => text[language] === SHIPPED[language])
  );
}

export async function up(ctx) {
  const ui = await ctx.readJson(UI_FILE);
  if (!isShippedFooterText(ui?.footer?.text)) {
    ctx.log('Footer text was changed or removed — skipping');
    return;
  }
  ui.footer.text = Object.fromEntries(Object.keys(SHIPPED).map(l => [l, REFERENCE]));
  await ctx.writeJson(UI_FILE, ui);
  ctx.log('Footer text now refers to the translation key footer.legal');
}
