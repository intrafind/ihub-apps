// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { TARGET_SAMPLE_RATE } from './audioUtils';

/**
 * Microphone to PCM frames on an AudioContext the caller owns.
 *
 * The voice session creates its AudioContext inside the user's click (iOS
 * Safari refuses to start one anywhere else) and shares it between this capture
 * and the voice activity detector, so unlike `createPcmCapturePipeline`
 * (`realtimeTranscriptionCore.js`) this one never creates or closes a context.
 * Frames are about 32 ms long, the grain the voice activity detector works in,
 * so audio gating follows speech closely.
 */

/** Length of one captured frame. */
export const CAPTURE_FRAME_MS = 32;

const PROCESSOR_NAME = 'ihub-voice-capture';

// Inline AudioWorklet (Blob URL, no separate asset): collects `frameSize`
// samples, then posts a copy to the main thread.
const WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._size = (options.processorOptions && options.processorOptions.frameSize) || 512;
    this._buf = new Float32Array(this._size);
    this._i = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let n = 0; n < ch.length; n++) {
        this._buf[this._i++] = ch[n];
        if (this._i >= this._size) {
          this.port.postMessage(this._buf.slice(0, this._size));
          this._i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', VoiceCaptureProcessor);
`;

/**
 * Samples per frame at `sampleRate`: about `CAPTURE_FRAME_MS`, a multiple of the
 * 128-sample render quantum.
 */
export function captureFrameSize(sampleRate = TARGET_SAMPLE_RATE) {
  const quanta = Math.max(1, Math.round((sampleRate * (CAPTURE_FRAME_MS / 1000)) / 128));
  return quanta * 128;
}

// ScriptProcessor only accepts these buffer sizes.
const SCRIPT_BUFFER_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384];

/** The smallest buffer size ScriptProcessor accepts that holds a whole frame. */
export function scriptBufferSize(sampleRate = TARGET_SAMPLE_RATE) {
  const frame = captureFrameSize(sampleRate);
  return SCRIPT_BUFFER_SIZES.find(size => size >= frame) || 16384;
}

/**
 * @param {Object} options
 * @param {AudioContext} options.audioContext
 * @param {MediaStream} options.stream
 * @param {(frame: Float32Array, sampleRate: number) => void} options.onFrame -
 *   The receiver owns the frame.
 * @returns {Promise<{ sampleRate: number, stop: () => void }>}
 */
export async function createCapture({ audioContext, stream, onFrame }) {
  const sampleRate = audioContext.sampleRate;
  const source = audioContext.createMediaStreamSource(stream);
  let workletNode = null;
  let scriptNode = null;

  if (audioContext.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const moduleUrl = URL.createObjectURL(blob);
      try {
        await audioContext.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      workletNode = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
        processorOptions: { frameSize: captureFrameSize(sampleRate) }
      });
      workletNode.port.onmessage = evt => onFrame(evt.data, sampleRate);
      source.connect(workletNode);
      // The worklet needs a sink for the graph to keep pulling audio.
      workletNode.connect(audioContext.destination);
    } catch (err) {
      console.warn('Voice capture: AudioWorklet unavailable, using ScriptProcessor:', err);
      workletNode = null;
    }
  }

  if (!workletNode) {
    scriptNode = audioContext.createScriptProcessor(scriptBufferSize(sampleRate), 1, 1);
    scriptNode.onaudioprocess = e =>
      onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), sampleRate);
    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
  }

  const stop = () => {
    try {
      if (workletNode) {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      }
      if (scriptNode) {
        scriptNode.onaudioprocess = null;
        scriptNode.disconnect();
      }
      source.disconnect();
    } catch {
      /* already disconnected */
    }
  };

  return { sampleRate, stop };
}
