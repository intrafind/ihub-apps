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

function createAudioContext() {
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) throw new Error('Audio playback is not supported in this browser');
  return new Ctx();
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
   */
  constructor({ onStateChange } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.state = 'idle';
    this.context = createAudioContext();
    // A context created in a gesture may still start suspended (Safari).
    this.context.resume?.().catch(() => {});
    this.controller = new AbortController();
    this.sampleRate = DEFAULT_SAMPLE_RATE;
    this.sources = new Set();
    this.nextStartTime = 0;
    this.streamDone = false;
    this.streamError = null;
    this.scheduledAny = false;
    this.pausedByUser = false;
    // Received bytes not yet scheduled.
    this.queue = [];
    this.queuedBytes = 0;
    // Everything received, so a finished stream replays without a request.
    this.recording = [];
    this.recordedBytes = 0;
    this.recordingDropped = false;
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
      let body = {};
      try {
        body = await response.json();
      } catch {
        // Not JSON — keep the status alone.
      }
      this.fail(
        new SpeechRequestError(body.error || `HTTP ${response.status}`, {
          status: response.status,
          code: body.code
        })
      );
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
      if (!available || (!this.streamDone && available < minBytes)) break;
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
    if (this.context.state !== 'closed') this.context.close?.().catch(() => {});
  }
}

export default PcmStreamPlayer;
