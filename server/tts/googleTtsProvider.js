/**
 * Google Gemini text-to-speech provider (`gemini-3.8-flash-tts`,
 * `gemini-3.8-flash-lite-tts`).
 *
 * `POST …/models/{model}:streamGenerateContent?alt=sse` with
 *
 *   { contents: [{ role: 'user', parts: [{ text }] }],
 *     generationConfig: { responseModalities: ['AUDIO'],
 *                         speechConfig: { voiceConfig: … } } }
 *
 * `voiceConfig` is a union (see `voiceConfigFor`): a prebuilt voice goes in
 * `prebuiltVoiceConfig.voiceName`, which every Gemini TTS model accepts; any
 * other id (a voice-library or custom voice, `voice_…`) in `voice`, which the
 * 3.8 models added.
 *
 * answers with Server-Sent Events, each a `GenerateContentResponse` whose
 * `candidates[0].content.parts[].inlineData.data` holds base64 audio. Streamed
 * audio is headerless 16-bit signed little-endian PCM, 24 kHz, mono — already
 * the canonical format the browser player expects (see `server/tts/index.js`).
 * The last event carries `finishReason`.
 *
 * The voices are multilingual and the language is detected from the text, so a
 * voice per language (`tts.voices`) is optional. The key is the one the Gemini
 * chat models use and goes in the `x-goog-api-key` header, never in the URL.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/speech-generation
 */
import { createParser } from 'eventsource-parser';
import { httpFetch } from '../utils/httpConfig.js';
import { getReadableStream } from '../utils/streamUtils.js';
import { expandEnvVars, resolveApiKey } from '../transcription/credentials.js';
import { selectVoice } from './language.js';
import { TtsUpstreamError } from './errors.js';

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
/** A prebuilt voice every Gemini TTS model has. */
export const DEFAULT_VOICE = 'Kore';
/** Rate of the streamed PCM. */
export const sampleRate = 24000;

/** The prebuilt voices of the Gemini TTS models. */
export const PREBUILT_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat'
];

/** Longest a single request may take, from send to the last audio byte. */
const REQUEST_TIMEOUT_MS = 180_000;
/** Longest the stream may go silent before the request is given up on. */
const IDLE_TIMEOUT_MS = 30_000;
/** Size of a canonical WAV header, stripped should a chunk carry one. */
const WAV_HEADER_BYTES = 44;

/**
 * The streaming endpoint for a model: its `url` when that names a
 * `:streamGenerateContent` or `:generateContent` method, otherwise the
 * method under `{url or API base}/models/{modelId}`.
 *
 * @param {string} url
 * @param {string} model
 * @returns {string}
 */
export function streamUrl(url, model) {
  const base = String(url || '').trim() || API_BASE;
  let endpoint;
  if (base.includes(':streamGenerateContent')) endpoint = base;
  else if (base.includes(':generateContent')) {
    endpoint = base.replace(':generateContent', ':streamGenerateContent');
  } else {
    const root = base.replace(/\/+$/, '');
    const versioned = /\/v1(beta|alpha)?$/.test(root) ? root : `${root}/v1beta`;
    endpoint = `${versioned}/models/${encodeURIComponent(model)}:streamGenerateContent`;
  }
  const out = new URL(endpoint);
  out.searchParams.set('alt', 'sse');
  return out.toString();
}

/**
 * @param {Object} model - The TTS model config as stored in cache.
 * @param {{ language?: string|null }} [opts] - The message's language: picks
 *   the voice configured for it in `tts.voices`, else `tts.voice`.
 * @returns {{ url: string, apiKey: string, model: string, voice: string }}
 */
export function resolveUpstream(model, { language } = {}) {
  const modelId = model?.modelId || DEFAULT_MODEL;
  return {
    url: streamUrl(expandEnvVars(model?.url || ''), modelId),
    // Same chain a Gemini chat model uses: model key, the `google` provider
    // key, <MODEL_ID>_API_KEY, GOOGLE_API_KEY.
    apiKey: resolveApiKey(model, { credentialProvider: 'google', envVars: ['GOOGLE_API_KEY'] }),
    model: modelId,
    voice: selectVoice(model?.tts, language) || DEFAULT_VOICE
  };
}

/**
 * The `voiceConfig` for a voice id: `prebuiltVoiceConfig.voiceName` for a
 * prebuilt voice, `voice` for any other id (voice library, designed or
 * replicated voices).
 *
 * @param {string} [voice]
 * @returns {Object}
 */
export function voiceConfigFor(voice) {
  const id = voice || DEFAULT_VOICE;
  const prebuilt = PREBUILT_VOICES.find(name => name.toLowerCase() === id.toLowerCase());
  return prebuilt ? { prebuiltVoiceConfig: { voiceName: prebuilt } } : { voice: id };
}

/** The request body for one piece of text. */
export function buildRequest(text, voice) {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: voiceConfigFor(voice) }
    }
  };
}

/**
 * Turn the audio chunks of a stream into whole 16-bit samples: a chunk may end
 * in the middle of one, so a trailing odd byte is carried into the next call.
 * A chunk that is a WAV file (RIFF header) loses its header.
 */
export function createPcm16Aligner() {
  let carry = Buffer.alloc(0);
  return function align(bytes) {
    let input = bytes;
    if (
      input.length >= WAV_HEADER_BYTES &&
      input.toString('ascii', 0, 4) === 'RIFF' &&
      input.toString('ascii', 8, 12) === 'WAVE'
    ) {
      input = input.subarray(WAV_HEADER_BYTES);
    }
    const joined = carry.length ? Buffer.concat([carry, input]) : input;
    const even = joined.length - (joined.length % 2);
    carry = Buffer.from(joined.subarray(even));
    return joined.subarray(0, even);
  };
}

/** Pull a readable message out of an upstream error body. */
export function describeError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    const error = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    detail = error?.message || parsed?.message || '';
    if (error?.details?.some?.(d => d?.reason === 'API_KEY_INVALID')) {
      return 'Google rejected the API key';
    }
  } catch {
    detail = bodyText || '';
  }
  detail = String(detail).slice(0, 300);
  if (status === 401 || status === 403) {
    return `Google rejected the API key (HTTP ${status})`;
  }
  return detail
    ? `Google TTS failed (HTTP ${status}): ${detail}`
    : `Google TTS failed (HTTP ${status})`;
}

/**
 * Synthesize one piece of text, handing 16-bit PCM to `onAudio` as it streams.
 * `onAudio` may return a promise; the next event is not read before it
 * settles, so a slow client slows the upstream read instead of filling memory.
 *
 * @param {Object} params
 * @param {{ url: string, apiKey: string, model: string, voice: string }} params.cfg
 * @param {string} params.text
 * @param {AbortSignal} [params.signal]
 * @param {(pcm: Buffer) => (void|Promise<void>)} params.onAudio
 * @returns {Promise<{ usage: Object|null }>}
 */
export async function synthesize({ cfg, text, signal, onAudio }) {
  if (!cfg.apiKey) {
    throw new TtsUpstreamError('No Google API key is configured for this text-to-speech model');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const overall = setTimeout(abort, REQUEST_TIMEOUT_MS);
  let idle = setTimeout(abort, IDLE_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(abort, IDLE_TIMEOUT_MS);
  };

  try {
    let response;
    try {
      response = await httpFetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-goog-api-key': cfg.apiKey
        },
        body: JSON.stringify(buildRequest(text, cfg.voice)),
        signal: controller.signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new TtsUpstreamError('Google TTS timed out');
      // The message can carry the upstream address; keep only the code.
      throw new TtsUpstreamError(`Google TTS unreachable: ${error.code || 'connection error'}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new TtsUpstreamError(describeError(response.status, bodyText), {
        status: response.status
      });
    }

    const align = createPcm16Aligner();
    const events = [];
    const parser = createParser({ onEvent: event => events.push(event) });
    const reader = getReadableStream(response).getReader();
    const decoder = new TextDecoder();
    let usage = null;
    let finishReason = null;

    const handleEvents = async () => {
      while (events.length) {
        const event = events.shift();
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (data?.error) {
          const message = data.error.message || 'stream error';
          throw new TtsUpstreamError(`Google TTS failed: ${String(message).slice(0, 300)}`);
        }
        if (data?.usageMetadata) usage = data.usageMetadata;
        const candidate = data?.candidates?.[0];
        for (const part of candidate?.content?.parts || []) {
          const audio = part?.inlineData?.data;
          if (typeof audio !== 'string' || !audio) continue;
          const pcm = align(Buffer.from(audio, 'base64'));
          if (pcm.length) await onAudio(pcm);
        }
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        const blocked = data?.promptFeedback?.blockReason;
        if (blocked) throw new TtsUpstreamError(`Google TTS refused the text: ${blocked}`);
      }
    };

    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) {
          // A last event without its closing blank line still counts.
          parser.feed(`${decoder.decode()}\n\n`);
          await handleEvents();
          break;
        }
        touch();
        parser.feed(decoder.decode(value, { stream: true }));
        await handleEvents();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new TtsUpstreamError('Google TTS timed out');
      throw error;
    } finally {
      reader.cancel().catch(() => {});
    }

    // A stream cut off before its last event (a proxy timeout, a dropped
    // connection) is a failure, not a short answer: the listener would hear
    // part of the text as if it were all of it. So is a stop for any reason
    // other than the end of the text.
    if (!finishReason) {
      throw new TtsUpstreamError('Google TTS stream ended before the audio was complete');
    }
    if (finishReason !== 'STOP') {
      throw new TtsUpstreamError(`Google TTS stopped early: ${finishReason}`);
    }
    return { usage };
  } finally {
    clearTimeout(overall);
    clearTimeout(idle);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * The prebuilt voices. Voice-library and custom voices are managed in Google's
 * own tools; their ids can be set on the model, but are not listed, created or
 * deleted here.
 *
 * @returns {Promise<Array<{ id, slug, name, languages, gender, type }>>}
 */
export async function listVoices() {
  return PREBUILT_VOICES.map(name => ({
    id: name,
    slug: name,
    name,
    languages: [],
    gender: null,
    type: 'preset'
  }));
}

export default {
  id: 'google',
  sampleRate,
  resolveUpstream,
  synthesize,
  listVoices
};
