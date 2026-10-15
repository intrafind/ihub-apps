/**
 * The audio extracted from an uploaded video (issue #2836).
 *
 * It used to be encoded as a WAV of the video's own 48 kHz stereo and kept only
 * as a base64 data URL. For videos beyond ~35 minutes that URL outgrows the
 * engine's maximum string length: `FileReader` hands back an empty string, the
 * attachment looks fine, and sending it fails ("Could not decode this audio").
 * It is now rendered to 16 kHz mono — what transcription streams anyway — and
 * the WAV Blob stays on the attachment.
 */

import '@testing-library/jest-dom';
import { render, fireEvent, waitFor } from '@testing-library/react';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue || key)
  })
}));

const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const {
  extractAudioFromVideo
} = require('../../../client/src/features/upload/utils/fileProcessing');

const SOURCE_RATE = 48000;
const SOURCE_CHANNELS = 2;
const SECONDS = 2;

const fakeAudioBuffer = (sampleRate, channels, seconds) => {
  const length = Math.round(sampleRate * seconds);
  const data = Array.from({ length: channels }, () => new Float32Array(length).fill(0.25));
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    duration: seconds,
    getChannelData: index => data[index]
  };
};

let contexts;
let offlineContexts;
let decodeFails;

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    contexts.push(this);
  }

  async decodeAudioData() {
    if (decodeFails) throw new Error('EncodingError');
    return fakeAudioBuffer(SOURCE_RATE, SOURCE_CHANNELS, SECONDS);
  }

  async close() {
    this.state = 'closed';
  }
}

// Renders what it is asked to: a buffer of the requested shape.
class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.shape = { channels, length, sampleRate };
    this.destination = {};
    offlineContexts.push(this.shape);
  }

  createBufferSource() {
    return { connect: () => {}, start: () => {} };
  }

  async startRendering() {
    const { channels, length, sampleRate } = this.shape;
    return fakeAudioBuffer(sampleRate, channels, length / sampleRate);
  }
}

const video = (name = 'standup.webm') => {
  const file = new File(['not really a video'], name, { type: 'video/webm' });
  // jsdom's File predates Blob.arrayBuffer().
  file.arrayBuffer = async () => new ArrayBuffer(8);
  return file;
};

const readBytes = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });

beforeEach(() => {
  contexts = [];
  offlineContexts = [];
  decodeFails = false;
  window.AudioContext = FakeAudioContext;
  window.OfflineAudioContext = FakeOfflineAudioContext;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete window.AudioContext;
  delete window.OfflineAudioContext;
});

describe('extractAudioFromVideo', () => {
  test('renders the soundtrack to 16 kHz mono before encoding it', async () => {
    const result = await extractAudioFromVideo(video());

    // One mono, 16 kHz render of the whole soundtrack.
    expect(offlineContexts).toEqual([{ channels: 1, length: SECONDS * 16000, sampleRate: 16000 }]);
    // The metadata describes the output, not the decoded source.
    expect(result).toMatchObject({
      format: 'audio/wav',
      sampleRate: 16000,
      channels: 1,
      duration: SECONDS,
      size: 44 + SECONDS * 16000 * 2
    });
    expect(result.blob.size).toBe(result.size);
    expect(result.base64).toMatch(/^data:audio\/wav;base64,/);
  });

  test('writes a mono 16 kHz PCM16 WAV', async () => {
    const { blob } = await extractAudioFromVideo(video());

    const view = new DataView(await readBytes(blob));
    const text = (offset, length) =>
      String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(SECONDS * 16000 * 2);
    // 0.25 full scale survived the encoding.
    expect(view.getInt16(44, true)).toBe(Math.trunc(0.25 * 0x7fff));
  });

  test('is far smaller than a WAV of the original stereo audio', async () => {
    const { size } = await extractAudioFromVideo(video());

    const originalWavSize = 44 + SECONDS * SOURCE_RATE * SOURCE_CHANNELS * 2;
    expect(originalWavSize / size).toBeGreaterThan(5.9);
  });

  test('closes the AudioContext it opened', async () => {
    await extractAudioFromVideo(video());
    expect(contexts).toHaveLength(1);
    expect(contexts[0].state).toBe('closed');
  });

  test('an undecodable soundtrack is reported as audio-decode-error', async () => {
    decodeFails = true;
    await expect(extractAudioFromVideo(video())).rejects.toThrow('audio-decode-error');
    expect(contexts[0].state).toBe('closed');
  });

  test('a data URL the engine cannot hold fails the extraction instead of attaching empty audio', async () => {
    // What FileReader does beyond the maximum string length: an empty result,
    // no error.
    jest.spyOn(window, 'FileReader').mockImplementation(function EmptyReader() {
      this.readAsDataURL = () => {
        this.result = '';
        setTimeout(() => this.onload());
      };
    });

    await expect(extractAudioFromVideo(video())).rejects.toThrow('video-audio-extraction-error');
    expect(contexts[0].state).toBe('closed');
  });
});

describe('a video upload', () => {
  function renderUploader() {
    const onFileSelect = jest.fn();
    const utils = render(
      <UnifiedUploader
        onFileSelect={onFileSelect}
        config={{
          imageUploadEnabled: false,
          audioUploadEnabled: false,
          fileUploadEnabled: false,
          videoUpload: {
            enabled: true,
            extractAudio: true,
            supportedFormats: ['video/webm'],
            maxFileSizeMB: 10
          }
        }}
      >
        <div />
      </UnifiedUploader>
    );
    const input = utils.container.querySelector('input[type="file"]');
    return { onFileSelect, upload: file => fireEvent.change(input, { target: { files: [file] } }) };
  }

  test('attaches the 16 kHz mono WAV and keeps its Blob for transcription', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(video('standup.webm'));

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    expect(data).toMatchObject({
      type: 'audio',
      fileName: 'standup.wav',
      fileType: 'audio/wav',
      extractedFromVideo: true,
      originalVideoName: 'standup.webm',
      duration: SECONDS,
      sampleRate: 16000,
      channels: 1,
      fileSize: 44 + SECONDS * 16000 * 2
    });
    expect(data.blob).toBeInstanceOf(Blob);
    expect(data.blob.size).toBe(data.fileSize);
  });

  test('the Blob never reaches anything that serializes or copies the attachment', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(video());

    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const data = onFileSelect.mock.calls[0][0];
    // Chat history, sessionStorage and the request body are JSON: a Blob would
    // become a bogus `{}`.
    expect(Object.keys(data)).not.toContain('blob');
    expect(JSON.parse(JSON.stringify(data))).not.toHaveProperty('blob');
    expect({ ...data }).not.toHaveProperty('blob');
    // ...while it stays readable on the attachment itself.
    expect(data.blob).toBeInstanceOf(Blob);
  });
});
