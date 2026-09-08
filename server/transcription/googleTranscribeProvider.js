/**
 * Google Gemini batch transcription provider (`gemini-3.5-transcribe`).
 *
 * The unary counterpart to `googleLiveProvider`: one request per recording
 * instead of a streaming session. Gemini's batch transcription accepts up to an
 * hour of audio (the Live API caps a session at 10 minutes), so this is the
 * provider for long recordings and uploaded files.
 *
 * Unlike the streaming providers it has no wire protocol for the bridge to
 * drive. It declares `mode: 'batch'` and exposes a single `transcribe()` call;
 * the bridge buffers the PCM the browser streams, then hands the whole buffer
 * over on `stop`. The browser-facing protocol is unchanged, so no client change
 * is needed — a batch model behaves like a streaming one that emits its
 * transcript in a single `final`.
 *
 * Request flow (three hops, because the interactions API takes a file URI
 * rather than inline bytes):
 *   1. resumable upload of a WAV wrapper around the PCM  → Files API
 *   2. POST /v1beta/interactions with that file URI      → transcript
 *   3. DELETE the uploaded file                          → best-effort cleanup
 *
 * Uploaded audio lands in Google's Files API store (48 h retention) before it
 * is transcribed. That is a data-flow an operator has to accept deliberately,
 * which is why the shipped model config is disabled by default.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/transcribe
 *       https://ai.google.dev/gemini-api/docs/files
 */
import logger from '../utils/logger.js';
import { expandEnvVars, resolveApiKey } from './credentials.js';

/** Default API host. Overridable per model via `url`. */
export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com';

/** Per-HTTP-request timeout. The transcription hop is the slow one. */
const UPLOAD_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 300_000;
const POLL_TIMEOUT_MS = 30_000;

/** Bounded polling for asynchronous file processing / interaction completion. */
const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_MS = 300_000;

/**
 * Normalize a configured base URL: strip a trailing slash and a trailing
 * `/v1beta`, so both `https://host` and `https://host/v1beta` work.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeApiBase(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return DEFAULT_API_BASE;
  return trimmed.replace(/\/+$/, '').replace(/\/v1beta$/, '');
}

/**
 * Wrap raw little-endian PCM16 samples in a minimal RIFF/WAVE container.
 * The Files API needs a self-describing audio file; the browser streams bare
 * PCM, so the 44-byte header is added here rather than client-side.
 *
 * @param {Buffer} pcm - Raw PCM16 little-endian samples.
 * @param {{ sampleRate?: number, channels?: number }} [opts]
 * @returns {Buffer} A complete WAV file.
 */
export function pcm16ToWav(pcm, { sampleRate = 16000, channels = 1 } = {}) {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Build the `transcription_config` for one request from the model config.
 *
 * Defaults to Gemini's `smart` mode (punctuation, capitalization, filler-word
 * removal), which reads best in a chat bubble. Speaker diarization and
 * word-level timestamps are deliberately not exposed: iHub renders a plain
 * transcript with nowhere to show them, and Gemini rejects them in combination
 * with `smart` mode and with custom vocabulary.
 *
 * @param {Object} [config] - `model.config` contents.
 * @returns {Object} transcription_config payload.
 */
export function buildTranscriptionConfig(config = {}) {
  const out = {};
  out.mode = config.mode === 'verbatim' ? { type: 'verbatim' } : 'smart';
  if (Array.isArray(config.languageCodes)) {
    const codes = config.languageCodes.filter(code => typeof code === 'string' && code);
    if (codes.length) out.language_codes = codes;
  }
  if (Array.isArray(config.customVocabulary)) {
    const phrases = config.customVocabulary
      .filter(phrase => typeof phrase === 'string' && phrase)
      .slice(0, 1000); // Gemini's documented cap
    if (phrases.length) out.custom_vocabulary = phrases;
  }
  return out;
}

/**
 * Collect the transcript from an interactions response. Text lives in
 * `steps[].content[]` blocks of `type: 'text'`; annotations (word timings,
 * speaker labels) are ignored here.
 *
 * @param {Object} body - Parsed interactions response.
 * @returns {string} The concatenated transcript, trimmed.
 */
export function extractTranscript(body = {}) {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const parts = [];
  for (const step of steps) {
    const content = Array.isArray(step?.content) ? step.content : [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * True when an interaction is still running and should be polled.
 *
 * @param {string} [status]
 * @returns {boolean}
 */
export function isPendingStatus(status) {
  return status === 'in_progress' || status === 'queued' || status === 'pending';
}

/**
 * @param {Object} model
 * @returns {{ url: string, apiKey: string, model: string, options: Object }}
 */
export function resolveUpstream(model) {
  return {
    url: normalizeApiBase(expandEnvVars(model?.url || '')),
    apiKey: resolveApiKey(model, { credentialProvider: 'google', envVars: ['GOOGLE_API_KEY'] }),
    model: model?.modelId || '',
    options: model?.config || {}
  };
}

/**
 * Raise a provider error whose message is safe to show a user: it names the
 * HTTP status and Gemini's own message, never the request URL (which carries no
 * key here, but the pattern keeps upstream hosts out of the browser).
 *
 * @param {string} step - Which hop failed, for the log.
 * @param {Response} res
 * @returns {Promise<Error>}
 */
async function upstreamError(step, res) {
  let detail = '';
  try {
    const body = await res.text();
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || body.slice(0, 200);
  } catch {
    /* non-JSON or unreadable body */
  }
  const err = new Error(
    `Gemini transcription ${step} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`
  );
  err.status = res.status;
  return err;
}

/** Wait, but abort promptly when the caller's signal fires. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Transcription cancelled'));
      },
      { once: true }
    );
  });
}

/**
 * Upload audio bytes through the Files API resumable protocol and return the
 * created file's `{ name, uri, mimeType }`.
 */
async function uploadFile({ base, apiKey, bytes, mimeType, displayName, signal }) {
  const startRes = await fetch(`${base}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal: signal || AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  });
  if (!startRes.ok) throw await upstreamError('upload start', startRes);

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini transcription upload did not return an upload URL');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: bytes,
    signal: signal || AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  });
  if (!uploadRes.ok) throw await upstreamError('upload', uploadRes);

  const body = await uploadRes.json();
  const file = body?.file || body;
  if (!file?.uri) throw new Error('Gemini transcription upload did not return a file URI');
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType, state: file.state };
}

/** Poll a just-uploaded file until it leaves the PROCESSING state. */
async function awaitFileActive({ base, apiKey, file, signal }) {
  if (!file.state || file.state === 'ACTIVE') return;
  const deadline = Date.now() + MAX_POLL_MS;
  let state = file.state;
  while (state === 'PROCESSING' && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    const res = await fetch(`${base}/v1beta/${file.name}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: signal || AbortSignal.timeout(POLL_TIMEOUT_MS)
    });
    if (!res.ok) throw await upstreamError('file status', res);
    const body = await res.json();
    state = body?.state || body?.file?.state;
  }
  if (state === 'FAILED') throw new Error('Gemini could not process the uploaded audio');
  if (state === 'PROCESSING') throw new Error('Gemini file processing timed out');
}

/** Best-effort cleanup so audio does not sit in the Files API for 48 hours. */
async function deleteFile({ base, apiKey, name }) {
  if (!name) return;
  try {
    await fetch(`${base}/v1beta/${name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
    });
  } catch (err) {
    logger.warn('Gemini transcription: failed to delete uploaded audio', {
      component: 'GoogleTranscribe',
      error: err.message
    });
  }
}

/** Poll an interaction that came back still running. */
async function awaitInteraction({ base, apiKey, body, signal }) {
  let current = body;
  const deadline = Date.now() + MAX_POLL_MS;
  while (isPendingStatus(current?.status) && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    const res = await fetch(`${base}/v1beta/${current.id}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: signal || AbortSignal.timeout(POLL_TIMEOUT_MS)
    });
    if (!res.ok) throw await upstreamError('interaction status', res);
    current = await res.json();
  }
  if (isPendingStatus(current?.status)) throw new Error('Gemini transcription timed out');
  return current;
}

/**
 * Transcribe a complete PCM16 buffer.
 *
 * @param {{ cfg: Object, pcm: Buffer, sampleRate?: number, signal?: AbortSignal }} params
 * @returns {Promise<{ text: string }>}
 */
export async function transcribe({ cfg, pcm, sampleRate = 16000, signal } = {}) {
  if (!cfg?.apiKey) {
    throw new Error('Gemini transcription requires an API key (set GOOGLE_API_KEY)');
  }
  if (!pcm?.length) return { text: '' };

  const base = normalizeApiBase(cfg.url);
  const apiKey = cfg.apiKey;
  const wav = pcm16ToWav(pcm, { sampleRate });
  let file;
  try {
    file = await uploadFile({
      base,
      apiKey,
      bytes: wav,
      mimeType: 'audio/wav',
      displayName: `ihub-transcription-${Date.now()}.wav`,
      signal
    });
    await awaitFileActive({ base, apiKey, file, signal });

    const res = await fetch(`${base}/v1beta/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        input: [{ type: 'audio', uri: file.uri, mime_type: file.mimeType }],
        generation_config: { transcription_config: buildTranscriptionConfig(cfg.options) }
      }),
      signal: signal || AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
    });
    if (!res.ok) throw await upstreamError('request', res);

    const completed = await awaitInteraction({ base, apiKey, body: await res.json(), signal });
    return { text: extractTranscript(completed) };
  } finally {
    await deleteFile({ base, apiKey, name: file?.name });
  }
}

export default {
  id: 'google-transcribe',
  mode: 'batch',
  resolveUpstream,
  transcribe
};
