/**
 * Voice mode on the chat request.
 *
 * A turn the user spoke in voice mode carries `voiceMode: true`
 * (`chatPostSchema`). The answer is read aloud, so the request builder
 * (`RequestBuilder`) adds a voice style instruction after the app's system
 * prompt and keeps reasoning short, and the chat store marks the user message
 * as spoken (`metadata.inputMode: 'voice'`).
 *
 * The flag is a request from the client, never a way around a setting: it is
 * honoured only while the `voiceMode` feature flag and
 * `platform.speech.voiceMode.enabled` are both on. Otherwise it is ignored, and
 * the turn runs as a typed one.
 *
 * @module services/chat/voiceMode
 */
import { isFeatureEnabled } from '../../featureRegistry.js';
import {
  VOICE_INSTRUCTION_MAX_CHARS,
  VOICE_THINKING_LEVELS,
  resolveVoiceModeSettings
} from '../../../shared/voiceMode.js';

/**
 * Built-in voice style instruction, per language. The platform can replace it
 * (`speech.voiceMode.systemPrompt`); a language without a text here gets English.
 */
export const DEFAULT_VOICE_INSTRUCTIONS = Object.freeze({
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
});

/**
 * Whether a turn runs in voice mode: the request asked for it and the platform
 * allows it.
 *
 * @param {Object} params
 * @param {unknown} params.voiceMode - `voiceMode` of the chat request
 * @param {Object} [params.platform] - Platform config (`configCache.getPlatform()`)
 * @param {Object} [params.features] - Saved feature flags (`configCache.getFeatures()`)
 * @returns {boolean}
 */
export function isVoiceTurn({ voiceMode, platform, features } = {}) {
  return (
    voiceMode === true &&
    isFeatureEnabled('voiceMode', features || {}) &&
    platform?.speech?.voiceMode?.enabled === true
  );
}

/** `de-DE` and `DE` become `de`. */
function baseLanguage(language) {
  return typeof language === 'string' ? language.trim().toLowerCase().split(/[-_]/)[0] : '';
}

/** The first non-blank string among the entries of `texts` under `keys`. */
function pickText(texts, keys) {
  for (const key of keys) {
    const value = key && texts?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, VOICE_INSTRUCTION_MAX_CHARS);
    }
  }
  return null;
}

/**
 * The voice style instruction for a request language.
 *
 * The platform text (`speech.voiceMode.systemPrompt`) wins: the request
 * language, then English. Without one, the built-in text for the language, then
 * the built-in English text.
 *
 * @param {Object} params
 * @param {Object} [params.platform] - Platform config
 * @param {string} [params.language] - Request language (`de`, `de-DE`, …)
 * @returns {string}
 */
export function resolveVoiceInstruction({ platform, language } = {}) {
  const base = baseLanguage(language);
  const configured = platform?.speech?.voiceMode?.systemPrompt;
  const override =
    configured && typeof configured === 'object' && !Array.isArray(configured)
      ? pickText(configured, [typeof language === 'string' ? language.trim() : '', base, 'en'])
      : null;
  return override ?? pickText(DEFAULT_VOICE_INSTRUCTIONS, [base, 'en']);
}

/**
 * Add the voice style instruction after the app's system prompt. An app without
 * a system prompt (or a request that bypassed the app's prompts) gets one that
 * holds only the instruction.
 *
 * @param {Array} llmMessages - Prepared messages (mutated in place)
 * @param {string} instruction - Text from {@link resolveVoiceInstruction}
 * @returns {boolean} true when the instruction was added
 */
export function appendVoiceInstruction(llmMessages, instruction) {
  if (!Array.isArray(llmMessages) || !instruction) return false;
  const systemMessage = llmMessages.find(m => m.role === 'system');
  if (!systemMessage) {
    llmMessages.unshift({ role: 'system', content: instruction });
    return true;
  }
  if (typeof systemMessage.content !== 'string') return false;
  if (systemMessage.content.includes(instruction)) return false;
  systemMessage.content = systemMessage.content
    ? `${systemMessage.content}\n\n${instruction}`
    : instruction;
  return true;
}

/**
 * The thinking level a voice turn asks for, or `undefined` to leave the request
 * as it is.
 *
 * Reasoning models add seconds of silence before the first word, so voice turns
 * ask for `speech.voiceMode.thinkingLevel` (default `low`). That is a default,
 * never an override: a level the request or the app already set stays, thinking
 * the request or the app turned off stays off, and a model that does not think
 * is never sent a level. A model the admin set to a level at or below the voice
 * level keeps it: the voice level never raises one.
 *
 * @param {Object} params
 * @param {Object} [params.platform] - Platform config
 * @param {Object} [params.model] - The resolved chat model
 * @param {Object} [params.app] - The app config
 * @param {string|null} [params.thinkingLevel] - `thinkingLevel` of the request (null when unset)
 * @param {boolean} [params.thinkingEnabled] - `thinkingEnabled` of the request
 * @returns {string|undefined}
 */
export function resolveVoiceThinkingLevel({
  platform,
  model,
  app,
  thinkingLevel,
  thinkingEnabled
} = {}) {
  if (thinkingLevel !== undefined && thinkingLevel !== null) return undefined;
  if (thinkingEnabled === false) return undefined;
  if (app?.thinking?.level || app?.thinking?.enabled === false) return undefined;
  if (!model?.thinking?.enabled) return undefined;
  const voiceLevel = resolveVoiceModeSettings({ platform }).thinkingLevel;
  // The model schema also takes the SDK spellings (`MINIMAL`).
  const own = VOICE_THINKING_LEVELS.indexOf(String(model.thinking.level).toLowerCase());
  if (own !== -1 && own <= VOICE_THINKING_LEVELS.indexOf(voiceLevel)) return undefined;
  return voiceLevel;
}

/**
 * `metadata.inputMode` of a stored user message that was spoken in voice mode.
 * Audio is never stored; this only lets the history show the message as spoken.
 */
export const VOICE_INPUT_MODE = 'voice';
