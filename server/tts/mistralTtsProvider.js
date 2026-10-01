/**
 * Mistral text-to-speech provider (Voxtral TTS, `voxtral-mini-tts-latest`).
 *
 * `POST {url}` with `{ model, input, voice_id, response_format: 'pcm',
 * stream: true }` answers with Server-Sent Events:
 *
 *   event: speech.audio.delta  data: {"type":"speech.audio.delta","audio_data":"<base64>"}
 *   …
 *   event: speech.audio.done   data: {"type":"speech.audio.done","usage":{…}}
 *
 * `pcm` is raw float32 little-endian, 24 kHz, mono — the lowest-latency format
 * (first audio in under a second). It is converted here to the canonical
 * 16-bit PCM the browser player expects (see `server/tts/index.js`), which also
 * halves what goes over the wire to the browser.
 *
 * Docs: https://docs.mistral.ai/capabilities/audio/text_to_speech/
 */
import { createParser } from 'eventsource-parser';
import { httpFetch } from '../utils/httpConfig.js';
import { getReadableStream } from '../utils/streamUtils.js';
import { expandEnvVars, resolveApiKey } from '../transcription/credentials.js';
import { selectVoice } from './language.js';

export const DEFAULT_URL = 'https://api.mistral.ai/v1/audio/speech';
export const DEFAULT_MODEL = 'voxtral-mini-tts-latest';
/** A preset voice every Mistral account has. */
export const DEFAULT_VOICE = 'en_paul_neutral';
/** Mistral's `pcm` output rate. */
export const sampleRate = 24000;

/** Longest a single request may take, from send to the last audio byte. */
const REQUEST_TIMEOUT_MS = 180_000;
/** Longest the stream may go silent before the request is given up on. */
const IDLE_TIMEOUT_MS = 30_000;

/** An upstream failure, with the HTTP status when the upstream answered. */
export class TtsUpstreamError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'TtsUpstreamError';
    this.status = status;
  }
}

/**
 * @param {Object} model - The TTS model config as stored in cache.
 * @param {{ language?: string|null }} [opts] - The message's language: picks
 *   the voice configured for it in `tts.voices`, else `tts.voice`.
 * @returns {{ url: string, apiKey: string, model: string, voice: string }}
 */
export function resolveUpstream(model, { language } = {}) {
  return {
    url: expandEnvVars(model?.url || '').trim() || DEFAULT_URL,
    // Same chain a Mistral chat model uses: model key, the `mistral` provider
    // key, <MODEL_ID>_API_KEY, MISTRAL_API_KEY.
    apiKey: resolveApiKey(model, { credentialProvider: 'mistral', envVars: ['MISTRAL_API_KEY'] }),
    model: model?.modelId || DEFAULT_MODEL,
    voice: selectVoice(model?.tts, language) || DEFAULT_VOICE
  };
}

/**
 * Converts float32 LE sample bytes into int16 LE sample bytes. Deltas are not
 * guaranteed to end on a sample boundary, so a partial trailing sample is
 * carried into the next call.
 */
export function createFloat32ToPcm16Converter() {
  let carry = Buffer.alloc(0);
  return function convert(bytes) {
    const input = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const samples = Math.floor(input.length / 4);
    carry = Buffer.from(input.subarray(samples * 4));
    const out = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const f = input.readFloatLE(i * 4);
      const clamped = f > 1 ? 1 : f < -1 ? -1 : Number.isNaN(f) ? 0 : f;
      out.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), i * 2);
    }
    return out;
  };
}

/** Pull a readable message out of an upstream error body. */
function describeError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.message || parsed?.error?.message || parsed?.detail || parsed?.error || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = bodyText || '';
  }
  detail = String(detail).slice(0, 300);
  if (status === 401 || status === 403) {
    return `Mistral rejected the API key (HTTP ${status})`;
  }
  return detail
    ? `Mistral TTS failed (HTTP ${status}): ${detail}`
    : `Mistral TTS failed (HTTP ${status})`;
}

/**
 * Synthesize one piece of text, handing 16-bit PCM to `onAudio` as it streams.
 * `onAudio` may return a promise; the next delta is not read before it
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
    throw new TtsUpstreamError('No Mistral API key is configured for this text-to-speech model');
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
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model,
          input: text,
          voice_id: cfg.voice,
          response_format: 'pcm',
          stream: true
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new TtsUpstreamError('Mistral TTS timed out');
      // The message can carry the upstream address; keep only the code.
      throw new TtsUpstreamError(`Mistral TTS unreachable: ${error.code || 'connection error'}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new TtsUpstreamError(describeError(response.status, bodyText), {
        status: response.status
      });
    }

    const convert = createFloat32ToPcm16Converter();
    const events = [];
    const parser = createParser({ onEvent: event => events.push(event) });
    const reader = getReadableStream(response).getReader();
    const decoder = new TextDecoder();
    let usage = null;
    let done = false;

    try {
      while (!done) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        touch();
        parser.feed(decoder.decode(value, { stream: true }));

        while (events.length) {
          const event = events.shift();
          let data;
          try {
            data = JSON.parse(event.data);
          } catch {
            continue;
          }
          const type = data?.type || event.event;
          if (type === 'speech.audio.delta' && typeof data.audio_data === 'string') {
            const pcm = convert(Buffer.from(data.audio_data, 'base64'));
            if (pcm.length) await onAudio(pcm);
          } else if (type === 'speech.audio.done') {
            usage = data.usage || null;
            done = true;
          } else if (type === 'error' || data?.error) {
            const message = data?.error?.message || data?.message || 'stream error';
            throw new TtsUpstreamError(`Mistral TTS failed: ${String(message).slice(0, 300)}`);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new TtsUpstreamError('Mistral TTS timed out');
      throw error;
    } finally {
      reader.cancel().catch(() => {});
    }
    return { usage };
  } finally {
    clearTimeout(overall);
    clearTimeout(idle);
    signal?.removeEventListener('abort', abort);
  }
}

// ---------------------------------------------------------------------------
// Voices: the presets every account has, and custom voices cloned from a
// short recording (`POST /v1/audio/voices` with a name and one audio sample).
// Admin-only (server/routes/admin/models.js); the key never leaves the server.
// ---------------------------------------------------------------------------

/** Pages of 100 voices fetched at most when listing. */
const MAX_VOICE_PAGES = 10;

/** `…/v1/audio/speech` → `…/v1/audio/voices`; any other URL → its origin's. */
export function voicesUrl(cfg) {
  const url = String(cfg?.url || DEFAULT_URL).replace(/\/+$/, '');
  if (/\/audio\/speech$/.test(url)) return url.replace(/\/audio\/speech$/, '/audio/voices');
  try {
    return `${new URL(url).origin}/v1/audio/voices`;
  } catch {
    return DEFAULT_URL.replace(/\/audio\/speech$/, '/audio/voices');
  }
}

/** The fields of a Mistral voice an admin needs to pick one. */
function toVoice(item) {
  return {
    id: item.id,
    slug: item.slug || null,
    name: item.name,
    languages: Array.isArray(item.languages) ? item.languages : [],
    gender: item.gender || null,
    type: item.type || null
  };
}

async function voicesRequest(cfg, path, init = {}) {
  if (!cfg.apiKey) {
    throw new TtsUpstreamError('No Mistral API key is configured for this text-to-speech model');
  }
  let response;
  try {
    response = await httpFetch(`${voicesUrl(cfg)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      },
      signal: init.signal || AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw new TtsUpstreamError(`Mistral voices unreachable: ${error.code || 'connection error'}`);
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new TtsUpstreamError(describeError(response.status, bodyText), {
      status: response.status
    });
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

/**
 * Every voice the account can use: the presets and its own.
 *
 * @param {Object} cfg - `resolveUpstream(model)`
 * @returns {Promise<Array<{ id, slug, name, languages, gender, type }>>}
 */
export async function listVoices(cfg) {
  const voices = [];
  for (let page = 1; page <= MAX_VOICE_PAGES; page++) {
    const body = await voicesRequest(cfg, `?limit=100&page=${page}`);
    for (const item of body?.items || []) voices.push(toVoice(item));
    if (!body?.total_pages || page >= body.total_pages) break;
  }
  return voices;
}

/**
 * Create a custom voice from one recording of the speaker.
 *
 * @param {Object} cfg - `resolveUpstream(model)`
 * @param {{ name: string, audio: Buffer, filename: string, languages?: string[],
 *   gender?: string }} voice
 * @returns {Promise<{ id, slug, name, languages, gender, type }>}
 */
export async function createVoice(cfg, { name, audio, filename, languages, gender }) {
  const body = await voicesRequest(cfg, '', {
    method: 'POST',
    body: JSON.stringify({
      name,
      sample_audio: audio.toString('base64'),
      sample_filename: filename,
      ...(languages?.length ? { languages } : {}),
      ...(gender ? { gender } : {})
    })
  });
  return toVoice(body || {});
}

/** Delete a custom voice. */
export async function deleteVoice(cfg, voiceId) {
  await voicesRequest(cfg, `/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
}

export default {
  id: 'mistral',
  sampleRate,
  resolveUpstream,
  synthesize,
  listVoices,
  createVoice,
  deleteVoice
};
