/**
 * Audio extraction utilities using Web Audio API
 * Extracts audio from video files in the browser
 */

/**
 * Extract audio from a video file using Web Audio API
 * @param {File} file - The video file to extract audio from
 * @returns {Promise<{base64: string, duration: number, sampleRate: number, numberOfChannels: number}>}
 */
export const extractAudioFromVideo = async file => {
  try {
    // Create audio context
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();

    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // Decode the video file to get the raw audio data
    // This uses the browser's native codec to extract audio from the video container
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Use an OfflineAudioContext to "render" the audio to a new buffer
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate
    );

    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();

    // Render the audio
    const renderedBuffer = await offlineContext.startRendering();

    // Convert to WAV format
    const wavBlob = audioBufferToWav(renderedBuffer);
    const base64 = await blobToBase64(wavBlob);

    // Calculate duration in seconds
    const duration = renderedBuffer.duration;

    return {
      base64,
      duration,
      sampleRate: renderedBuffer.sampleRate,
      numberOfChannels: renderedBuffer.numberOfChannels,
      fileSize: wavBlob.size,
      mimeType: 'audio/wav'
    };
  } catch (error) {
    console.error('Error extracting audio from video:', error);
    throw new Error('audio-extraction-error');
  }
};

/**
 * Convert AudioBuffer to WAV blob
 * @param {AudioBuffer} audioBuffer - The audio buffer to convert
 * @returns {Blob} WAV audio blob
 */
const audioBufferToWav = audioBuffer => {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;

  const data = [];
  for (let i = 0; i < numberOfChannels; i++) {
    data.push(audioBuffer.getChannelData(i));
  }

  const interleaved = interleave(data);
  const dataLength = interleaved.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // Write WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true); // audio format (PCM)
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write audio data
  const volume = 0.8;
  let index = 44;
  for (let i = 0; i < interleaved.length; i++) {
    const sample = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(index, sample < 0 ? sample * 0x8000 : sample * 0x7fff * volume, true);
    index += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * Interleave multiple audio channels
 * @param {Float32Array[]} channels - Array of audio channel data
 * @returns {Float32Array} Interleaved audio data
 */
const interleave = channels => {
  const length = channels[0].length;
  const numberOfChannels = channels.length;
  const result = new Float32Array(length * numberOfChannels);

  let inputIndex = 0;
  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      result[inputIndex++] = channels[channel][i];
    }
  }

  return result;
};

/**
 * Write string to DataView
 * @param {DataView} view - DataView to write to
 * @param {number} offset - Offset to write at
 * @param {string} string - String to write
 */
const writeString = (view, offset, string) => {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
};

/**
 * Convert Blob to base64 data URL
 * @param {Blob} blob - Blob to convert
 * @returns {Promise<string>} Base64 data URL
 */
const blobToBase64 = blob => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * Check if video file likely contains audio
 * This is a heuristic check based on file extension
 * @param {File} file - Video file to check
 * @returns {boolean} True if video likely has audio
 */
export const videoLikelyHasAudio = file => {
  // Most common video formats with audio
  const formatsWithAudio = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg'];
  return formatsWithAudio.includes(file.type);
};
