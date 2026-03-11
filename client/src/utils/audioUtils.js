/**
 * Shared audio capture utilities for in-browser STT adapters.
 * All three engines (Whisper, Parakeet, Moonshine) need 16kHz mono Float32Array PCM.
 */

/**
 * Starts capturing audio from microphone.
 * @param {function} onChunk - Called with each Float32Array PCM chunk
 * @returns {Promise<{stream, audioContext, processor}>}
 */
export async function captureAudioStream(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but universally supported
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = event => {
    const channelData = event.inputBuffer.getChannelData(0);
    onChunk(new Float32Array(channelData));
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return { stream, audioContext, processor, source, sampleRate: audioContext.sampleRate };
}

/**
 * Stops audio capture and frees resources.
 * @param {{stream, audioContext, processor, source}} capture - Object from captureAudioStream
 */
export function stopAudioCapture({ stream, audioContext, processor, source }) {
  try {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach(track => track.stop());
    if (audioContext.state !== 'closed') {
      audioContext.close();
    }
  } catch (_e) {
    // Ignore cleanup errors
  }
}

/**
 * Resamples a Float32Array from originalSampleRate to 16kHz.
 * @param {Float32Array} float32Array
 * @param {number} originalSampleRate
 * @returns {Promise<Float32Array>}
 */
export async function resampleTo16kHz(float32Array, originalSampleRate) {
  if (originalSampleRate === 16000) return float32Array;

  const targetSampleRate = 16000;
  const duration = float32Array.length / originalSampleRate;
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(duration * targetSampleRate),
    targetSampleRate
  );

  const buffer = offlineCtx.createBuffer(1, float32Array.length, originalSampleRate);
  buffer.copyToChannel(float32Array, 0);

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start();

  const renderedBuffer = await offlineCtx.startRendering();
  return renderedBuffer.getChannelData(0);
}

/**
 * High-level recorder that accumulates PCM and returns 16kHz Float32Array on stop.
 * @returns {{ start: function, stop: function }}
 */
export function createRecorder() {
  const chunks = [];
  let captureHandle = null;
  let capturedSampleRate = 16000;

  return {
    async start() {
      chunks.length = 0;
      captureHandle = await captureAudioStream(chunk => chunks.push(chunk));
      capturedSampleRate = captureHandle.sampleRate;
    },

    async stop() {
      if (!captureHandle) return new Float32Array(0);

      stopAudioCapture(captureHandle);
      captureHandle = null;

      // Concatenate all chunks
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      return resampleTo16kHz(combined, capturedSampleRate);
    }
  };
}
