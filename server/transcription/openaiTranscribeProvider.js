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
 * `maxChunkSeconds`.
 */
import { providerEnvKeyName } from '../../shared/llmProviders.js';
import { expandEnvVars, resolveApiKey } from './credentials.js';
import { pcm16ToWav } from './wav.js';

/** Used when an `openai` model sets no URL. */
export const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

const TRANSCRIBE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CHUNK_SECONDS = 600;
const MIN_CHUNK_SECONDS = 30;
const MAX_CHUNK_SECONDS = 1500;
/** How far back from a part's end the quietest moment is looked for. */
const QUIET_SEARCH_SECONDS = 10;
const QUIET_WINDOW_MS = 50;

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
 * Split PCM16 into parts of at most `maxChunkSeconds`, each ending at the
 * quietest 50 ms of its last ten seconds, so a cut falls between words.
 *
 * @param {Buffer} pcm
 * @param {{ sampleRate?: number, maxChunkSeconds?: number }} [opts]
 * @returns {Buffer[]}
 */
export function splitPcm(
  pcm,
  { sampleRate = 16000, maxChunkSeconds = DEFAULT_MAX_CHUNK_SECONDS } = {}
) {
  const bytesPerSecond = sampleRate * 2;
  const maxBytes = Math.max(2, Math.floor((maxChunkSeconds * bytesPerSecond) / 2) * 2);
  if (pcm.length <= maxBytes) return [pcm];

  const windowBytes = Math.max(2, Math.floor((sampleRate * QUIET_WINDOW_MS) / 1000) * 2);
  const searchBytes = Math.floor((QUIET_SEARCH_SECONDS * bytesPerSecond) / 2) * 2;
  const parts = [];
  let start = 0;
  while (pcm.length - start > maxBytes) {
    const limit = start + maxBytes;
    const from = Math.max(start + windowBytes, limit - searchBytes);
    let cut = limit;
    let quietest = Infinity;
    for (let w = limit - windowBytes; w >= from; w -= windowBytes) {
      let energy = 0;
      for (let i = w; i < w + windowBytes; i += 2) {
        const v = pcm.readInt16LE(i);
        energy += v * v;
      }
      if (energy < quietest) {
        quietest = energy;
        cut = w + Math.floor(windowBytes / 4) * 2;
      }
    }
    parts.push(pcm.subarray(start, cut));
    start = cut;
  }
  parts.push(pcm.subarray(start));
  return parts;
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

async function transcribePart({ cfg, wav, signal }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (cfg.options?.language) form.append('language', String(cfg.options.language));
  if (cfg.options?.prompt) form.append('prompt', String(cfg.options.prompt));

  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers,
    body: form,
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
    const body = await res.json();
    return typeof body?.text === 'string' ? body.text.trim() : '';
  }
  return (await res.text()).trim();
}

/**
 * Transcribe a complete PCM16 buffer, in parts when it is long.
 *
 * @param {{ cfg: Object, pcm: Buffer, sampleRate?: number, signal?: AbortSignal }} params
 * @returns {Promise<{ text: string }>}
 */
export async function transcribe({ cfg, pcm, sampleRate = 16000, signal } = {}) {
  if (!cfg?.url) throw new Error('the model has no endpoint URL');
  if (!pcm?.length) return { text: '' };
  const configured = Number(cfg.options?.maxChunkSeconds);
  const maxChunkSeconds = Number.isFinite(configured)
    ? Math.min(MAX_CHUNK_SECONDS, Math.max(MIN_CHUNK_SECONDS, configured))
    : DEFAULT_MAX_CHUNK_SECONDS;

  const texts = [];
  for (const part of splitPcm(pcm, { sampleRate, maxChunkSeconds })) {
    const text = await transcribePart({ cfg, wav: pcm16ToWav(part, { sampleRate }), signal });
    if (text) texts.push(text);
  }
  return { text: texts.join(' ') };
}

export default {
  id: 'openai-transcribe',
  mode: 'batch',
  resolveUpstream,
  transcribe
};
