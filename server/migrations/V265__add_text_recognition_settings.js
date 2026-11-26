// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Text recognition at upload (#3986): `platform.ocr` (the model that reads
 * images and scanned PDF pages, and the most pages per document) and the chat
 * opt-in `platform.uploads.recognizeText`. No model is set, so nothing changes
 * until an administrator picks one.
 */
export const version = '265';
export const description = 'add_text_recognition_settings';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const config = await ctx.readJson('config/platform.json');
  ctx.setDefault(config, 'ocr.modelId', null);
  ctx.setDefault(config, 'ocr.maxPages', 50);
  ctx.setDefault(config, 'uploads.recognizeText', false);
  await ctx.writeJson('config/platform.json', config);
  ctx.log('Added platform.ocr (no model) and uploads.recognizeText (off)');
}
