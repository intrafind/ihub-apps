/**
 * Extracting the audio of a video of any size.
 *
 * A browser cannot read a file of more than ~2 GB into one ArrayBuffer, and
 * half an hour of video is 10 GB and more. An MP4 or MOV is therefore read
 * through File.slice(): its index and its audio, nothing else (see
 * mp4AudioExtraction.js). Anything the browser has to decode from the whole
 * file stays below ~1.9 GB.
 *
 * The AudioContext is a fake: what it is handed is what is asserted. Whether
 * the browser decodes the ADTS stream is not testable here (Playwright's
 * Chromium has no AAC decoder).
 */

import '@testing-library/jest-dom';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

const {
  WHOLE_FILE_READ_LIMIT_BYTES,
  extractAudioFromVideo
} = require('../../../client/src/features/upload/utils/fileProcessing');
const { isAbortError } = require('../../../client/src/utils/abortable');
const {
  bytesOf,
  bytesRead,
  fileOf,
  fixture,
  inflate,
  recording,
  withAudioFormat
} = require('../../utils/mp4Fixtures');

// What decoding the ADTS stream of aac44s_faststart.mp4 yields: 131 frames of 1024
const DECODED_SECONDS = (131 * 1024) / 44100;
const ADTS_BYTES = 9540 + 131 * 7;

let contexts;
let offlineContexts;
let sources;
// Which decodeAudioData calls fail, by the number of bytes they are handed
let decodeFailsOn;

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

class FakeAudioContext {
  constructor(options) {
    this.options = options;
    this.state = 'running';
    this.decoded = [];
    this.buffers = [];
    contexts.push(this);
  }

  async decodeAudioData(buffer) {
    this.decoded.push(buffer.byteLength);
    if (decodeFailsOn(buffer.byteLength)) throw new Error('EncodingError');
    return fakeAudioBuffer(16000, 1, DECODED_SECONDS);
  }

  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    const buffer = {
      numberOfChannels: channels,
      sampleRate,
      length,
      duration: length / sampleRate,
      getChannelData: () => data
    };
    this.buffers.push(buffer);
    return buffer;
  }

  async close() {
    this.state = 'closed';
  }
}

class FakeOfflineAudioContext {
  constructor(channels, length, sampleRate) {
    this.shape = { channels, length, sampleRate };
    this.destination = {};
    offlineContexts.push(this.shape);
  }

  createBufferSource() {
    const source = { connect: () => {}, start: () => {}, disconnect: () => {}, buffer: null };
    sources.push(source);
    return source;
  }

  async startRendering() {
    const { channels, length, sampleRate } = this.shape;
    return fakeAudioBuffer(sampleRate, channels, length / sampleRate);
  }
}

beforeEach(() => {
  contexts = [];
  offlineContexts = [];
  sources = [];
  decodeFailsOn = () => false;
  window.AudioContext = FakeAudioContext;
  window.OfflineAudioContext = FakeOfflineAudioContext;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete window.AudioContext;
  delete window.OfflineAudioContext;
});

const GB = 1024 ** 3;

describe('a limit for what is read whole', () => {
  test('is below 2 GB, where a browser stops being able to read a file into memory', () => {
    expect(WHOLE_FILE_READ_LIMIT_BYTES).toBeLessThan(2 * GB);
    expect(WHOLE_FILE_READ_LIMIT_BYTES).toBeGreaterThan(1.8 * GB);
  });
});

describe('extractAudioFromVideo: MP4 and MOV are read in parts', () => {
  test('AAC: the browser decodes the audio as ADTS, not the whole file', async () => {
    const file = recording(fixture('aac44s_faststart.mp4', 'video/mp4'));

    const result = await extractAudioFromVideo(file);

    expect(contexts[0].decoded).toEqual([ADTS_BYTES]);
    expect(ADTS_BYTES).toBeLessThan(file.size);
    // Never asked for the whole file in one go
    expect(file.reads.some(([start, end]) => start === 0 && end >= file.size)).toBe(false);
    expect(result).toMatchObject({
      format: 'audio/wav',
      sampleRate: 16000,
      channels: 1
    });
    expect(result.duration).toBeCloseTo(DECODED_SECONDS, 3);
    expect(result.base64).toMatch(/^data:audio\/wav;base64,/);
    expect(result.blob.size).toBe(result.size);
    expect(contexts[0].state).toBe('closed');
  });

  test('PCM: no decoder at all, the samples go straight to the resample', async () => {
    const result = await extractAudioFromVideo(fixture('pcm44s.mov', 'video/quicktime'));

    expect(contexts[0].decoded).toEqual([]);
    // The mono mix at the source rate, in a buffer of the context
    expect(contexts[0].buffers).toHaveLength(1);
    expect(contexts[0].buffers[0]).toMatchObject({
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 13230
    });
    // ... which is what the offline render turned into 16 kHz
    expect(sources[0].buffer).toBe(contexts[0].buffers[0]);
    expect(offlineContexts).toEqual([{ channels: 1, length: 4800, sampleRate: 16000 }]);
    expect(result).toMatchObject({ sampleRate: 16000, channels: 1 });
    expect(result.duration).toBeCloseTo(0.3, 5);
    expect(contexts[0].state).toBe('closed');
  });

  test('a file the browser reports no type for is still known by its first box', async () => {
    const result = await extractAudioFromVideo(fixture('aac48m_moovend.mov', ''));
    expect(contexts[0].decoded).toEqual([9642 + 142 * 7]);
    expect(result.format).toBe('audio/wav');
  });

  test('reports read, decode, resample, encode, finalize, never going back or down', async () => {
    const events = [];
    await extractAudioFromVideo(fixture('aac44s_faststart.mp4', 'video/mp4'), {
      onProgress: event => events.push(event)
    });

    const stages = [...new Set(events.map(event => event.stage))];
    expect(stages).toEqual(['read', 'decode', 'resample', 'encode', 'finalize']);
    expect(events[0]).toEqual({ stage: 'read', percent: 0 });
    expect(events[events.length - 1]).toEqual({ stage: 'finalize', percent: 100 });
    const order = events.map(event => stages.indexOf(event.stage));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const percents = events.map(event => event.percent).filter(percent => percent !== null);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    // The read stage ends where the decode stage begins
    expect(events.find(event => event.stage === 'decode')).toEqual({
      stage: 'decode',
      percent: null
    });
  });

  test('PCM has nothing to decode: that stage is done once the audio is read', async () => {
    const events = [];
    await extractAudioFromVideo(fixture('pcm48m.mov', 'video/quicktime'), {
      onProgress: event => events.push(event)
    });

    expect(events.filter(event => event.stage === 'decode')).toEqual([
      { stage: 'decode', percent: 50 }
    ]);
    const percents = events.map(event => event.percent).filter(percent => percent !== null);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(events[events.length - 1]).toEqual({ stage: 'finalize', percent: 100 });
  });

  test('stopping while it reads rejects with the abort error and closes the context', async () => {
    const controller = new AbortController();
    const file = recording(fixture('pcm44s.mov', 'video/quicktime'), count => {
      if (count === 4) controller.abort();
    });

    const error = await extractAudioFromVideo(file, { signal: controller.signal }).catch(e => e);

    expect(isAbortError(error)).toBe(true);
    expect(error.code).toBe('aborted');
    expect(contexts[0].state).toBe('closed');
    expect(contexts[0].decoded).toEqual([]);
  });
});

describe('extractAudioFromVideo: where the whole file takes over', () => {
  test('a small MP4 whose audio cannot be read in parts is decoded as it always was', async () => {
    const bytes = withAudioFormat(bytesOf('aac44s_faststart.mp4'), 'ac-3');
    const file = fileOf(bytes, 'odd.mp4', 'video/mp4');
    file.arrayBuffer = async () => bytes.buffer;

    const result = await extractAudioFromVideo(file);

    // The browser was handed the file, not an ADTS stream
    expect(contexts[0].decoded).toEqual([bytes.length]);
    expect(result.format).toBe('audio/wav');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('reading the file in parts'),
      expect.objectContaining({ code: 'mp4-unsupported-codec' })
    );
  });

  test('so is one the browser cannot decode as ADTS', async () => {
    const bytes = bytesOf('aac44s_faststart.mp4');
    decodeFailsOn = length => length === ADTS_BYTES;

    const result = await extractAudioFromVideo(fileOf(bytes, 'a.mp4', 'video/mp4'));

    expect(contexts[0].decoded).toEqual([ADTS_BYTES, bytes.length]);
    expect(result.format).toBe('audio/wav');
  });

  test('where that fails too it is an audio-decode-error, as before', async () => {
    decodeFailsOn = () => true;

    await expect(
      extractAudioFromVideo(fixture('aac44s_faststart.mp4', 'video/mp4'))
    ).rejects.toThrow('audio-decode-error');
    expect(contexts[0].state).toBe('closed');
  });

  test('a file that is not an MP4 is read whole and decoded, as before', async () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]); // EBML: WebM
    const file = fileOf(bytes, 'clip.webm', 'video/webm');

    const result = await extractAudioFromVideo(file);

    expect(contexts[0].decoded).toEqual([64]);
    expect(result.format).toBe('audio/wav');
  });
});

describe('extractAudioFromVideo: a 3 GB MOV', () => {
  const hugeMov = (name = 'aac48m_moovend.mov', bytes = bytesOf(name)) => inflate(bytes, 3 * GB);

  test('AAC: found behind the mdat, only the index and the audio are read', async () => {
    const file = hugeMov();
    expect(file.size).toBeGreaterThan(WHOLE_FILE_READ_LIMIT_BYTES);

    const result = await extractAudioFromVideo(file);

    expect(contexts[0].decoded).toEqual([9642 + 142 * 7]);
    expect(bytesRead(file)).toBeLessThan(64 * 1024);
    expect(file.gapBytes).toBeLessThan(4096);
    expect(result.format).toBe('audio/wav');
    expect(contexts[0].state).toBe('closed');
  });

  test('PCM: likewise, and it is the whole audio that arrives', async () => {
    const file = inflate(bytesOf('pcm44s.mov'), 3 * GB);

    const result = await extractAudioFromVideo(file);

    expect(contexts[0].buffers[0]).toMatchObject({ sampleRate: 44100, length: 13230 });
    expect(result.duration).toBeCloseTo(0.3, 5);
    expect(bytesRead(file)).toBeLessThan(bytesOf('pcm44s.mov').length + 4096);
  });

  test('a codec that cannot be read in parts fails clearly: there is nothing to fall back on', async () => {
    const file = inflate(withAudioFormat(bytesOf('aac48m_moovend.mov'), 'ac-3'), 3 * GB);

    await expect(extractAudioFromVideo(file)).rejects.toThrow('video-large-audio-unsupported');

    expect(contexts[0].decoded).toEqual([]);
    expect(contexts[0].state).toBe('closed');
    // The attempt did not read the picture either
    expect(file.gapBytes).toBeLessThan(4096);
  });

  test('so does a video whose browser cannot decode the AAC', async () => {
    decodeFailsOn = () => true;

    await expect(extractAudioFromVideo(hugeMov())).rejects.toThrow('video-large-audio-unsupported');
  });

  test('a damaged index fails the same way', async () => {
    const bytes = bytesOf('aac48m_moovend.mov');
    const file = inflate(bytes, 3 * GB);
    const slice = file.slice.bind(file);
    // The moov is the last box; make what it is read as unreadable
    file.slice = (start, end) =>
      start >= 3 * GB ? new Blob([new Uint8Array(end - start)]) : slice(start, end);

    await expect(extractAudioFromVideo(file)).rejects.toThrow('video-large-audio-unsupported');
  });
});

describe('extractAudioFromVideo: other containers above 2 GB', () => {
  const hugeWebm = () => {
    const header = new Uint8Array(64);
    header.set([0x1a, 0x45, 0xdf, 0xa3]);
    const reads = [];
    return {
      name: 'long.webm',
      type: 'video/webm',
      size: 3 * GB,
      reads,
      slice: (start, end) => {
        reads.push([start, end]);
        return new Blob([header.subarray(start, end)]);
      }
    };
  };

  test('are refused without reading them: only MP4 and MOV can be that large', async () => {
    const file = hugeWebm();

    await expect(extractAudioFromVideo(file)).rejects.toThrow('video-unsupported-large-container');

    // Only the few bytes that tell what it is
    expect(file.reads.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThanOrEqual(12);
    expect(contexts[0].decoded).toEqual([]);
    expect(contexts[0].state).toBe('closed');
  });

  test('an MP4 the browser reports as something else is still an MP4', async () => {
    // type 'video/x-matroska' on a file that starts with ftyp: trusted by its first box
    const bytes = bytesOf('aac44s_faststart.mp4');
    const result = await extractAudioFromVideo(fileOf(bytes, 'clip.mkv', 'video/x-matroska'));
    expect(contexts[0].decoded).toEqual([ADTS_BYTES]);
    expect(result.format).toBe('audio/wav');
  });
});

describe('mp4box.js', () => {
  test('is loaded for AAC in an MP4, not for other videos or for PCM', async () => {
    let loads = 0;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('mp4box', () => {
        loads++;
        return jest.requireActual('mp4box');
      });
      jest.doMock('../../../client/src/api/endpoints/config', () => ({
        fetchMimetypesConfig: jest.fn(async () => {
          throw new Error('offline');
        })
      }));
      const {
        extractAudioFromVideo: extract
      } = require('../../../client/src/features/upload/utils/fileProcessing');
      expect(loads).toBe(0);

      const webm = new Uint8Array(64);
      webm.set([0x1a, 0x45, 0xdf, 0xa3]);
      await extract(fileOf(webm, 'clip.webm', 'video/webm'));
      expect(loads).toBe(0);

      await extract(fixture('pcm48m.mov', 'video/quicktime'));
      expect(loads).toBe(0);

      await extract(fixture('aac44s_faststart.mp4', 'video/mp4'));
      expect(loads).toBe(1);
    });
  });
});
