export const version = '085';
export const description = 'add_speech_vocabulary';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Organization-wide custom vocabulary ("hotwords") for speech-to-text.
  // Seeded EMPTY on purpose: `hotwords` is only sent upstream once terms exist,
  // so an untouched install keeps sending the exact session.update frame it sent
  // before. Admins fill the list under Admin → Voice Input; per-model and
  // per-app vocabularies are merged on top of it.
  ctx.setDefault(platform, 'speech.realtime.vocabulary.enabled', true);
  ctx.setDefault(platform, 'speech.realtime.vocabulary.terms', []);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.realtime.vocabulary defaults to platform.json');
}
