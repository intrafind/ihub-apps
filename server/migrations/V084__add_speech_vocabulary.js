export const version = '084';
export const description = 'add_speech_vocabulary';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Organization-wide custom vocabulary / context biasing for speech-to-text.
  // Seeded EMPTY on purpose: `context_biasing` is only sent upstream once terms
  // exist, so an untouched install keeps sending the exact session.update frame
  // it sent before — an endpoint build without biasing support cannot break.
  // Admins fill the list under Admin → Voice Input; per-model and per-app
  // vocabularies are merged on top of it.
  ctx.setDefault(platform, 'speech.realtime.vocabulary.enabled', true);
  ctx.setDefault(platform, 'speech.realtime.vocabulary.terms', []);
  ctx.setDefault(platform, 'speech.realtime.vocabulary.biasScore', 3);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.realtime.vocabulary defaults to platform.json');
}
