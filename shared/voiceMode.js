/**
 * Voice mode settings, resolved the same way on the server and in the browser.
 *
 * Voice mode is a spoken conversation with an app. Whether it is available for
 * an app, and how it behaves, comes from two places:
 *
 * - the platform: `platform.speech.voiceMode` (Admin → Voice Input)
 * - the app: `app.inputMode.voiceMode`, next to the microphone settings
 *
 * The platform switch (`enabled`) turns the feature on for the instance.
 * `appDefault` decides the apps that say nothing, and an app can turn voice mode
 * on or off for itself. An app that disabled voice input (its microphone) has
 * no voice mode either.
 *
 * Pure and tolerant: missing or malformed input yields the defaults and never
 * throws, because the browser feeds this whatever the platform config endpoint
 * answered, and the server whatever an admin saved by hand.
 *
 * @module shared/voiceMode
 */

/** How the user takes a turn: the app listens for speech, or the user holds a button. */
export const VOICE_LISTENING_STYLES = Object.freeze(['hands-free', 'push-to-talk']);

/**
 * Reasoning levels voice mode may ask for. These are the lower-case spellings
 * of `thinkingLevel` in the chat request (the request schema also accepts the
 * upper-case SDK constants, which this never produces).
 */
export const VOICE_THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);

/** Accepted range of `endOfTurnSilenceMs`: how long a pause ends the user's turn. */
export const VOICE_END_OF_TURN_SILENCE_RANGE_MS = Object.freeze({ min: 300, max: 3000 });

/** Accepted range of `maxSessionMinutes`: the longest one voice session runs. */
export const VOICE_MAX_SESSION_RANGE_MINUTES = Object.freeze({ min: 1, max: 240 });

/** Longest voice style instruction (`speech.voiceMode.systemPrompt`, per language), in characters. */
export const VOICE_INSTRUCTION_MAX_CHARS = 4000;

/** `platform.speech.voiceMode` as shipped (see `server/defaults/config/platform.json`). */
export const VOICE_MODE_DEFAULTS = Object.freeze({
  enabled: false,
  appDefault: false,
  ttsModelId: '',
  listeningStyle: 'hands-free',
  bargeIn: true,
  endOfTurnSilenceMs: 800,
  thinkingLevel: 'low',
  maxSessionMinutes: 30,
  systemPrompt: Object.freeze({})
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The first of `values` that is a non-blank string, trimmed; else `''`. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** `value` when it is one of `allowed` (case-insensitive, returned in the allowed spelling). */
function pickOption(value, allowed) {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  return allowed.find(option => option === lower);
}

/** A finite number, rounded and clamped into `{ min, max }`; `fallback` for anything else. */
function clampNumber(value, { min, max }, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Resolve the voice mode settings of an app.
 *
 * @param {Object} [options]
 * @param {Object} [options.platform] - The platform config (on the client, `platformConfig`).
 * @param {Object} [options.app] - The app config.
 * @returns {{
 *   platformEnabled: boolean,
 *   enabled: boolean,
 *   listeningStyle: 'hands-free'|'push-to-talk',
 *   ttsModelId: string,
 *   voice: string,
 *   bargeIn: boolean,
 *   endOfTurnSilenceMs: number,
 *   thinkingLevel: 'minimal'|'low'|'medium'|'high',
 *   maxSessionMinutes: number
 * }}
 *   - `platformEnabled`: the admin switched voice mode on for the instance.
 *   - `enabled`: voice mode is on for this app — the platform switch is on, the
 *     app has not disabled its microphone, and the app turned it on
 *     (`inputMode.voiceMode.enabled`, else the platform `appDefault`).
 *   - `listeningStyle`, `ttsModelId`, `voice`: the app's own value, else the
 *     platform's, else the default. `ttsModelId` falls back to the read-aloud
 *     model (`speech.tts.defaultModelId`) and then to `''`, meaning no model.
 *   - `bargeIn`, `endOfTurnSilenceMs`, `thinkingLevel`, `maxSessionMinutes`:
 *     platform values, clamped to their ranges (see the `VOICE_*_RANGE_*` exports).
 *
 *   Whether the `voiceMode` feature flag is on and whether the user may use the
 *   speech models are separate checks; this only reads the configuration.
 */
export function resolveVoiceModeSettings(options) {
  const { platform, app } = isObject(options) ? options : {};
  const speech = isObject(platform?.speech) ? platform.speech : {};
  const platformVoice = isObject(speech.voiceMode) ? speech.voiceMode : {};
  const input = isObject(app?.inputMode) ? app.inputMode : {};
  const appVoice = isObject(input.voiceMode) ? input.voiceMode : {};

  const platformEnabled = platformVoice.enabled === true;
  const appDefault = platformVoice.appDefault === true;

  // An app that turned its microphone off has no voice input at all. The
  // top-level `microphone` is the older spelling of the same setting.
  const micAllowed =
    (input.microphone?.enabled ??
      (isObject(app?.microphone) ? app.microphone.enabled : undefined)) !== false;
  const appEnabled = typeof appVoice.enabled === 'boolean' ? appVoice.enabled : appDefault;

  return {
    platformEnabled,
    enabled: platformEnabled && micAllowed && appEnabled,
    listeningStyle:
      pickOption(appVoice.listeningStyle, VOICE_LISTENING_STYLES) ??
      pickOption(platformVoice.listeningStyle, VOICE_LISTENING_STYLES) ??
      VOICE_MODE_DEFAULTS.listeningStyle,
    ttsModelId: firstString(
      appVoice.ttsModelId,
      platformVoice.ttsModelId,
      speech.tts?.defaultModelId
    ),
    voice: firstString(appVoice.voice, platformVoice.voice),
    bargeIn:
      typeof platformVoice.bargeIn === 'boolean'
        ? platformVoice.bargeIn
        : VOICE_MODE_DEFAULTS.bargeIn,
    endOfTurnSilenceMs: clampNumber(
      platformVoice.endOfTurnSilenceMs,
      VOICE_END_OF_TURN_SILENCE_RANGE_MS,
      VOICE_MODE_DEFAULTS.endOfTurnSilenceMs
    ),
    thinkingLevel:
      pickOption(platformVoice.thinkingLevel, VOICE_THINKING_LEVELS) ??
      VOICE_MODE_DEFAULTS.thinkingLevel,
    maxSessionMinutes: clampNumber(
      platformVoice.maxSessionMinutes,
      VOICE_MAX_SESSION_RANGE_MINUTES,
      VOICE_MODE_DEFAULTS.maxSessionMinutes
    )
  };
}
