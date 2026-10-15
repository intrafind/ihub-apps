/**
 * The audio of an MP4/MOV/M4A of any size, read with File.slice(): a video of
 * half an hour is 10 GB and more, and a browser reads at most ~2 GB of a file
 * into memory.
 *
 * The fixtures in tests/fixtures/media are a few seconds long, made with ffmpeg:
 *
 *   V="-f lavfi -i color=c=black:s=64x48:r=5:d=3"
 *   A2="aevalsrc='0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t)':s=44100"
 *   ffmpeg $V -f lavfi -i "$A2:d=3" -c:v libx264 -preset veryfast -crf 40 -pix_fmt yuv420p \
 *     -c:a aac -b:a 24k -movflags +faststart -shortest aac44s_faststart.mp4
 *   ffmpeg $V -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=3" -c:v libx264 \
 *     -preset veryfast -crf 40 -pix_fmt yuv420p -c:a aac -b:a 24k -ac 1 -shortest aac48m_moovend.mov
 *   ffmpeg -f lavfi -i "$A2:d=0.3" -c:a pcm_s16le pcm44s.mov
 *   ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=0.3" -c:a pcm_s16le -ac 1 pcm48m.mov
 *   for c in pcm_u8 pcm_s8 pcm_s16be pcm_s24le pcm_s24be pcm_s32le pcm_f32le pcm_f64be; do
 *     ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t)':s=8000:d=0.1" \
 *       -ac 2 -c:a $c pcm8k_${c#pcm_}.mov
 *   done
 *   ffmpeg -f lavfi -i color=c=black:s=64x48:r=5:d=2 -c:v libx264 -preset veryfast -crf 40 \
 *     -pix_fmt yuv420p -an -movflags +faststart video_only.mp4
 *   ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=44100:d=1" -c:a aac -b:a 24k -ac 1 \
 *     -movflags +frag_keyframe+empty_moov+default_base_moof aac_fragmented.mp4
 *
 * The AAC ones have the video track, so the audio has to be found among others;
 * `aac48m_moovend.mov` has its `moov` after the `mdat`, as QuickTime and most
 * cameras write it. Where the sizes of packets are asserted, they are what
 * `ffprobe -show_packets` reports.
 *
 * What a 3 GB video does is tested by `inflate` (tests/utils/mp4Fixtures.js):
 * the `mdat` of a fixture is declared 3 GB larger (a 64-bit box size), with the
 * rest of the file after it. The "file" has no bytes there, and any read that
 * reaches into them fails.
 */

import {
  MAX_READ_BYTES,
  Mp4AudioError,
  convertPcmToMono,
  describePcm,
  isMp4Container,
  parseAudioSpecificConfig,
  planReads,
  readMp4Audio,
  splitIntoFrames,
  writeAdtsHeader
} from '../../../client/src/features/upload/utils/mp4AudioExtraction';
import { isAbortError } from '../../../client/src/utils/abortable';
import {
  buildPcmMov,
  bytesOf,
  bytesRead,
  fileOf,
  fixture,
  inflate,
  lpcmEntry,
  parseAdts,
  readAll,
  recording,
  topLevelBoxes,
  withAudioFormat
} from '../../utils/mp4Fixtures';

describe('isMp4Container', () => {
  test('knows MP4, QuickTime and M4A by their type', async () => {
    for (const type of ['video/mp4', 'video/quicktime', 'video/x-m4v', 'audio/mp4']) {
      expect(await isMp4Container(fileOf(new Uint8Array(4), 'x', type))).toBe(true);
    }
  });

  test('knows them by the first box where the browser reports no type', async () => {
    expect(await isMp4Container(fixture('aac44s_faststart.mp4', ''))).toBe(true);
    expect(await isMp4Container(fixture('aac48m_moovend.mov', ''))).toBe(true);
  });

  test('does not take WebM or an unreadable stub for MP4', async () => {
    const ebml = new Uint8Array(64);
    ebml.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await isMp4Container(fileOf(ebml, 'a.webm', 'video/webm'))).toBe(false);
    expect(await isMp4Container(fileOf(ebml, 'a.mp4', ''))).toBe(false);
    expect(await isMp4Container(fileOf(new Uint8Array(4), 'tiny', ''))).toBe(false);
  });
});

describe('readMp4Audio: AAC', () => {
  test('moov first: the frames of the audio track in ADTS, the video track left alone', async () => {
    const result = await readMp4Audio(fixture('aac44s_faststart.mp4', 'video/mp4'));

    expect(result).toMatchObject({
      kind: 'aac',
      codec: 'mp4a.40.2',
      sampleRate: 44100,
      channels: 2
    });
    expect(result.blob.type).toBe('audio/aac');
    expect(result.duration).toBeCloseTo(3.04, 1);

    // ffprobe: 131 packets of 9540 bytes, the first at 3116 (93 bytes), the last at 12814 (7)
    const bytes = await readAll(result.blob);
    expect(bytes.length).toBe(9540 + 131 * 7);
    const frames = parseAdts(bytes);
    expect(frames).toHaveLength(131);
    for (const frame of frames) {
      expect(frame).toMatchObject({
        mpeg2: false,
        hasCrc: false,
        profile: 1, // AAC-LC
        samplingIndex: 4, // 44100
        channels: 2,
        fullness: 0x7ff,
        blocks: 0
      });
    }
    const original = bytesOf('aac44s_faststart.mp4');
    expect(frames[0].payload).toEqual(original.subarray(3116, 3116 + 93));
    expect(frames[130].payload).toEqual(original.subarray(12814, 12814 + 7));
    expect(frames.reduce((sum, frame) => sum + frame.payload.length, 0)).toBe(9540);
  });

  test('moov last (QuickTime): mono at 48 kHz, found behind the mdat', async () => {
    const result = await readMp4Audio(fixture('aac48m_moovend.mov', 'video/quicktime'));

    expect(result).toMatchObject({ kind: 'aac', sampleRate: 48000, channels: 1 });
    // ffprobe: 142 packets of 9642 bytes, the first at 770 (116 bytes), the last at 10528 (49)
    const bytes = await readAll(result.blob);
    expect(bytes.length).toBe(9642 + 142 * 7);
    const frames = parseAdts(bytes);
    expect(frames).toHaveLength(142);
    expect(frames[0]).toMatchObject({ profile: 1, samplingIndex: 3, channels: 1 });
    const original = bytesOf('aac48m_moovend.mov');
    expect(frames[0].payload).toEqual(original.subarray(770, 770 + 116));
    expect(frames[141].payload).toEqual(original.subarray(10528, 10528 + 49));
  });

  test('reads the index and the audio, not the picture', async () => {
    const file = recording(fixture('aac44s_faststart.mp4', 'video/mp4'));
    await readMp4Audio(file);

    const boxes = topLevelBoxes(bytesOf('aac44s_faststart.mp4'));
    const moov = boxes.find(box => box.type === 'moov');
    // Box headers, the moov, the ftyp, the audio
    for (const [start, end] of file.reads) {
      const insideMoov = start >= moov.start && end <= moov.start + moov.size;
      const header = end - start <= 16;
      const ftyp = start === 0 && end <= 64;
      const audio = start >= 3116 && end <= 12814 + 7;
      expect(insideMoov || header || ftyp || audio).toBe(true);
    }
    // The video track's samples are between the audio's chunks: skipped, not read
    expect(bytesRead(file)).toBeLessThan(bytesOf('aac44s_faststart.mp4').length);
  });

  test('a 3 GB mdat is hopped over: the index and the audio are all that is read', async () => {
    const gap = 3 * 1024 ** 3;
    const file = inflate(bytesOf('aac48m_moovend.mov'), gap);
    expect(file.size).toBeGreaterThan(3 * 1024 ** 3);

    const result = await readMp4Audio(file);

    const bytes = await readAll(result.blob);
    expect(parseAdts(bytes)).toHaveLength(142);
    expect(bytes.length).toBe(9642 + 142 * 7);

    expect(bytesRead(file)).toBeLessThan(64 * 1024);
    expect(Math.max(...file.reads.map(([start, end]) => end - start))).toBeLessThanOrEqual(
      MAX_READ_BYTES
    );
    // No read went into the gap (the one allowed byte range is where the audio ends and the gap begins)
    expect(file.gapBytes).toBeLessThan(4096);
    // The moov was read where it is: after the gap
    expect(file.reads.some(([start]) => start >= gap)).toBe(true);
  });

  test('a read never exceeds the limit it is given, and the audio is still whole', async () => {
    const file = recording(fixture('aac44s_faststart.mp4', 'video/mp4'));
    const result = await readMp4Audio(file, { maxReadBytes: 2048 });

    expect(file.reads.length).toBeGreaterThan(3);
    for (const [start, end] of file.reads) expect(end - start).toBeLessThanOrEqual(2048);
    const bytes = await readAll(result.blob);
    expect(parseAdts(bytes)).toHaveLength(131);
    expect(bytes.length).toBe(9540 + 131 * 7);
  });

  test('HE-AAC: the AAC-LC core in ADTS, with the core sample rate', () => {
    // Explicit hierarchical signalling: SBR, core 22.05 kHz stereo, output 44.1 kHz, LC
    expect(parseAudioSpecificConfig(new Uint8Array([0x2b, 0x92, 0x08, 0x00]))).toEqual({
      objectType: 2,
      sampleRate: 22050,
      channelConfig: 2,
      sbr: true,
      outputSampleRate: 44100
    });
    // Backward compatible signalling: a plain LC config at the core rate
    expect(parseAudioSpecificConfig(new Uint8Array([0x13, 0x90]))).toEqual({
      objectType: 2,
      sampleRate: 22050,
      channelConfig: 2,
      sbr: false,
      outputSampleRate: 22050
    });
  });

  test('AudioSpecificConfig: LC at 44.1 kHz stereo and an explicitly written rate', () => {
    expect(parseAudioSpecificConfig(new Uint8Array([0x12, 0x10]))).toMatchObject({
      objectType: 2,
      sampleRate: 44100,
      channelConfig: 2
    });
    // sampling frequency index 15: 24 bits of rate follow (44100 = 0x00AC44)
    const explicit = parseAudioSpecificConfig(new Uint8Array([0x17, 0x80, 0x56, 0x22, 0x10]));
    expect(explicit).toMatchObject({ objectType: 2, sampleRate: 44100, channelConfig: 2 });
    expect(() => parseAudioSpecificConfig(new Uint8Array([0x12]))).toThrow(Mp4AudioError);
  });

  test('ADTS header: profile, rate, channels and frame length in the right bits', () => {
    const header = writeAdtsHeader(
      new Uint8Array(7),
      0,
      { objectType: 2, samplingIndex: 3, channelConfig: 6 },
      1500
    );
    // 0xFFF1, LC (01) 48 kHz (0011) channels 6 (110), length 1507
    expect(Array.from(header).map(byte => byte.toString(16))).toEqual([
      'ff',
      'f1',
      '4d',
      '80',
      'bc',
      '7f',
      'fc'
    ]);
    const [frame] = parseAdts(new Uint8Array([...header, ...new Uint8Array(1500)]));
    expect(frame).toMatchObject({ profile: 1, samplingIndex: 3, channels: 6, length: 1507 });
  });
});

describe('readMp4Audio: PCM', () => {
  // What aevalsrc wrote, as the mean of the channels
  const left = t => 0.5 * Math.sin(2 * Math.PI * 440 * t);
  const right = t => 0.25 * Math.sin(2 * Math.PI * 660 * t);

  test('stereo 16-bit little endian (sowt) at 44.1 kHz comes out as the mono mix', async () => {
    const result = await readMp4Audio(fixture('pcm44s.mov', 'video/quicktime'));

    expect(result).toMatchObject({
      kind: 'pcm',
      codec: 'sowt',
      sampleRate: 44100,
      channels: 2
    });
    expect(result.duration).toBeCloseTo(0.3, 5);
    const samples = result.buffer.getChannelData(0);
    expect(result.buffer).toMatchObject({ numberOfChannels: 1, sampleRate: 44100 });
    expect(samples.length).toBe(13230);
    for (const n of [0, 1, 100, 5000, 13229]) {
      expect(samples[n]).toBeCloseTo((left(n / 44100) + right(n / 44100)) / 2, 3);
    }
    // Not silence, and nowhere beyond full scale
    expect(Math.max(...samples)).toBeGreaterThan(0.3);
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  test('mono 16-bit at 48 kHz is copied as it is', async () => {
    const result = await readMp4Audio(fixture('pcm48m.mov', 'video/quicktime'));

    expect(result).toMatchObject({ kind: 'pcm', sampleRate: 48000, channels: 1 });
    const samples = result.buffer.getChannelData(0);
    expect(samples.length).toBe(14400);
    for (const n of [0, 7, 1000, 14399]) {
      expect(samples[n]).toBeCloseTo(left(n / 48000), 3);
    }
  });

  test('is written to the buffer the caller provides', async () => {
    const created = [];
    const createPcmBuffer = (length, sampleRate) => {
      const data = new Float32Array(length);
      created.push({ length, sampleRate, data });
      return { getChannelData: () => data };
    };
    await readMp4Audio(fixture('pcm44s.mov', 'video/quicktime'), { createPcmBuffer });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ length: 13230, sampleRate: 44100 });
    expect(created[0].data[5000]).toBeCloseTo((left(5000 / 44100) + right(5000 / 44100)) / 2, 3);
  });

  test('reads it in several steps where the limit is small, without losing a frame', async () => {
    const file = recording(fixture('pcm44s.mov', 'video/quicktime'));
    const result = await readMp4Audio(file, { maxReadBytes: 5000 });

    expect(file.reads.length).toBeGreaterThan(8);
    const samples = result.buffer.getChannelData(0);
    expect(samples.length).toBe(13230);
    for (const n of [0, 1249, 1250, 1251, 9999, 13229]) {
      expect(samples[n]).toBeCloseTo((left(n / 44100) + right(n / 44100)) / 2, 3);
    }
  });

  test('a 3 GB mdat around the audio is hopped over just the same', async () => {
    const file = inflate(bytesOf('pcm44s.mov'), 3 * 1024 ** 3);
    const result = await readMp4Audio(file);

    expect(result.buffer.getChannelData(0).length).toBe(13230);
    expect(bytesRead(file)).toBeLessThan(bytesOf('pcm44s.mov').length + 4096);
    expect(file.gapBytes).toBeLessThan(4096);
  });

  test('describes the layout of the fixtures', () => {
    expect(describePcm(new Uint8Array(0), { format: 'xyz', sound: null })).toBeNull();
    const layout = describePcm(new Uint8Array(0), {
      format: 'sowt',
      sound: { channels: 2, sampleRate: 44100, sampleSize: 16, version: 1 }
    });
    expect(layout).toMatchObject({
      kind: 'int16le',
      channels: 2,
      sampleRate: 44100,
      frameBytes: 4
    });
  });
});

describe('readMp4Audio: the PCM flavours of QuickTime', () => {
  // What aevalsrc wrote at 8 kHz, as the mean of the two channels
  const mix = n => {
    const t = n / 8000;
    return (0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t)) / 2;
  };

  // [fixture, sample entry, tolerance: half a step of the sample format, plus a little]
  test.each([
    ['pcm8k_u8.mov', 'raw ', 0.01],
    ['pcm8k_s8.mov', 'sowt, 8 bit', 0.01],
    ['pcm8k_s16be.mov', 'twos', 1e-4],
    ['pcm8k_s24be.mov', 'in24', 1e-4],
    ['pcm8k_s24le.mov', 'in24 marked little endian by enda', 1e-4],
    ['pcm8k_s32le.mov', 'in32 marked little endian by enda', 1e-4],
    ['pcm8k_f32le.mov', 'fl32 marked little endian by enda', 1e-4],
    ['pcm8k_f64be.mov', 'fl64', 1e-4]
  ])('%s (%s) comes out as the mono mix', async (name, _entry, tolerance) => {
    const result = await readMp4Audio(fixture(name, 'video/quicktime'));

    expect(result).toMatchObject({ kind: 'pcm', sampleRate: 8000, channels: 2 });
    const samples = result.buffer.getChannelData(0);
    expect(samples.length).toBe(800);
    for (const n of [0, 1, 2, 17, 399, 400, 798, 799]) {
      expect(Math.abs(samples[n] - mix(n))).toBeLessThan(tolerance);
    }
    expect(Math.max(...samples)).toBeGreaterThan(0.2);
  });

  test('the byte order of in24 follows its enda box: both orders give the same audio', async () => {
    const big = await readMp4Audio(fixture('pcm8k_s24be.mov', 'video/quicktime'));
    const little = await readMp4Audio(fixture('pcm8k_s24le.mov', 'video/quicktime'));
    expect(Array.from(little.buffer.getChannelData(0))).toEqual(
      Array.from(big.buffer.getChannelData(0))
    );
  });

  // lpcm is QuickTime sound description version 2: no tool at hand writes it, so the
  // file is built here from the layout in Apple's documentation
  describe('lpcm', () => {
    const FLOAT = 1;
    const BIG_ENDIAN = 2;
    const SIGNED = 4;
    const PACKED = 8;
    const NON_INTERLEAVED = 32;

    const mov = ({ pcm, channels, bits, flags, sampleRate = 48000, chunkFrames = 2 }) =>
      fileOf(
        buildPcmMov({
          entry: lpcmEntry({ channels, sampleRate, bits, flags }),
          pcm,
          frameBytes: (channels * bits) / 8,
          chunkFrames
        }),
        'lpcm.mov',
        'video/quicktime'
      );

    test('32-bit float, little endian, stereo, in chunks of two frames', async () => {
      const values = [0.5, -0.5, 0.25, 0.75, -1, 1, 0.125, 0.375];
      const pcm = new Uint8Array(new Float32Array(values).buffer);

      const result = await readMp4Audio(mov({ pcm, channels: 2, bits: 32, flags: FLOAT | PACKED }));

      expect(result).toMatchObject({ kind: 'pcm', sampleRate: 48000, channels: 2, codec: 'lpcm' });
      expect(Array.from(result.buffer.getChannelData(0))).toEqual([0, 0.5, 0, 0.25]);
    });

    test('16-bit signed, big endian, mono, with a sample rate of its own', async () => {
      const pcm = new Uint8Array([0x40, 0x00, 0xc0, 0x00, 0x7f, 0xff]);

      const result = await readMp4Audio(
        mov({ pcm, channels: 1, bits: 16, flags: BIG_ENDIAN | SIGNED | PACKED, sampleRate: 22050 })
      );

      expect(result.sampleRate).toBe(22050);
      expect(Array.from(result.buffer.getChannelData(0))).toEqual([0.5, -0.5, 32767 / 32768]);
    });

    test('24-bit signed, little endian', async () => {
      const pcm = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);

      const result = await readMp4Audio(
        mov({ pcm, channels: 1, bits: 24, flags: SIGNED | PACKED })
      );

      expect(Array.from(result.buffer.getChannelData(0))).toEqual([0.5, -0.5]);
    });

    test('64-bit float, big endian', async () => {
      const pcm = new Uint8Array(8);
      new DataView(pcm.buffer).setFloat64(0, 0.5);

      const result = await readMp4Audio(
        mov({ pcm, channels: 1, bits: 64, flags: FLOAT | BIG_ENDIAN | PACKED, chunkFrames: 1 })
      );

      expect(Array.from(result.buffer.getChannelData(0))).toEqual([0.5]);
    });

    test('audio with a channel per plane is refused rather than read as interleaved', async () => {
      const pcm = new Uint8Array(16);

      const error = await readMp4Audio(
        mov({ pcm, channels: 2, bits: 32, flags: FLOAT | PACKED | NON_INTERLEAVED })
      ).catch(e => e);

      expect(error).toBeInstanceOf(Mp4AudioError);
      expect(error.code).toBe('mp4-unsupported-codec');
    });
  });
});

describe('PCM sample formats', () => {
  const layoutOf = (format, sampleSize, channels = 1) =>
    describePcm(new Uint8Array(0), {
      format,
      sound: { channels, sampleRate: 48000, sampleSize, version: 1 }
    });
  const convert = (bytes, layout) => {
    const out = new Float32Array(Math.floor(bytes.length / layout.frameBytes));
    const view = new DataView(new Uint8Array(bytes).buffer);
    const frames = convertPcmToMono(view, 0, bytes.length, layout, out, 0);
    expect(frames).toBe(out.length);
    return Array.from(out);
  };

  test('16-bit little endian (sowt) and big endian (twos)', () => {
    expect(convert([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f], layoutOf('sowt', 16))).toEqual([
      0.5,
      -0.5,
      32767 / 32768
    ]);
    expect(convert([0x40, 0x00, 0xc0, 0x00, 0x80, 0x00], layoutOf('twos', 16))).toEqual([
      0.5, -0.5, -1
    ]);
  });

  test('24-bit big endian (in24) with its sign', () => {
    expect(
      convert([0x40, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x80, 0x00, 0x00], layoutOf('in24', 24))
    ).toEqual([0.5, -0.5, -1]);
  });

  test('32-bit big endian (in32) and little endian (23ni)', () => {
    expect(convert([0x40, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00], layoutOf('in32', 32))).toEqual(
      [0.5, -0.5]
    );
    expect(convert([0x00, 0x00, 0x00, 0x40], layoutOf('23ni', 32))).toEqual([0.5]);
  });

  test('32- and 64-bit float, big endian (fl32, fl64)', () => {
    expect(convert([0x3f, 0x00, 0x00, 0x00, 0xbe, 0x80, 0x00, 0x00], layoutOf('fl32', 32))).toEqual(
      [0.5, -0.25]
    );
    expect(convert([0x3f, 0xe0, 0, 0, 0, 0, 0, 0], layoutOf('fl64', 64))).toEqual([0.5]);
  });

  test('8-bit: unsigned (raw) and signed (twos)', () => {
    expect(convert([0x80, 0xc0, 0x00, 0xff], layoutOf('raw ', 8))).toEqual([0, 0.5, -1, 127 / 128]);
    expect(convert([0x40, 0xc0, 0x80], layoutOf('twos', 8))).toEqual([0.5, -0.5, -1]);
  });

  test('channels are mixed down by their mean', () => {
    const stereo = layoutOf('sowt', 16, 2);
    // L=0.5 R=-0.5 → 0; L=0.5 R=0.25 → 0.375
    expect(convert([0x00, 0x40, 0x00, 0xc0, 0x00, 0x40, 0x00, 0x20], stereo)).toEqual([0, 0.375]);
    // Six channels: five silent, one at 0.6
    const six = layoutOf('sowt', 16, 6);
    const frame = new Array(12).fill(0);
    frame[6] = 0xcd; // channel 3: 0x4ccd / 32768 ≈ 0.6
    frame[7] = 0x4c;
    expect(convert(frame, six)[0]).toBeCloseTo(0.1, 3);
  });

  test('a formats it does not know has no layout', () => {
    expect(layoutOf('alac', 16)).toBeNull();
    expect(layoutOf('twos', 20)).toBeNull();
    expect(layoutOf('ipcm', 16)).toBeNull();
  });

  test('pieces are whole frames and no longer than the limit', () => {
    const pieces = splitIntoFrames(
      [
        { offset: 100, bytes: 1000 },
        { offset: 5000, bytes: 7 }
      ],
      4,
      300
    );
    expect(pieces).toEqual([
      { offset: 100, bytes: 300 },
      { offset: 400, bytes: 300 },
      { offset: 700, bytes: 300 },
      { offset: 1000, bytes: 100 },
      { offset: 5000, bytes: 4 }
    ]);
  });
});

describe('planReads', () => {
  const plan = (items, options) =>
    planReads(
      items.map(([offset]) => offset),
      items.map(([, size]) => size),
      options
    );

  test('samples in a row are one read', () => {
    expect(
      plan([
        [100, 10],
        [110, 10],
        [120, 5]
      ])
    ).toEqual([{ start: 100, end: 125, first: 0, last: 3 }]);
  });

  test('a small gap is read through, a large one starts a new read', () => {
    const items = [
      [0, 10],
      [10 + 100, 10],
      [1000000, 10]
    ];
    expect(plan(items, { maxGap: 1000 })).toEqual([
      { start: 0, end: 120, first: 0, last: 2 },
      { start: 1000000, end: 1000010, first: 2, last: 3 }
    ]);
  });

  test('a read stops growing at the limit', () => {
    const items = Array.from({ length: 10 }, (_, i) => [i * 100, 100]);
    expect(plan(items, { maxRead: 350 }).map(read => [read.first, read.last])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 10]
    ]);
  });

  test('a sample behind the one before it starts a new read: the order is kept', () => {
    expect(
      plan([
        [500, 10],
        [100, 10],
        [110, 10]
      ])
    ).toEqual([
      { start: 500, end: 510, first: 0, last: 1 },
      { start: 100, end: 120, first: 1, last: 3 }
    ]);
  });
});

describe('readMp4Audio progress and stopping', () => {
  test('goes from 0 to 100 and never down, over the index and the audio', async () => {
    const percents = [];
    await readMp4Audio(fixture('aac44s_faststart.mp4', 'video/mp4'), {
      maxReadBytes: 2048,
      onProgress: percent => percents.push(percent)
    });

    expect(percents[0]).toBe(0);
    expect(percents[percents.length - 1]).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.length).toBeGreaterThan(3);
    for (const percent of percents) expect(Number.isInteger(percent)).toBe(true);
  });

  test('PCM reports its progress too', async () => {
    const percents = [];
    await readMp4Audio(fixture('pcm44s.mov', 'video/quicktime'), {
      maxReadBytes: 4000,
      onProgress: percent => percents.push(percent)
    });

    expect(percents[percents.length - 1]).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents.length).toBeGreaterThan(5);
  });

  test('stops before reading anything where the signal has fired already', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = recording(fixture('aac44s_faststart.mp4', 'video/mp4'));

    const error = await readMp4Audio(file, { signal: controller.signal }).catch(e => e);

    expect(isAbortError(error)).toBe(true);
    expect(error.code).toBe('aborted');
    expect(file.reads).toHaveLength(0);
  });

  test('stops between two reads of the audio', async () => {
    const controller = new AbortController();
    // The headers, the ftyp, the moov: then the audio in many small reads
    const file = recording(fixture('pcm44s.mov', 'video/quicktime'), count => {
      if (count === 8) controller.abort();
    });

    const error = await readMp4Audio(file, { signal: controller.signal, maxReadBytes: 2000 }).catch(
      e => e
    );

    expect(isAbortError(error)).toBe(true);
    // Nothing is asked for after what was in flight when it stopped
    expect(file.reads.length).toBeLessThanOrEqual(8 + 3);
    const total = Math.ceil(53606 / 2000);
    expect(file.reads.length).toBeLessThan(total);
  });
});

describe('readMp4Audio: what it refuses', () => {
  const failure = async file => {
    const error = await readMp4Audio(file).catch(e => e);
    expect(error).toBeInstanceOf(Mp4AudioError);
    return error;
  };

  test('a file without an index', async () => {
    const bytes = bytesOf('aac48m_moovend.mov');
    const moov = topLevelBoxes(bytes).find(box => box.type === 'moov');
    const error = await failure(
      fileOf(bytes.subarray(0, moov.start), 'cut.mov', 'video/quicktime')
    );
    expect(error.code).toBe('mp4-no-moov');
  });

  test('something that is not a box structure', async () => {
    const junk = new Uint8Array(200).fill(7);
    expect((await failure(fileOf(junk, 'junk.mp4', 'video/mp4'))).code).toBe('mp4-invalid');
  });

  test('a video without sound', async () => {
    expect((await failure(fixture('video_only.mp4', 'video/mp4'))).code).toBe('mp4-no-audio-track');
  });

  test('a fragmented file: its samples are not in the index', async () => {
    expect((await failure(fixture('aac_fragmented.mp4', 'video/mp4'))).code).toBe('mp4-fragmented');
  });

  test('an audio format it cannot read names it', async () => {
    const bytes = withAudioFormat(bytesOf('aac44s_faststart.mp4'), 'ac-3');
    const error = await failure(fileOf(bytes, 'ac3.mp4', 'video/mp4'));
    expect(error.code).toBe('mp4-unsupported-codec');
    expect(error.codec).toBe('ac-3');
  });
});
