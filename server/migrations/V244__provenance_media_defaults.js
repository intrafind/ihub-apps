// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V244 — provider marks on generated images and audio (#3328,
 * EU AI Act Art. 50(2))
 *
 * `config/platform.json`: `provenance.media` — uploads to the verify endpoint up
 * to 50 MiB, C2PA manifests read.
 * Values the admin already set are kept.
 *
 * Models are not touched on purpose: `contentMarking.image` stays absent
 * (= "none") until an operator declares what the provider embeds in a written
 * statement. A Google image model is never preset as SynthID-marked from its
 * provider name.
 */

export const version = '244';
export const description = 'provenance_media_defaults';

export async function precondition(ctx) {
  return ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'provenance.media.maxVerifyBytes', 52428800);
  ctx.setDefault(platform, 'provenance.media.readC2pa', true);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Provenance media defaults written (50 MiB uploads, C2PA read on)');
}
