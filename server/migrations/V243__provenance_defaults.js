// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V243 — provenance defaults (#3327, EU AI Act Art. 50(2))
 *
 * 1. `config/platform.json`: the `provenance` block (records kept 365 days,
 *    store on, lookup for authenticated callers only). Values the admin already
 *    set are kept.
 * 2. Every chat model (`modelType` absent or `chat`): `contentMarking.text.by`
 *    "none". The marking is never inferred from the provider's name: claiming a
 *    provider marks its output needs the operator's written statement.
 *    Transcription and TTS models are skipped; unreadable files are skipped.
 */

export const version = '243';
export const description = 'provenance_defaults';

export async function precondition(ctx) {
  return (await ctx.fileExists('config/platform.json')) || (await hasModels(ctx));
}

async function hasModels(ctx) {
  return (await ctx.listFiles('models', '*.json')).length > 0;
}

export async function up(ctx) {
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    ctx.setDefault(platform, 'provenance.retentionDays', 365);
    ctx.setDefault(platform, 'provenance.storeRecords', true);
    ctx.setDefault(platform, 'provenance.verify.access', 'authenticated');
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Provenance defaults written (365 days, records on, lookup for signed-in callers)');
  }

  let updated = 0;
  let skipped = 0;
  for (const file of await ctx.listFiles('models', '*.json')) {
    const rel = `models/${file}`;
    let model;
    try {
      model = await ctx.readJson(rel);
    } catch {
      skipped += 1;
      continue;
    }
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      skipped += 1;
      continue;
    }
    if (model.modelType && model.modelType !== 'chat') continue;
    const before = JSON.stringify(model.contentMarking ?? null);
    ctx.setDefault(model, 'contentMarking.text.by', 'none');
    if (JSON.stringify(model.contentMarking) === before) continue;
    await ctx.writeJson(rel, model);
    updated += 1;
  }
  ctx.log(
    `contentMarking.text.by "none" set on ${updated} model(s), ${skipped} unreadable skipped`
  );
}
