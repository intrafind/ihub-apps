export const version = '070';
export const description = 'add_speech_realtime';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Realtime speech-to-text via an iHub-proxied vLLM realtime endpoint (Voxtral).
  // Disabled by default; admins point `url`/`model` at their vLLM instance and
  // flip `enabled` to true. Apps opt in via settings.speechRecognition.service.
  ctx.setDefault(platform, 'speech.realtime.enabled', false);
  ctx.setDefault(platform, 'speech.realtime.url', 'ws://localhost:8080/v1/realtime');
  ctx.setDefault(platform, 'speech.realtime.model', 'mistralai/Voxtral-Mini-4B-Realtime-2602');
  ctx.setDefault(platform, 'speech.realtime.apiKey', '');

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added speech.realtime defaults to platform.json');
}
