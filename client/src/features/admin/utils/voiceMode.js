import {
  VOICE_END_OF_TURN_SILENCE_RANGE_MS,
  VOICE_INSTRUCTION_MAX_CHARS,
  VOICE_LISTENING_STYLES,
  VOICE_MAX_SESSION_RANGE_MINUTES,
  VOICE_MODE_DEFAULTS,
  VOICE_THINKING_LEVELS
} from '../../../../../shared/voiceMode.js';

/**
 * Voice mode settings of the admin pages: `platform.speech.voiceMode` (Admin →
 * Voice Input) and the app's `inputMode.voiceMode` (app editor). The form shape
 * is the stored shape; these helpers fill in defaults for the form and clean the
 * object again before it is saved.
 */

export { VOICE_INSTRUCTION_MAX_CHARS, VOICE_LISTENING_STYLES, VOICE_THINKING_LEVELS };
export const END_OF_TURN_SILENCE_RANGE = { ...VOICE_END_OF_TURN_SILENCE_RANGE_MS, step: 50 };
export const MAX_SESSION_MINUTES_RANGE = { ...VOICE_MAX_SESSION_RANGE_MINUTES, step: 1 };
/** Languages with an editable system prompt override. Other keys are kept as stored. */
export const VOICE_PROMPT_LANGUAGES = ['en', 'de'];

export const DEFAULT_VOICE_MODE = VOICE_MODE_DEFAULTS;

/**
 * The voice style instruction the server appends to the app's system prompt
 * when none is set in `systemPrompt`. Shown as a hint under the override
 * fields; a unit test keeps it equal to the server's built-in text
 * (`DEFAULT_VOICE_INSTRUCTIONS` in `server/services/chat/voiceMode.js`).
 */
export const BUILT_IN_VOICE_PROMPTS = {
  en:
    'The user is talking to you by voice and hears your answer read aloud. Answer ' +
    'conversationally and briefly: lead with the answer, usually 1-4 sentences. Do not use ' +
    'tables, code blocks, headings, bullet lists, URLs, or emoji unless the user asks for them. ' +
    'Say numbers and units the way they are spoken. If the answer is long, give a summary and ' +
    'offer details. If you do include a table, chart or image, tell the user in one short ' +
    'sentence that you put it in the chat.',
  de:
    'Der Nutzer spricht per Sprache mit dir und hört deine Antwort vorgelesen. Antworte im ' +
    'Gesprächston und kurz: Beginne mit der Antwort, in der Regel in 1-4 Sätzen. Verwende keine ' +
    'Tabellen, Codeblöcke, Überschriften, Aufzählungslisten, URLs oder Emojis, es sei denn, der ' +
    'Nutzer wünscht sie ausdrücklich. Sprich Zahlen und Einheiten so aus, wie man sie spricht. ' +
    'Ist die Antwort lang, gib eine Zusammenfassung und biete Details an. Wenn du doch eine ' +
    'Tabelle, ein Diagramm oder ein Bild lieferst, sag dem Nutzer in einem kurzen Satz, dass du ' +
    'es in den Chat gestellt hast.'
};

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Whole number inside the range; the default when the value is no number. */
export const clampNumber = (value, { min, max }, fallback) => {
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

/**
 * The stored `speech.voiceMode` as form state: every field present, the
 * system prompt overrides copied so editing them never touches the stored object.
 */
export function toFormVoiceMode(voiceMode) {
  const stored = isPlainObject(voiceMode) ? voiceMode : {};
  return {
    ...DEFAULT_VOICE_MODE,
    ...stored,
    systemPrompt: isPlainObject(stored.systemPrompt) ? { ...stored.systemPrompt } : {}
  };
}

/**
 * The form state as it is saved: numbers inside their range, blank prompt
 * overrides dropped. Keys the form does not know stay as they are stored.
 *
 * @param {object} form Form-shaped `voiceMode`.
 * @param {object} [stored] The `voiceMode` object currently on disk.
 */
export function toSavedVoiceMode(form, stored) {
  const systemPrompt = {};
  for (const [language, text] of Object.entries(form.systemPrompt || {})) {
    if (typeof text === 'string' && text.trim()) systemPrompt[language] = text;
  }
  return {
    ...(isPlainObject(stored) ? stored : {}),
    enabled: Boolean(form.enabled),
    appDefault: Boolean(form.appDefault),
    ttsModelId: form.ttsModelId || '',
    listeningStyle: VOICE_LISTENING_STYLES.includes(form.listeningStyle)
      ? form.listeningStyle
      : DEFAULT_VOICE_MODE.listeningStyle,
    bargeIn: Boolean(form.bargeIn),
    endOfTurnSilenceMs: clampNumber(
      form.endOfTurnSilenceMs,
      END_OF_TURN_SILENCE_RANGE,
      DEFAULT_VOICE_MODE.endOfTurnSilenceMs
    ),
    thinkingLevel: VOICE_THINKING_LEVELS.includes(form.thinkingLevel)
      ? form.thinkingLevel
      : DEFAULT_VOICE_MODE.thinkingLevel,
    maxSessionMinutes: clampNumber(
      form.maxSessionMinutes,
      MAX_SESSION_MINUTES_RANGE,
      DEFAULT_VOICE_MODE.maxSessionMinutes
    ),
    systemPrompt
  };
}

/**
 * `inputMode` with its `voiceMode` changed by `patch`. A key set to
 * `undefined`, an empty string or an empty object is left out, and
 * `voiceMode` itself is left out once nothing is set, so an app that follows
 * the platform keeps a clean config.
 *
 * @param {object} [inputMode] The app's current `inputMode`.
 * @param {object} patch Fields of `voiceMode` to set (or clear).
 * @returns {object} The next `inputMode`.
 */
export function withVoiceModeSettings(inputMode, patch) {
  const { voiceMode: current, ...rest } = inputMode || {};
  const next = {};
  for (const [key, value] of Object.entries({ ...current, ...patch })) {
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (isPlainObject(value) && Object.keys(value).length === 0);
    if (!empty) next[key] = value;
  }
  return Object.keys(next).length > 0 ? { ...rest, voiceMode: next } : rest;
}
