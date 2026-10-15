/**
 * The audio extracted from an uploaded video (issue #2836).
 *
 * It used to be encoded as a WAV of the video's own 48 kHz stereo and kept only
 * as a base64 data URL. For videos beyond ~35 minutes that URL outgrows the
 * engine's maximum string length: `FileReader` hands back an empty string, the
 * attachment looks fine, and sending it fails ("Could not decode this audio").
 * It is now rendered to 16 kHz mono — what transcription streams anyway — and
 * the WAV Blob stays on the attachment.
 *
 * Extracting takes seconds to minutes for a long video (issue #2835), so it
 * reports its progress, never holds the page, and can be stopped.
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
let sources;
let decodeFails;
// What decoding yields: the length of the video's audio, and a way to hold it up
let decodedSeconds;
let decodeNever;
// Whether the engine can run a context at the rate asked for, and suspend an
// offline render
let refuseSampleRate;
let offlineCanSuspend;

class FakeAudioContext {
  constructor(options) {
    if (options && refuseSampleRate) throw new Error('NotSupportedError');
    this.options = options;
    this.state = 'running';
    this.decodeCalls = 0;
    contexts.push(this);
  }

  async decodeAudioData() {
    this.decodeCalls++;
    if (decodeNever) return new Promise(() => {});
    if (decodeFails) throw new Error('EncodingError');
    return fakeAudioBuffer(SOURCE_RATE, SOURCE_CHANNELS, decodedSeconds);
  }

  async close() {
    this.state = 'closed';
  }
}

// Renders what it is asked to: a buffer of the requested shape. Where it can
// suspend, each suspension waits for resume() like the real one.
class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.shape = { channels, length, sampleRate };
    this.destination = {};
    this.suspensions = [];
    offlineContexts.push(this.shape);
    if (offlineCanSuspend) {
      this.suspend = time => new Promise(resolve => this.suspensions.push({ time, resolve }));
      this.resume = async () => this.resumeRender?.();
    }
  }

  createBufferSource() {
    const source = { connect: () => {}, start: () => {}, disconnect: jest.fn() };
    sources.push(source);
    return source;
  }

  async startRendering() {
    const { channels, length, sampleRate } = this.shape;
    const ordered = [...this.suspensions].sort((a, b) => a.time - b.time);
    for (const { resolve } of ordered) {
      await new Promise(resumed => {
        this.resumeRender = resumed;
        resolve();
      });
    }
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
  sources = [];
  decodeFails = false;
  decodedSeconds = SECONDS;
  decodeNever = false;
  refuseSampleRate = false;
  offlineCanSuspend = false;
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
    // no error. (Reading the video itself works.)
    jest.spyOn(window, 'FileReader').mockImplementation(function EmptyReader() {
      this.readAsArrayBuffer = () => {
        this.result = new ArrayBuffer(8);
        setTimeout(() => this.onload());
      };
      this.readAsDataURL = () => {
        this.result = '';
        setTimeout(() => this.onload());
      };
    });

    await expect(extractAudioFromVideo(video())).rejects.toThrow('video-audio-extraction-error');
    expect(contexts[0].state).toBe('closed');
  });
});

describe('extractAudioFromVideo decoding context', () => {
  test('decodes in a context at 16 kHz, which keeps the decoded track small', async () => {
    await extractAudioFromVideo(video());
    expect(contexts).toHaveLength(1);
    expect(contexts[0].options).toEqual({ sampleRate: 16000 });
  });

  test('decodes in a default context where 16 kHz is refused', async () => {
    refuseSampleRate = true;

    const result = await extractAudioFromVideo(video());

    expect(contexts).toHaveLength(1);
    expect(contexts[0].options).toBeUndefined();
    // The render to 16 kHz mono does the rest
    expect(result).toMatchObject({ sampleRate: 16000, channels: 1 });
  });
});

describe('extractAudioFromVideo progress', () => {
  const collect = async (options = {}) => {
    const events = [];
    const result = await extractAudioFromVideo(video(), {
      ...options,
      onProgress: event => events.push(event)
    });
    return { events, result };
  };
  const numbers = events => events.map(e => e.percent).filter(percent => percent !== null);

  test('walks the stages read, decode, resample, encode and finalize, in that order', async () => {
    const { events } = await collect();

    const stages = [...new Set(events.map(e => e.stage))];
    expect(stages).toEqual(['read', 'decode', 'resample', 'encode', 'finalize']);
    // Never back to an earlier stage
    const order = events.map(e => stages.indexOf(e.stage));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('starts at 0, ends at 100 and never goes down', async () => {
    const { events } = await collect();

    expect(events[0]).toEqual({ stage: 'read', percent: 0 });
    expect(events[events.length - 1]).toEqual({ stage: 'finalize', percent: 100 });
    const percents = numbers(events);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    for (const percent of percents) {
      expect(Number.isInteger(percent)).toBe(true);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
  });

  test('decode has no percent: decoding cannot say how far it is', async () => {
    const { events } = await collect();
    expect(events.filter(e => e.stage === 'decode')).toEqual([{ stage: 'decode', percent: null }]);
  });

  test('reports the same state only once', async () => {
    const { events } = await collect();
    const keys = events.map(e => `${e.stage}:${e.percent}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('resample has no percent where the browser cannot suspend an offline render', async () => {
    const { events } = await collect();
    expect(events.filter(e => e.stage === 'resample')).toEqual([
      { stage: 'resample', percent: null }
    ]);
  });

  test('resample reports how far the render is where the browser can suspend it', async () => {
    offlineCanSuspend = true;

    const { events, result } = await collect();

    const resample = events.filter(e => e.stage === 'resample');
    expect(resample[0]).toEqual({ stage: 'resample', percent: null });
    const percents = numbers(resample);
    // Several checkpoints within the stage's share of the bar (50-70)
    expect(percents.length).toBeGreaterThan(5);
    expect(Math.min(...percents)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...percents)).toBeLessThanOrEqual(70);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    // The suspended render still produced the whole file
    expect(result.duration).toBe(SECONDS);
  });

  test('encode reports its slices as the encoder writes them', async () => {
    // 60 s of 16 kHz is two encoder slices
    decodedSeconds = 60;

    const { events } = await collect();

    const encode = events.filter(e => e.stage === 'encode').map(e => e.percent);
    expect(encode.length).toBeGreaterThan(2);
    expect(Math.min(...encode)).toBeGreaterThanOrEqual(70);
    expect(Math.max(...encode)).toBeLessThanOrEqual(90);
  });

  test('works without anyone listening', async () => {
    await expect(extractAudioFromVideo(video())).resolves.toMatchObject({ format: 'audio/wav' });
    await expect(extractAudioFromVideo(video(), {})).resolves.toMatchObject({
      format: 'audio/wav'
    });
  });
});

describe('extractAudioFromVideo stopping', () => {
  const abortedError = { message: 'aborted', code: 'aborted' };

  test('rejects with the abort error, not a video-audio-extraction-error', async () => {
    const controller = new AbortController();
    controller.abort();

    const extraction = extractAudioFromVideo(video(), { signal: controller.signal });

    await expect(extraction).rejects.toMatchObject(abortedError);
    await expect(extraction).rejects.not.toThrow('video-audio-extraction-error');
  });

  test('does not even open an AudioContext when it is stopped before it starts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(extractAudioFromVideo(video(), { signal: controller.signal })).rejects.toThrow(
      'aborted'
    );
    expect(contexts).toHaveLength(0);
  });

  test('stops reading the video', async () => {
    const controller = new AbortController();

    const extraction = extractAudioFromVideo(video(), { signal: controller.signal });
    controller.abort();

    await expect(extraction).rejects.toMatchObject(abortedError);
    expect(contexts[0].decodeCalls).toBe(0);
    expect(contexts[0].state).toBe('closed');
  });

  test('stops while decoding, which cannot be cancelled: the result is dropped', async () => {
    decodeNever = true;
    const controller = new AbortController();
    const extraction = extractAudioFromVideo(video(), {
      signal: controller.signal,
      onProgress: ({ stage }) => {
        if (stage === 'decode') setTimeout(() => controller.abort());
      }
    });

    await expect(extraction).rejects.toMatchObject(abortedError);
    expect(contexts[0].decodeCalls).toBe(1);
    expect(contexts[0].state).toBe('closed');
    expect(offlineContexts).toHaveLength(0);
  });

  test('stops while resampling and lets go of the source of the render', async () => {
    offlineCanSuspend = true;
    const controller = new AbortController();
    const extraction = extractAudioFromVideo(video(), {
      signal: controller.signal,
      onProgress: ({ stage, percent }) => {
        if (stage === 'resample' && percent !== null && percent >= 55) controller.abort();
      }
    });

    await expect(extraction).rejects.toMatchObject(abortedError);
    expect(contexts[0].state).toBe('closed');

    // At its next checkpoint the render drops its source and runs on as silence
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sources[0].disconnect).toHaveBeenCalled();
  });

  test('stops between the slices of the encoder', async () => {
    decodedSeconds = 120; // four slices
    const controller = new AbortController();
    const encodeReports = [];
    const extraction = extractAudioFromVideo(video(), {
      signal: controller.signal,
      onProgress: ({ stage, percent }) => {
        if (stage !== 'encode') return;
        encodeReports.push(percent);
        // The first slice is written: stop
        if (encodeReports.length === 2) controller.abort();
      }
    });

    await expect(extraction).rejects.toMatchObject(abortedError);
    // 0 at the start, then one slice; no more after the stop
    expect(encodeReports).toHaveLength(2);
    expect(contexts[0].state).toBe('closed');
  });

  test('stops while the data URL is made', async () => {
    const controller = new AbortController();
    const extraction = extractAudioFromVideo(video(), {
      signal: controller.signal,
      onProgress: ({ stage }) => {
        if (stage === 'finalize') controller.abort();
      }
    });

    await expect(extraction).rejects.toMatchObject(abortedError);
    expect(contexts[0].state).toBe('closed');
  });

  test('is not logged as an error', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(extractAudioFromVideo(video(), { signal: controller.signal })).rejects.toThrow();

    expect(console.error).not.toHaveBeenCalled();
  });

  test('a stopped extraction does not stop the next one', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractAudioFromVideo(video(), { signal: controller.signal })
    ).rejects.toMatchObject(abortedError);

    await expect(extractAudioFromVideo(video())).resolves.toMatchObject({ format: 'audio/wav' });
  });

  test('a failure that is not a stop still maps to its own error', async () => {
    decodeFails = true;
    const controller = new AbortController();

    await expect(extractAudioFromVideo(video(), { signal: controller.signal })).rejects.toThrow(
      'audio-decode-error'
    );
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
