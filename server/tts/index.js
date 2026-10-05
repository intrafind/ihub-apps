/**
 * Text-to-speech provider registry and the read-aloud service.
 *
 * Maps a `modelType: 'tts'` model's `provider` to a speech implementation —
 * parallel to `server/transcription/index.js` and, like it, separate from the
 * chat adapter pipeline: a TTS model is never a chat model.
 *
 * ## Provider contract
 *
 *   sampleRate                         → number   Hz of the PCM `synthesize` emits
 *   resolveUpstream(model, { language }) → cfg    `{ url, apiKey, model, voice, … }`
 *     `language` is the message's language (server/tts/language.js); the
 *     provider picks the voice configured for it.
 *   synthesize({ cfg, text, signal, onAudio }) → Promise<{ usage }>
 *     Streams 16-bit signed little-endian mono PCM to `onAudio(Buffer)` as the
 *     provider generates it, awaiting each call (backpressure). Rejects with a
 *     `TtsUpstreamError` on an upstream failure; stops when `signal` aborts.
 *
 * Optional, for providers with managed voices (Admin → Models → Voices):
 *   listVoices(cfg)                    → Promise<voice[]>
 *   createVoice(cfg, { name, audio, filename, languages, gender }) → Promise<voice>
 *   deleteVoice(cfg, voiceId)          → Promise<void>
 *   where voice is `{ id, slug, name, languages, gender, type }`.
 *
 * Every provider emits the same PCM format, so the browser player
 * (`client/src/features/voice/utils/pcmStreamPlayer.js`) never knows which
 * provider spoke.
 */
import configCache from '../configCache.js';
import mistralTtsProvider from './mistralTtsProvider.js';
import googleTtsProvider from './googleTtsProvider.js';
import { toSpeechText, splitSpeechText } from './speechText.js';

const providers = {
  mistral: mistralTtsProvider,
  google: googleTtsProvider
};

/** Encoding of every byte `/api/voice/speech` streams. */
export const TTS_AUDIO_ENCODING = 'pcm_s16le';

/** Most characters of speakable text one request may synthesize. */
export const DEFAULT_MAX_CHARACTERS = 20_000;

/** Characters per upstream request; Mistral recommends about 300 words. */
export const CHUNK_MAX_CHARACTERS = 1500;

/**
 * @param {string} providerId
 * @returns {Object|null} The provider implementation, or null when unknown.
 */
export function getTtsProvider(providerId) {
  return providers[providerId] || null;
}

/**
 * @param {Object} model
 * @returns {boolean} True when the model is a text-to-speech model.
 */
export function isTtsModel(model) {
  return model?.modelType === 'tts';
}

/**
 * Resolve which TTS model serves a read-aloud request and whether this user
 * may use it.
 *
 * Without a `modelId` the platform default (`speech.tts.defaultModelId`) is
 * used, and only while read aloud is switched on (`speech.tts.enabled`). An
 * explicit `modelId` is any enabled `tts` model the user's groups permit, like
 * any other model — the platform switch decides whether the chat offers the
 * button, the model permission decides who may use the model.
 *
 * @param {{ modelId?: string, user?: Object, platform?: Object }} params
 * @returns {{ ok: true, model: Object, provider: Object }
 *   | { ok: false, status: number, code: string, error: string }}
 */
export function resolveTtsModel({ modelId, user, platform } = {}) {
  const tts = platform?.speech?.tts || {};
  let id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id) {
    if (!tts.enabled || !tts.defaultModelId) {
      return {
        ok: false,
        status: 503,
        code: 'not-configured',
        error: 'Read aloud is not configured'
      };
    }
    id = tts.defaultModelId;
  }

  const { data: models = [] } = configCache.getModels(true);
  const model = models.find(m => m.id === id);
  if (!model || !isTtsModel(model)) {
    return {
      ok: false,
      status: 404,
      code: 'unknown-model',
      error: `Unknown text-to-speech model: ${id}`
    };
  }
  if (model.enabled === false) {
    return {
      ok: false,
      status: 503,
      code: 'model-disabled',
      error: `Text-to-speech model "${id}" is disabled`
    };
  }

  // Fail closed: no computed permissions means no access.
  const allowed = user?.permissions?.models;
  if (!allowed || !(allowed.has('*') || allowed.has(id))) {
    return {
      ok: false,
      status: 403,
      code: 'not-permitted',
      error: `Not permitted to use text-to-speech model: ${id}`
    };
  }

  const provider = getTtsProvider(model.provider);
  if (!provider) {
    return {
      ok: false,
      status: 501,
      code: 'unsupported-provider',
      error: `Unsupported text-to-speech provider: ${model.provider}`
    };
  }
  return { ok: true, model, provider };
}

/**
 * Prepare a message for synthesis: Markdown to speakable text, capped at
 * `maxCharacters` (cut at a word), split into upstream-sized pieces.
 *
 * @param {string} message
 * @param {{ maxCharacters?: number }} [opts]
 * @returns {{ chunks: string[], characters: number, truncated: boolean }}
 */
export function prepareSpeech(message, { maxCharacters = DEFAULT_MAX_CHARACTERS } = {}) {
  let text = toSpeechText(message);
  let truncated = false;
  if (text.length > maxCharacters) {
    const cut = text.slice(0, maxCharacters);
    const lastSpace = cut.search(/\s\S*$/);
    text = lastSpace > maxCharacters * 0.8 ? cut.slice(0, lastSpace) : cut;
    truncated = true;
  }
  const chunks = splitSpeechText(text, { maxChars: CHUNK_MAX_CHARACTERS });
  return { chunks, characters: chunks.reduce((n, c) => n + c.length, 0), truncated };
}

/**
 * Synthesize `chunks` one after another through `provider`, handing all audio
 * to `onAudio` as one continuous PCM stream. The provider generates several
 * times faster than real time, so the next piece is requested only when the
 * previous one has finished streaming and the listener never hears the seam.
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {Object} params.cfg - `provider.resolveUpstream(model)`
 * @param {string[]} params.chunks
 * @param {AbortSignal} [params.signal]
 * @param {(pcm: Buffer) => (void|Promise<void>)} params.onAudio
 * @returns {Promise<{ chunks: number }>} How many pieces were synthesized.
 */
export async function synthesizeChunks({ provider, cfg, chunks, signal, onAudio }) {
  let completed = 0;
  for (const text of chunks) {
    if (signal?.aborted) break;
    await provider.synthesize({ cfg, text, signal, onAudio });
    completed++;
  }
  return { chunks: completed };
}

export default {
  getTtsProvider,
  isTtsModel,
  resolveTtsModel,
  prepareSpeech,
  synthesizeChunks
};
