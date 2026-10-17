/**
 * Migration V168 — Voice mode platform defaults (issue #2868)
 *
 * Voice mode is a spoken conversation with an app: the user talks, the app
 * answers aloud, and the user can interrupt. It is configured in
 * `platform.json` under `speech.voiceMode` (Admin → Voice Input) and per app in
 * `inputMode.voiceMode`. This adds the platform side.
 *
 * Added, each only where the key is missing:
 *   - speech.voiceMode.enabled            false: off until an admin switches it on
 *   - speech.voiceMode.appDefault         false: apps opt in one by one
 *   - speech.voiceMode.ttsModelId         "": follows speech.tts.defaultModelId
 *   - speech.voiceMode.listeningStyle     "hands-free" ("push-to-talk" is the alternative)
 *   - speech.voiceMode.bargeIn            true: speaking over the app stops it
 *   - speech.voiceMode.endOfTurnSilenceMs 800 (300–3000): the pause that ends a turn
 *   - speech.voiceMode.thinkingLevel      "low": voice turns do not wait on long reasoning
 *   - speech.voiceMode.maxSessionMinutes  30 (1–240)
 *   - speech.voiceMode.systemPrompt       {}: the built-in voice style instruction applies
 *
 * Nothing changes until an admin enables it: the feature also needs the
 * `voiceMode` feature flag, which the registry defaults to off and so needs no
 * migration. A value an admin set is never touched, so running this again
 * changes nothing. An app needs no migration either: an app without
 * `inputMode.voiceMode` follows the platform.
 */

export const version = '168';
export const description = 'add_voice_mode_defaults';

const PLATFORM_PATH = 'config/platform.json';

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function precondition(ctx) {
  return await ctx.fileExists(PLATFORM_PATH);
}

export async function up(ctx) {
  const platform = await ctx.readJson(PLATFORM_PATH);

  // A hand-edited file may hold something else under these keys. Writing the
  // defaults through it would replace what is there, so leave it for the admin.
  if (platform.speech !== undefined && !isPlainObject(platform.speech)) {
    ctx.warn('speech is not an object; voice mode defaults not added');
    return;
  }
  if (platform.speech?.voiceMode !== undefined && !isPlainObject(platform.speech.voiceMode)) {
    ctx.warn('speech.voiceMode is not an object; voice mode defaults not added');
    return;
  }

  const defaults = {
    enabled: false,
    appDefault: false,
    ttsModelId: '',
    listeningStyle: 'hands-free',
    bargeIn: true,
    endOfTurnSilenceMs: 800,
    thinkingLevel: 'low',
    maxSessionMinutes: 30,
    systemPrompt: {}
  };
  const added = Object.entries(defaults).filter(([key, value]) =>
    ctx.setDefault(platform, `speech.voiceMode.${key}`, value)
  );

  if (added.length === 0) {
    ctx.log('speech.voiceMode already complete; nothing to add');
    return;
  }
  await ctx.writeJson(PLATFORM_PATH, platform);
  ctx.log(`Added speech.voiceMode defaults: ${added.map(([key]) => key).join(', ')}`);
}
