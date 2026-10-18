/**
 * OpenAI-compatible batch transcription provider: `POST …/audio/transcriptions`
 * with the recording as a file, the transcript back as `{ text }`.
 *
 * Serves Whisper and its kin wherever the OpenAI audio API is spoken —
 * T-Systems LLM Hub (`whisper-large-v3`, `whisper-large-v3-turbo`), OpenAI
 * (`whisper-1`, `gpt-4o-transcribe`), a vLLM or LocalAI server — for every
 * transcription model whose `provider` is the `openai` or `local` API type.
 * Those are chat API types too: a model only reaches this provider with
 * `modelType: 'transcription'` (the bridge checks it first).
 *
 * Like `google-transcribe` it is a batch provider: the bridge buffers the PCM
 * the browser streams and calls `transcribe()` once on `stop`, so the
 * transcript arrives in one piece. Upload limits are commonly 25 MB per
 * request (OpenAI's documented cap) — about 13 minutes of 16 kHz PCM16 WAV —
 * so a longer recording is sent in parts of at most `config.maxChunkSeconds`
 * (default 600), each cut at the quietest moment of its last seconds so no
 * word is split, and the texts are joined.
 *
 * The key, in order: the model's own `apiKey`; the providers.json entry its
 * `providerId` names (e.g. `llmhub`), or else the one for its API type;
 * `<MODEL_ID>_API_KEY`; then `<PROVIDERID>_API_KEY` for a linked provider, or
 * `OPENAI_API_KEY` / `LOCAL_API_KEY`. A self-hosted server may need none —
 * then no Authorization header is sent.
 *
 * Model `config` (all optional): `language` (ISO-639-1, e.g. "de"; Whisper
 * detects it otherwise), `prompt` (spelling of names and terms),
 * `maxChunkSeconds`, and `timestamps`: a transcript a user reads (a stored chat
 * turn) then carries the time of each line (`[12:03] …`), asked of the service
 * as `verbose_json` segments. Whisper does not tell speakers apart, so there is
 * no `speakers` here.
 */
import { randomBytes } from 'node:crypto';
import { providerEnvKeyName } from '../../shared/llmProviders.js';
import { httpFetch } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';
import { expandEnvVars, resolveApiKey } from './credentials.js';
import { annotationsOf, formatTranscript, parseOffset } from './transcriptFormat.js';
import { pcm16ToWav, splitPcm } from './wav.js';

/** Used when an `openai` model sets no URL. */
export const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

const TRANSCRIBE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CHUNK_SECONDS = 600;
const MIN_CHUNK_SECONDS = 30;
const MAX_CHUNK_SECONDS = 1500;

/** Endpoints of the same API a model URL may name instead of the base. */
const CALL_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/embeddings',
  '/models',
  '/audio/translations'
];

/**
 * The `/audio/transcriptions` endpoint for a model URL, which may be that
 * endpoint, the API base (`…/v1`, `…/v2`) or another endpoint of the same API
 * (an imported model's `…/chat/completions`). Empty when there is nothing to
 * build on.
 *
 * @param {string} url
 * @param {string} [provider] - `openai` falls back to OpenAI's API.
 * @returns {string}
 */
export function transcriptionsUrl(url, provider) {
  let raw = String(expandEnvVars(url || '')).trim();
  if (!raw) {
    if (provider !== 'openai') return '';
    raw = DEFAULT_OPENAI_BASE;
  }
  const toEndpoint = path => {
    let p = path.replace(/\/+$/, '');
    if (/\/audio\/transcriptions$/i.test(p)) return p;
    const suffix = CALL_SUFFIXES.find(s => p.toLowerCase().endsWith(s));
    if (suffix) p = p.slice(0, -suffix.length);
    return `${p}/audio/transcriptions`;
  };
  try {
    const parsed = new URL(raw);
    parsed.pathname = toEndpoint(parsed.pathname);
    return parsed.toString();
  } catch {
    return toEndpoint(raw);
  }
}

/**
 * @param {Object} model - Transcription model config, as cached.
 * @returns {{ url: string, apiKey: string, model: string, options: Object }}
 */
export function resolveUpstream(model) {
  // A model linked to a provider entry (LLM Hub) uses that entry's key only,
  // as its chat models do.
  const linked = model?.providerId && model.providerId !== model.provider ? model.providerId : '';
  const envVars = linked
    ? [providerEnvKeyName(linked)]
    : model?.provider === 'local'
      ? ['LOCAL_API_KEY']
      : ['OPENAI_API_KEY'];
  return {
    url: transcriptionsUrl(model?.url, model?.provider),
    apiKey: resolveApiKey(model, { credentialProvider: linked || model?.provider, envVars }),
    model: model?.modelId || '',
    options: model?.config || {}
  };
}

/**
 * A user-facing message for a failed request: the status and the service's
 * own message, never the URL.
 *
 * @param {number} status
 * @param {string} body
 * @param {boolean} sentKey
 * @returns {string}
 */
export function describeError(status, body, sentKey) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message ?? '';
    detail = typeof message === 'string' ? message : JSON.stringify(message);
  } catch {
    detail = String(body || '').trim();
  }
  detail = detail.slice(0, 200);
  if (status === 401) {
    return sentKey
      ? 'the service rejected the API key (HTTP 401)'
      : 'the service needs an API key (HTTP 401)';
  }
  if (status === 413) {
    return 'the recording part is too large for the service (HTTP 413); lower config.maxChunkSeconds';
  }
  return `the service answered HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/**
 * A `multipart/form-data` body of text fields and one file, as a Buffer, so
 * it goes through `httpFetch` like any other body.
 *
 * @param {Record<string, string>} fields
 * @param {{ name: string, filename: string, type: string, data: Buffer }} file
 * @returns {{ body: Buffer, contentType: string }}
 */
export function buildMultipart(fields, file) {
  const boundary = `----ihub${randomBytes(12).toString('hex')}`;
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    )
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * One request. `verbose` asks for `verbose_json`, which adds the segments (each
 * with its start and end in seconds) to the text.
 *
 * @returns {Promise<{ text: string, segments: Array<{ text: string, start: number|null, end: number|null }> }>}
 */
async function transcribePart({ cfg, wav, signal, verbose = false }) {
  const fields = { model: cfg.model, response_format: verbose ? 'verbose_json' : 'json' };
  if (cfg.options?.language) fields.language = String(cfg.options.language);
  if (cfg.options?.prompt) fields.prompt = String(cfg.options.prompt);
  const { body, contentType } = buildMultipart(fields, {
    name: 'file',
    filename: 'audio.wav',
    type: 'audio/wav',
    data: wav
  });

  const headers = { 'Content-Type': contentType };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
  // The platform's transport: its proxy, TLS settings and DNS guard apply,
  // as they do to the model import that found this endpoint.
  const res = await httpFetch(cfg.url, {
    method: 'POST',
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!res.ok) {
    const err = new Error(
      describeError(res.status, await res.text().catch(() => ''), !!cfg.apiKey)
    );
    err.status = res.status;
    throw err;
  }
  // response_format=json gives `{ text }`; a server that ignores it may answer
  // with the bare text.
  if ((res.headers.get('content-type') || '').includes('json')) {
    const parsed = await res.json();
    const segments = Array.isArray(parsed?.segments)
      ? parsed.segments.map(segment => ({
          text: typeof segment?.text === 'string' ? segment.text : '',
          start: parseOffset(segment?.start),
          end: parseOffset(segment?.end)
        }))
      : [];
    return { text: typeof parsed?.text === 'string' ? parsed.text.trim() : '', segments };
  }
  return { text: (await res.text()).trim(), segments: [] };
}

/**
 * Transcribe a complete PCM16 buffer, in parts when it is long.
 *
 * With `annotate` and `config.timestamps` the text is one line per stretch of
 * speech, led by its time (see `transcriptFormat.js`); the times of a part are
 * counted from the start of the recording. A service that ignores
 * `verbose_json` and returns no segments gives the plain transcript.
 *
 * @param {{ cfg: Object, pcm: Buffer, sampleRate?: number, signal?: AbortSignal,
 *   annotate?: boolean }} params
 *   `annotate`: the transcript is meant to be read (a stored chat turn), not
 *   typed or spoken (dictation, voice mode).
 * @returns {Promise<{ text: string }>}
 */
export async function transcribe({ cfg, pcm, sampleRate = 16000, signal, annotate = false } = {}) {
  if (!cfg?.url) throw new Error('the model has no endpoint URL');
  if (!pcm?.length) return { text: '' };
  const configured = Number(cfg.options?.maxChunkSeconds);
  const maxChunkSeconds = Number.isFinite(configured)
    ? Math.min(MAX_CHUNK_SECONDS, Math.max(MIN_CHUNK_SECONDS, configured))
    : DEFAULT_MAX_CHUNK_SECONDS;
  const { timestamps, speakerLabel } = annotationsOf(cfg.options, annotate);

  const texts = [];
  const units = [];
  let offset = 0;
  for (const part of splitPcm(pcm, { sampleRate, maxChunkSeconds })) {
    const result = await transcribePart({
      cfg,
      wav: pcm16ToWav(part, { sampleRate }),
      signal,
      verbose: timestamps
    });
    if (result.text) texts.push(result.text);
    for (const segment of result.segments) {
      units.push({
        text: segment.text,
        start: segment.start === null ? null : segment.start + offset,
        end: segment.end === null ? null : segment.end + offset
      });
    }
    offset += part.length / (sampleRate * 2);
  }
  if (timestamps && units.length) {
    return { text: formatTranscript(units, { timestamps: true, speakerLabel }) };
  }
  if (timestamps && texts.length) {
    logger.warn(
      'Whisper transcription: timestamps asked for, but the service returned no segments',
      {
        component: 'OpenAITranscribe',
        model: cfg.model
      }
    );
  }
  return { text: texts.join(' ') };
}

export default {
  id: 'openai-transcribe',
  mode: 'batch',
  resolveUpstream,
  transcribe
};
