/**
 * Plays a streamed PCM response as it arrives (read aloud).
 *
 * `/api/voice/speech` answers with raw 16-bit signed little-endian mono PCM
 * over a chunked response (`X-Audio-Sample-Rate` gives the rate). The bytes are
 * queued as they arrive and turned into `AudioBuffer`s a little ahead of the
 * playhead, each scheduled on one `AudioContext` right after the previous one —
 * playback starts with the first bytes and continues gap-free while the rest
 * streams in. Only `SCHEDULE_AHEAD_SECONDS` are ever decoded ahead, so a long
 * answer costs its 16-bit bytes in memory, not minutes of float32 buffers.
 *
 * Pause and resume suspend the context (the stream keeps buffering meanwhile);
 * stop aborts the request, which aborts the provider request on the server.
 *
 * Works the same in every browser with Web Audio and streaming `fetch`, and
 * needs no media container: the server can switch providers without the
 * player noticing.
 *
 * Multi-stream mode (voice mode): one player plays several fetched streams
 * back to back. `enqueueStream()` takes one request per piece of an answer;
 * the requests run concurrently, but their audio is scheduled strictly in the
 * order they were enqueued, gap-free, whichever response arrives first. A
 * failed stream is skipped without ending the player, and `finish()` says that
 * no more streams follow. The audio context can be passed in and is then left
 * open, so one context serves a whole voice session.
 */

const DEFAULT_SAMPLE_RATE = 24000;
/** Smallest piece worth its own AudioBuffer while more audio is on the way. */
const MIN_BUFFER_SECONDS = 0.2;
/** Largest single AudioBuffer. */
const MAX_BUFFER_SECONDS = 2;
/** How far ahead of the playhead audio is decoded and scheduled. */
const SCHEDULE_AHEAD_SECONDS = 15;
/** Head start for a buffer scheduled on an idle playhead. */
const START_LEAD_SECONDS = 0.05;
/** Longest stream kept for an instant replay (16-bit bytes ≈ 29 MB at 24 kHz). */
const MAX_RECORDING_SECONDS = 600;

/** Little-endian int16 bytes → float32 samples in [-1, 1). */
export function pcm16ToFloat32(bytes) {
  const samples = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** An HTTP error from the speech endpoint, with the server's message. */
export class SpeechRequestError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'SpeechRequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A new `AudioContext`. Call it from a click handler: browsers only let a user
 * gesture start audio. Throws where Web Audio is missing.
 */
export function createAudioContext() {
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) throw new Error('Audio playback is not supported in this browser');
  return new Ctx();
}

/** The error for a response that is not `ok`: the server's own message when it sent one. */
async function responseError(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Not JSON — keep the status alone.
  }
  return new SpeechRequestError(body.error || `HTTP ${response.status}`, {
    status: response.status,
    code: body.code
  });
}

/**
 * One playback. Create it and call `start()` from the click handler: browsers
 * only let a user gesture start audio, and the context is created there.
 *
 * States: `loading` (waiting for the first audio) → `playing` ⇄ `paused` →
 * `ended` | `error` | `stopped`.
 */
export class PcmStreamPlayer {
  /**
   * @param {Object} [opts]
   * @param {(state: string, info?: Object) => void} [opts.onStateChange]
   * @param {AudioContext} [opts.context] - Play on this context instead of
   *   creating one. The player never closes a context it was given.
   * @param {boolean} [opts.multiStream] - Play several streams back to back
   *   (`enqueueStream` + `finish`) instead of one (`start`).
   */
  constructor({ onStateChange, context, multiStream = false } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.state = 'idle';
    this.ownsContext = !context;
    this.context = context || createAudioContext();
    // A context created in a gesture may still start suspended (Safari).
    if (this.ownsContext) this.context.resume?.().catch(() => {});
    this.controller = new AbortController();
    this.sampleRate = DEFAULT_SAMPLE_RATE;
    this.sources = new Set();
    this.nextStartTime = 0;
    this.streamDone = false;
    this.streamError = null;
    this.scheduledAny = false;
    this.pausedByUser = false;
    // Received bytes not yet scheduled. The request keeps streaming while
    // playback is paused, so this can hold the rest of the answer: at most
    // `speech.tts.maxCharacters` of speech (20,000 characters ≈ 20 minutes ≈
    // 60 MB of 16-bit audio), shared with `recording` rather than copied.
    this.queue = [];
    this.queuedBytes = 0;
    // Everything received, so a finished stream replays without a request.
    this.recording = [];
    this.recordedBytes = 0;
    // A multi-stream player plays and forgets: no recording for a replay.
    this.recordingDropped = multiStream;
    this.multiStream = multiStream;
    // Multi-stream: the streams enqueued and not yet fully handed to the queue,
    // in play order; `streams[0]` is the one feeding the queue.
    this.streams = [];
    this.finishing = false;
    this.rateLocked = false;
  }

  setState(state, info) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange(state, info);
  }

  isFinal() {
    return ['ended', 'error', 'stopped'].includes(this.state);
  }

  /**
   * Fetch and play. Resolves once the stream has been fully received (playback
   * may still be going on). Request and stream failures become the `error`
   * state rather than a rejection.
   *
   * @param {(signal: AbortSignal) => Promise<Response>} request
   */
  async start(request) {
    this.setState('loading');
    let response;
    try {
      response = await request(this.controller.signal);
    } catch (error) {
      if (!this.controller.signal.aborted) this.fail(error);
      return;
    }
    if (this.isFinal()) return;
    if (!response.ok) {
      this.fail(await responseError(response));
      return;
    }
    if (!response.body?.getReader) {
      this.fail(new Error('Streaming audio is not supported in this browser'));
      return;
    }

    this.sampleRate =
      Number.parseInt(response.headers.get('X-Audio-Sample-Rate'), 10) || DEFAULT_SAMPLE_RATE;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.isFinal()) return;
        this.enqueue(value);
      }
    } catch (error) {
      if (this.controller.signal.aborted || this.isFinal()) return;
      // Interrupted mid-stream: play what arrived, then report it.
      this.streamError = error;
    }
    this.streamDone = true;
    this.pump();
  }

  /**
   * Play a recording of a finished stream again, without a request.
   *
   * @param {{ sampleRate: number, chunks: Uint8Array[] }} recording
   */
  replay(recording) {
    this.sampleRate = recording.sampleRate;
    this.setState('loading');
    for (const chunk of recording.chunks) this.enqueue(chunk);
    this.streamDone = true;
    this.pump();
  }

  /**
   * Multi-stream mode: fetch one more stream and play it after the ones
   * enqueued before it. Requests may run concurrently; the audio is scheduled
   * in enqueue order, so a stream whose response arrives early waits for its
   * turn. A stream that fails is skipped (what arrived of it still plays) and
   * the player carries on: the outcome is the promise's value, never a
   * rejection or a player `error` state.
   *
   * @param {(signal: AbortSignal) => Promise<Response>} request - Called at once.
   *   Its signal aborts with `stop()`, so every request in flight is cancelled.
   * @param {Object} [opts]
   * @param {(response: Response) => void} [opts.onResponse] - Called with an
   *   `ok` response before its body is read, so the caller can read its headers
   *   (for speech: `X-Speech-Language`).
   * @returns {Promise<{ status: 'ok' | 'error' | 'aborted', error?: Error }>}
   *   Settles once the stream was fully received, failed, or was cancelled.
   */
  enqueueStream(request, { onResponse } = {}) {
    if (!this.multiStream) {
      return Promise.reject(new Error('enqueueStream needs a multi-stream player'));
    }
    if (this.isFinal() || this.finishing) return Promise.resolve({ status: 'aborted' });
    const stream = { pending: [], total: 0, done: false };
    this.streams.push(stream);
    if (this.state === 'idle') this.setState('loading');
    return this.runStream(stream, request, onResponse);
  }

  /** Multi-stream mode: no more streams follow; the player ends once all audio has played. */
  finish() {
    if (!this.multiStream || this.isFinal()) return;
    this.finishing = true;
    this.pump();
  }

  async runStream(stream, request, onResponse) {
    const aborted = () => this.controller.signal.aborted || this.isFinal();
    let response;
    try {
      response = await request(this.controller.signal);
    } catch (error) {
      return aborted() ? this.abortStream(stream) : this.settleStream(stream, error);
    }
    if (aborted()) return this.abortStream(stream);
    if (!response.ok) {
      const error = await responseError(response);
      return aborted() ? this.abortStream(stream) : this.settleStream(stream, error);
    }
    if (!response.body?.getReader) {
      return this.settleStream(
        stream,
        new Error('Streaming audio is not supported in this browser')
      );
    }
    // One sample rate for the whole player: the queue holds plain bytes.
    const rate =
      Number.parseInt(response.headers.get('X-Audio-Sample-Rate'), 10) || DEFAULT_SAMPLE_RATE;
    if (this.rateLocked && rate !== this.sampleRate) {
      return this.settleStream(stream, new Error('The sample rate changed between streams'));
    }
    this.sampleRate = rate;
    this.rateLocked = true;
    try {
      onResponse?.(response);
    } catch {
      // The caller's problem; the audio still plays.
    }

    const reader = response.body.getReader();
    let streamError = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted()) return this.abortStream(stream);
        this.feed(stream, value);
      }
    } catch (error) {
      if (aborted()) return this.abortStream(stream);
      // Interrupted mid-stream: play what arrived, then report it.
      streamError = error;
    }
    return this.settleStream(stream, streamError);
  }

  /** Bytes of a stream: straight into the queue when it is the one playing, else held back. */
  feed(stream, bytes) {
    if (!bytes?.byteLength) return;
    stream.total += bytes.byteLength;
    if (stream === this.streams[0]) this.enqueue(bytes);
    else stream.pending.push(bytes);
  }

  /** A stream is fully received (`error` set when it failed): move on to the next one. */
  settleStream(stream, error = null) {
    stream.done = true;
    this.advance();
    return error ? { status: 'error', error } : { status: 'ok' };
  }

  /** The player was stopped while this stream was in flight. */
  abortStream(stream) {
    stream.done = true;
    return { status: 'aborted' };
  }

  /**
   * Hand over to the next stream once the one playing is fully received: its
   * held-back bytes go into the queue, and so on while that one is complete too.
   */
  advance() {
    while (this.streams.length && this.streams[0].done) {
      const finished = this.streams.shift();
      // A half sample at the end of a stream must not shift the next one by a byte.
      if (finished.total % 2) this.dropTrailingByte();
      const next = this.streams[0];
      if (next) {
        const held = next.pending;
        next.pending = [];
        for (const bytes of held) this.enqueue(bytes);
      }
    }
    this.pump();
  }

  /** Remove the last byte of the queue (the odd one of a stream's end). */
  dropTrailingByte() {
    const last = this.queue.length - 1;
    if (last < 0) return;
    if (this.queue[last].byteLength <= 1) this.queue.pop();
    else this.queue[last] = this.queue[last].subarray(0, -1);
    this.queuedBytes -= 1;
  }

  /**
   * Whether more bytes are on the way that continue what is queued, so a short
   * rest should wait for them. Multi-stream: only while the stream playing has
   * put bytes into the queue — the tail of a stream that is complete plays at
   * once, however long the next one takes to start.
   */
  moreComing() {
    if (!this.multiStream) return !this.streamDone;
    return this.streams.length > 0 && this.streams[0].total > 0;
  }

  enqueue(bytes) {
    if (!bytes?.byteLength) return;
    this.queue.push(bytes);
    this.queuedBytes += bytes.byteLength;
    if (!this.recordingDropped) {
      this.recordedBytes += bytes.byteLength;
      if (this.recordedBytes > MAX_RECORDING_SECONDS * this.sampleRate * 2) {
        this.recordingDropped = true;
        this.recording = [];
      } else {
        this.recording.push(bytes);
      }
    }
    this.pump();
  }

  /** Take up to `maxBytes` (an even count) off the front of the queue. */
  dequeue(maxBytes) {
    const take = Math.min(maxBytes, this.queuedBytes - (this.queuedBytes % 2));
    const out = new Uint8Array(take);
    let offset = 0;
    while (offset < take) {
      const head = this.queue[0];
      const needed = take - offset;
      if (head.byteLength <= needed) {
        out.set(head, offset);
        offset += head.byteLength;
        this.queue.shift();
      } else {
        out.set(head.subarray(0, needed), offset);
        this.queue[0] = head.subarray(needed);
        offset += needed;
      }
    }
    this.queuedBytes -= take;
    return out;
  }

  /** Schedule queued audio until the playhead is far enough ahead. */
  pump() {
    if (this.isFinal()) return;
    const ctx = this.context;
    const minBytes = Math.round(this.sampleRate * MIN_BUFFER_SECONDS) * 2;
    const maxBytes = Math.round(this.sampleRate * MAX_BUFFER_SECONDS) * 2;
    while (this.nextStartTime - ctx.currentTime < SCHEDULE_AHEAD_SECONDS) {
      const available = this.queuedBytes - (this.queuedBytes % 2);
      if (!available || (this.moreComing() && available < minBytes)) break;
      this.schedule(pcm16ToFloat32(this.dequeue(maxBytes)));
    }
    this.maybeFinish();
  }

  schedule(samples) {
    if (!samples.length) return;
    const ctx = this.context;
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(this.nextStartTime, ctx.currentTime + START_LEAD_SECONDS);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
    this.scheduledAny = true;
    source.onended = () => {
      this.sources.delete(source);
      this.pump();
    };
    if (this.state === 'loading') this.setState(this.pausedByUser ? 'paused' : 'playing');
  }

  maybeFinish() {
    if (this.multiStream) {
      if (!this.finishing || this.streams.length || this.queuedBytes > 1) return;
      if (this.sources.size > 0 || this.isFinal()) return;
      // Skipped streams are the caller's to report; the player just ends.
      this.setState('ended');
      this.close();
      return;
    }
    if (!this.streamDone || this.queuedBytes > 1 || this.sources.size > 0 || this.isFinal()) {
      return;
    }
    if (this.streamError) {
      this.fail(this.streamError);
      return;
    }
    if (!this.scheduledAny) {
      this.fail(new Error('No audio was returned'));
      return;
    }
    this.setState('ended');
    this.close();
  }

  /** The bytes of a fully received stream, for a replay; null otherwise. */
  getRecording() {
    if (this.state !== 'ended' || this.streamError || this.recordingDropped) return null;
    return { sampleRate: this.sampleRate, chunks: this.recording, bytes: this.recordedBytes };
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    this.pausedByUser = true;
    this.context.suspend?.().catch(() => {});
    if (this.state === 'playing') this.setState('paused');
  }

  resume() {
    if (!this.pausedByUser || this.isFinal()) return;
    this.pausedByUser = false;
    this.context.resume?.().catch(() => {});
    if (this.state === 'paused') this.setState('playing');
    this.pump();
  }

  stop() {
    if (this.isFinal()) return;
    this.controller.abort();
    this.setState('stopped');
    this.close();
  }

  fail(error) {
    if (this.isFinal()) return;
    this.controller.abort();
    this.setState('error', { error });
    this.close();
  }

  close() {
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    this.queue = [];
    this.queuedBytes = 0;
    this.streams = [];
    if (this.ownsContext && this.context.state !== 'closed') {
      this.context.close?.().catch(() => {});
    }
  }
}

export default PcmStreamPlayer;
