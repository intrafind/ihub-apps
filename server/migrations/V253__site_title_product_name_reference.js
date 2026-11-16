// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// server/migrations/V253__site_title_product_name_reference.js
export const version = '253';
export const description = 'site_title_product_name_reference';

/**
 * The site title (browser tab, exports, sign-in screen) and the PWA app name of a
 * fresh install ("iHub Apps") are no longer fixed text in `ui.json`. They refer to
 * the translation key `product.name`, so an admin renames the product once under
 * Admin → Localization and every surface follows.
 *
 * Only the untouched shipped values are replaced. A title or PWA name an admin
 * wrote, and an install that has none, stay as they are.
 */

const UI_FILE = 'config/ui.json';
const REFERENCE = '$t(product.name)';
const SHIPPED = 'iHub Apps';

export async function precondition(ctx) {
  return await ctx.fileExists(UI_FILE);
}

/** True when `title` is a language map whose every text is the shipped name. */
function isShippedTitle(title) {
  if (!title || typeof title !== 'object' || Array.isArray(title)) return false;
  const languages = Object.keys(title);
  return languages.length > 0 && languages.every(language => title[language] === SHIPPED);
}

export async function up(ctx) {
  const ui = await ctx.readJson(UI_FILE);
  let changed = false;

  if (isShippedTitle(ui?.title)) {
    ui.title = Object.fromEntries(Object.keys(ui.title).map(language => [language, REFERENCE]));
    changed = true;
  } else {
    ctx.log('Site title was changed or removed — skipping');
  }

  if (ui?.pwa?.name === SHIPPED) {
    ui.pwa.name = REFERENCE;
    changed = true;
  } else {
    ctx.log('PWA name was changed or removed — skipping');
  }

  if (!changed) return;
  await ctx.writeJson(UI_FILE, ui);
  ctx.log('Site title and PWA name now refer to the translation key product.name');
}
