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
 * ffmpeg writes an edit list for the audio of each: the AAC ones skip the first
 * 1024 samples (the encoder's delay) and play the rest, the PCM ones play it all.
 * Other edit lists, fragments and tables that lie about the file are made from
 * these with the helpers of tests/utils/mp4Fixtures.js.
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
  createRangeGuard,
  describePcm,
  editListTrim,
  isMp4Container,
  parseAudioSpecificConfig,
  parseEditList,
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
  elstBox,
  fileOf,
  fixture,
  inflate,
  lpcmEntry,
  parseAdts,
  readAll,
  recording,
  topLevelBoxes,
  withAudioFormat,
  withEditList,
  withMoovChild,
  withTimes
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
    // The edit list skips the encoder's delay of 1024 samples, to the end of the audio
    expect(result.trim).toEqual({ offset: 1024 / 44100, duration: null });

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
    expect(result.trim).toEqual({ offset: 1024 / 48000, duration: null });
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
    // Its edit list plays all of it
    expect(result.trim).toBeNull();
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

    test('8-bit without the signed flag is unsigned, as it always was', async () => {
      const pcm = new Uint8Array([0x80, 0xc0, 0x00]);

      const result = await readMp4Audio(mov({ pcm, channels: 1, bits: 8, flags: PACKED }));

      expect(Array.from(result.buffer.getChannelData(0))).toEqual([0, 0.5, -1]);
    });

    // The readers of 16, 24 and 32 bits are signed: unsigned samples read as them
    // would be noise, so the file goes to the decoder of the browser instead
    test.each([16, 24, 32])('%i-bit without the signed flag is refused', async bits => {
      const pcm = new Uint8Array((bits / 8) * 4);

      const error = await readMp4Audio(mov({ pcm, channels: 1, bits, flags: PACKED })).catch(
        e => e
      );

      expect(error).toBeInstanceOf(Mp4AudioError);
      expect(error.code).toBe('mp4-unsupported-codec');
    });

    test('and with the signed flag it is read as before', async () => {
      const pcm = new Uint8Array([0x40, 0x00, 0xc0, 0x00]);

      const result = await readMp4Audio(
        mov({ pcm, channels: 1, bits: 16, flags: BIG_ENDIAN | SIGNED | PACKED })
      );

      expect(Array.from(result.buffer.getChannelData(0))).toEqual([0.5, -0.5]);
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

  // An index with samples of its own and an `mvex` says that more follow in `moof`
  // boxes. Reading only the ones in the index would cut the audio off, and the
  // transcript with it, with nothing to say so
  test('a fragmented file whose index lists samples as well is refused too', async () => {
    for (const [name, type] of [
      ['aac48m_moovend.mov', 'video/quicktime'],
      ['pcm44s.mov', 'video/quicktime']
    ]) {
      const bytes = withMoovChild(bytesOf(name), 'mvex');
      const file = recording(fileOf(bytes, name, type));

      const error = await failure(file);

      expect(error.code).toBe('mp4-fragmented');
      // Refused on the index: none of the audio was read
      expect(bytesRead(file)).toBeLessThan(bytes.length / 2);
    }
  });

  test('an audio format it cannot read names it', async () => {
    const bytes = withAudioFormat(bytesOf('aac44s_faststart.mp4'), 'ac-3');
    const error = await failure(fileOf(bytes, 'ac3.mp4', 'video/mp4'));
    expect(error.code).toBe('mp4-unsupported-codec');
    expect(error.codec).toBe('ac-3');
  });
});

describe('readMp4Audio: edit lists', () => {
  // aac48m_moovend.mov: audio at 48 kHz, 145024 samples (3.0213 s), in a movie of 1000 ticks a second
  const MEDIA_RATE = 48000;
  const aac = bytesOf('aac48m_moovend.mov');
  const pcm = bytesOf('pcm44s.mov');

  const trimOf = async (bytes, elst, times) => {
    let changed = withEditList(bytes, elst);
    if (times) changed = withTimes(changed, times);
    return (await readMp4Audio(fileOf(changed, 'edit.mov', 'video/quicktime'))).trim;
  };
  const refusalOf = async (bytes, elst, times) => {
    let changed = withEditList(bytes, elst);
    if (times) changed = withTimes(changed, times);
    const error = await readMp4Audio(fileOf(changed, 'edit.mov', 'video/quicktime')).catch(e => e);
    expect(error).toBeInstanceOf(Mp4AudioError);
    return error;
  };

  test('a recording trimmed to a segment: where it starts and how long it lasts', async () => {
    // From 1 s on, for 1.5 s
    const trim = await trimOf(aac, elstBox([{ segmentDuration: 1500, mediaTime: MEDIA_RATE }]));

    expect(trim).toEqual({ offset: 1, duration: 1.5 });
  });

  test('the same for PCM: the trim is handed over, the samples are all read', async () => {
    // The media is 44100 ticks a second: from 0.1 s on, for 0.1 s
    const result = await readMp4Audio(
      fileOf(
        withEditList(pcm, elstBox([{ segmentDuration: 100, mediaTime: 4410 }])),
        'p.mov',
        'video/quicktime'
      )
    );

    expect(result.trim).toEqual({ offset: 0.1, duration: 0.1 });
    expect(result.buffer.getChannelData(0)).toHaveLength(13230);
  });

  test('empty edits at the start only delay the track: the audio is trimmed as without them', async () => {
    const trim = await trimOf(
      aac,
      elstBox([
        { segmentDuration: 400, mediaTime: -1 },
        { segmentDuration: 100, mediaTime: -1 },
        { segmentDuration: 1500, mediaTime: MEDIA_RATE }
      ])
    );

    expect(trim).toEqual({ offset: 1, duration: 1.5 });
  });

  test('64-bit entries (version 1) say the same, with the empty edit as -1', async () => {
    const trim = await trimOf(
      aac,
      elstBox(
        [
          { segmentDuration: 400, mediaTime: -1 },
          { segmentDuration: 1500, mediaTime: MEDIA_RATE }
        ],
        { version: 1 }
      )
    );

    expect(trim).toEqual({ offset: 1, duration: 1.5 });
  });

  test('a segment that reaches the end of the media has no length: only the start is cut', async () => {
    // 1 s on, up to the end of the media (145024 ticks, 3021.33 ms; a segment is rounded to a ms)
    expect(await trimOf(aac, elstBox([{ segmentDuration: 2021, mediaTime: MEDIA_RATE }]))).toEqual({
      offset: 1,
      duration: null
    });
    // ... and 20 ms before it, it is a length
    expect(await trimOf(aac, elstBox([{ segmentDuration: 2000, mediaTime: MEDIA_RATE }]))).toEqual({
      offset: 1,
      duration: 2
    });
  });

  test('a segment of 0 is as long as the media is', async () => {
    const trim = await trimOf(aac, elstBox([{ segmentDuration: 0, mediaTime: MEDIA_RATE }]));

    expect(trim).toEqual({ offset: 1, duration: null });
  });

  test('a segment that plays all the media is no trim at all', async () => {
    expect(await trimOf(aac, elstBox([{ segmentDuration: 3021, mediaTime: 0 }]))).toBeNull();
    expect(await trimOf(aac, elstBox([{ segmentDuration: 0, mediaTime: 0 }]))).toBeNull();
  });

  test('a file without an edit list, or with an empty one, plays all of it', async () => {
    expect(await trimOf(aac, null)).toBeNull();
    expect(await trimOf(aac, elstBox([]))).toBeNull();
  });

  test('the segment is in the timescale of the movie and the start in that of the media', async () => {
    // 600 ticks a second in the movie, 24000 in the media (of 6 s): from 2 s on, for 1.5 s
    const elst = elstBox([{ segmentDuration: 900, mediaTime: 48000 }]);
    const times = {
      movie: { timescale: 600, duration: 3600 },
      media: { timescale: 24000, duration: 144000 }
    };

    expect(await trimOf(aac, elst, times)).toEqual({ offset: 2, duration: 1.5 });
  });

  test('64-bit headers of the movie and the media are read as well', async () => {
    const elst = elstBox([{ segmentDuration: 900, mediaTime: 48000 }]);
    const times = {
      movie: { timescale: 600, duration: 3600, wide: true },
      media: { timescale: 24000, duration: 144000, wide: true }
    };

    expect(await trimOf(aac, elst, times)).toEqual({ offset: 2, duration: 1.5 });
  });

  test('a media that does not know its duration cannot be said to reach its end', async () => {
    // A recorder that is still writing leaves the duration 0: the segment is a length
    const times = {
      movie: { timescale: 1000, duration: 0 },
      media: { timescale: MEDIA_RATE, duration: 0 }
    };

    expect(
      await trimOf(aac, elstBox([{ segmentDuration: 1500, mediaTime: MEDIA_RATE }]), times)
    ).toEqual({ offset: 1, duration: 1.5 });
  });

  describe('what a trim cannot say is refused, for the whole-file path to take over', () => {
    test('two pieces of the audio', async () => {
      const error = await refusalOf(
        aac,
        elstBox([
          { segmentDuration: 1000, mediaTime: 0 },
          { segmentDuration: 1000, mediaTime: MEDIA_RATE * 2 }
        ])
      );

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test('a gap after the audio has started', async () => {
      const error = await refusalOf(
        aac,
        elstBox([
          { segmentDuration: 1000, mediaTime: 0 },
          { segmentDuration: 500, mediaTime: -1 },
          { segmentDuration: 1000, mediaTime: MEDIA_RATE }
        ])
      );

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test('an empty edit at the end', async () => {
      const error = await refusalOf(
        aac,
        elstBox([
          { segmentDuration: 1000, mediaTime: 0 },
          { segmentDuration: 500, mediaTime: -1 }
        ])
      );

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test('a track that is only ever silent', async () => {
      const error = await refusalOf(aac, elstBox([{ segmentDuration: 3000, mediaTime: -1 }]));

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test.each([
      ['twice as fast', 2],
      ['half speed', 0.5],
      ['a freeze (rate 0)', 0]
    ])('audio played %s', async (_name, rate) => {
      const error = await refusalOf(
        aac,
        elstBox([{ segmentDuration: 1500, mediaTime: MEDIA_RATE, rate }])
      );

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test('a version of the box this does not know', async () => {
      const error = await refusalOf(
        aac,
        elstBox([{ segmentDuration: 1500, mediaTime: MEDIA_RATE }], { version: 2 })
      );

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test('a start behind the end of the media: nothing would be played', async () => {
      const error = await refusalOf(
        aac,
        elstBox([{ segmentDuration: 1000, mediaTime: MEDIA_RATE * 10 }])
      );

      expect(error.code).toBe('mp4-unsupported-edit');
    });

    test('is refused before any audio is read', async () => {
      const bytes = withEditList(
        aac,
        elstBox([
          { segmentDuration: 1000, mediaTime: 0 },
          { segmentDuration: 1000, mediaTime: MEDIA_RATE * 2 }
        ])
      );
      const file = recording(fileOf(bytes, 'edit.mov', 'video/quicktime'));

      await readMp4Audio(file).catch(() => {});

      expect(bytesRead(file)).toBeLessThan(bytes.length / 2);
    });
  });

  describe('what is damaged is refused as damaged', () => {
    test('an entry count that the box has no room for', async () => {
      // Claims 4 billion entries, has one: the loop must not run on what is not there
      const elst = elstBox([{ segmentDuration: 1500, mediaTime: MEDIA_RATE }], {
        count: 0xffffffff
      });

      expect((await refusalOf(aac, elst)).code).toBe('mp4-invalid');
      expect(
        (await refusalOf(aac, elstBox([{ segmentDuration: 1, mediaTime: 0 }], { count: 2 }))).code
      ).toBe('mp4-invalid');
      expect(
        (
          await refusalOf(
            aac,
            elstBox([{ segmentDuration: 1, mediaTime: 0 }], { count: 2, version: 1 })
          )
        ).code
      ).toBe('mp4-invalid');
    });

    test('a start before the beginning that is not the -1 of an empty edit', async () => {
      const error = await refusalOf(aac, elstBox([{ segmentDuration: 1500, mediaTime: -2 }]));

      expect(error.code).toBe('mp4-invalid');
    });

    test('a timescale of 0 where the edit list needs it to divide by', async () => {
      const elst = elstBox([{ segmentDuration: 1500, mediaTime: MEDIA_RATE }]);

      const movie = await refusalOf(aac, elst, {
        movie: { timescale: 0, duration: 3000 },
        media: { timescale: MEDIA_RATE, duration: 145024 }
      });
      const media = await refusalOf(aac, elst, {
        movie: { timescale: 1000, duration: 3000 },
        media: { timescale: 0, duration: 145024 }
      });

      expect(movie.code).toBe('mp4-invalid');
      expect(media.code).toBe('mp4-invalid');
    });

    test('a track with no timescale is fine where nothing has to be divided', async () => {
      const times = {
        movie: { timescale: 0, duration: 0 },
        media: { timescale: 0, duration: 0 }
      };

      expect(await trimOf(aac, null, times)).toBeNull();
      expect(await trimOf(aac, elstBox([]), times)).toBeNull();
    });
  });

  describe('parseEditList and editListTrim', () => {
    const entriesOf = elst => parseEditList(elst, { start: 0, headerSize: 8, end: elst.length });

    test('read both versions, the sign of the start and the 16.16 rate', () => {
      const entries = [
        { segmentDuration: 400, mediaTime: -1, rate: 1 },
        { segmentDuration: 2 ** 33, mediaTime: 2 ** 33 + 5, rate: 1.5 }
      ];

      expect(entriesOf(elstBox(entries.slice(0, 1)))).toEqual([
        { segmentDuration: 400, mediaTime: -1, mediaRate: 1 }
      ]);
      expect(entriesOf(elstBox(entries, { version: 1 }))).toEqual([
        { segmentDuration: 400, mediaTime: -1, mediaRate: 1 },
        { segmentDuration: 2 ** 33, mediaTime: 2 ** 33 + 5, mediaRate: 1.5 }
      ]);
    });

    test('a segment that ends within one tick of the movie of the end of the media reaches it', () => {
      const timing = { movieTimescale: 1000, mediaTimescale: 48000, mediaDuration: 145024 };
      const trim = segmentDuration =>
        editListTrim([{ segmentDuration, mediaTime: 1024, mediaRate: 1 }], timing);

      // 1 tick of the movie is 48 ticks of the media: the segment ends at 1024 + 48 x ticks
      expect(trim(3000)).toEqual({ offset: 1024 / 48000, duration: null });
      expect(trim(2999)).toEqual({ offset: 1024 / 48000, duration: null });
      expect(trim(2998)).toEqual({ offset: 1024 / 48000, duration: 2.998 });
    });

    test('an offset of 0 with a length is a trim, without one it is none', () => {
      const timing = { movieTimescale: 1000, mediaTimescale: 48000, mediaDuration: 145024 };

      expect(editListTrim([{ segmentDuration: 1000, mediaTime: 0, mediaRate: 1 }], timing)).toEqual(
        {
          offset: 0,
          duration: 1
        }
      );
      expect(
        editListTrim([{ segmentDuration: 3022, mediaTime: 0, mediaRate: 1 }], timing)
      ).toBeNull();
    });
  });
});

describe('readMp4Audio: an index that lies about the file', () => {
  const FLAGS = 2 | 4 | 8; // big endian, signed, packed
  const FRAME_BYTES = 2;

  /** A mono 16-bit file of 500 frames whose sample tables say `tables`. */
  const craftedBytes = (tables, frames = 500) =>
    buildPcmMov({
      entry: lpcmEntry({ channels: 1, sampleRate: 48000, bits: 16, flags: FLAGS }),
      pcm: new Uint8Array(frames * FRAME_BYTES),
      frameBytes: FRAME_BYTES,
      chunkFrames: frames,
      tables
    });
  const crafted = tables => fileOf(craftedBytes(tables), 'crafted.mov', 'video/quicktime');
  const SIZE = craftedBytes({}).length;
  const MOOV_AT = topLevelBoxes(craftedBytes({})).find(box => box.type === 'moov').start;
  const FIRST_CHUNK = 28; // ftyp 20 + the 8 bytes of the mdat header

  const refusal = async (tables, file = crafted(tables)) => {
    const started = Date.now();
    const error = await readMp4Audio(file).catch(e => e);
    expect(error).toBeInstanceOf(Mp4AudioError);
    // Said no at once, not after working through what the numbers ask for
    expect(Date.now() - started).toBeLessThan(2000);
    return error;
  };

  test('the file as built is read: the checks leave an honest one alone', async () => {
    const result = await readMp4Audio(crafted({}));

    expect(result.buffer.getChannelData(0)).toHaveLength(500);
    expect(
      (await readMp4Audio(crafted({ wideOffsets: true }))).buffer.getChannelData(0)
    ).toHaveLength(500);
  });

  test('two 32-bit fields that ask for 18 exabytes do not freeze the page', async () => {
    // samples per chunk x sample size = 0xffffffff x 0xffffffff bytes. Cut into reads of
    // 8 MB, that is trillions of pieces, made before any limit could say no
    const file = recording(
      crafted({ runs: [[1, 0xffffffff]], sampleSize: 0xffffffff, chunkOffsets: [FIRST_CHUNK] })
    );

    const error = await refusal(null, file);

    expect(error.code).toBe('mp4-invalid');
    // None of the audio was read: the box headers, the ftyp and the index
    for (const [start, end] of file.reads) {
      const header = end - start <= 16;
      const ftyp = start === 0 && end <= 64;
      expect(header || ftyp || start >= MOOV_AT).toBe(true);
    }
  });

  test('a table that asks for more bytes than the file has is refused', async () => {
    // 5 million frames of 2 bytes: 10 MB in a file of about 1.5 KB
    const error = await refusal({ runs: [[1, 5000000]], chunkOffsets: [FIRST_CHUNK] });

    expect(error.code).toBe('mp4-invalid');
  });

  test('a chunk that starts past the end of the file is refused', async () => {
    const error = await refusal({ runs: [[1, 10]], chunkOffsets: [SIZE + 1000] });

    expect(error.code).toBe('mp4-invalid');
  });

  test('a chunk that starts inside the file and ends past it is refused', async () => {
    // 1000 bytes from 500 bytes before the end
    const error = await refusal({ runs: [[1, 500]], chunkOffsets: [SIZE - 500] });

    expect(error.code).toBe('mp4-invalid');
  });

  test('a chunk that ends exactly at the end of the file is fine', async () => {
    const result = await readMp4Audio(crafted({ runs: [[1, 250]], chunkOffsets: [SIZE - 500] }));

    expect(result.buffer.getChannelData(0)).toHaveLength(250);
  });

  test('a 64-bit offset beyond anything a file can hold is refused', async () => {
    const error = await refusal({
      runs: [[1, 10]],
      chunkOffsets: [2 ** 60],
      wideOffsets: true
    });

    expect(error.code).toBe('mp4-invalid');
  });

  test('chunks that each fit but are the same bytes over and over are refused', async () => {
    // Three chunks of the whole 1000 bytes at one place: 3000 bytes of samples in a file of 1.5 KB
    const error = await refusal({
      runs: [[1, 500]],
      chunkOffsets: [FIRST_CHUNK, FIRST_CHUNK, FIRST_CHUNK]
    });

    expect(error.code).toBe('mp4-invalid');
  });

  test('runs of chunks that go backwards would make a chunk twice: refused', async () => {
    const error = await refusal({
      runs: [
        [1, 250],
        [1, 250]
      ],
      chunkOffsets: [FIRST_CHUNK, FIRST_CHUNK + 500]
    });

    expect(error.code).toBe('mp4-invalid');
  });

  test('a first chunk of 0 does not exist (chunks are numbered from 1)', async () => {
    const error = await refusal({ runs: [[0, 500]], chunkOffsets: [FIRST_CHUNK] });

    expect(error.code).toBe('mp4-invalid');
  });

  test('AAC: samples that lie past the end of the file are refused', async () => {
    // Every chunk of the audio moved beyond the end of the file
    const bytes = new Uint8Array(bytesOf('aac48m_moovend.mov'));
    const view = new DataView(bytes.buffer);
    const moov = topLevelBoxes(bytes).find(box => box.type === 'moov');
    // The audio's stco: the one box of that type with chunks of the audio's size
    let moved = 0;
    for (let at = moov.start; at < bytes.length - 8; at++) {
      if (String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'stco') continue;
      const count = view.getUint32(at + 8);
      // The audio has the most chunks of the fixture's two tracks (the picture has a few)
      if (count < 2) continue;
      for (let chunk = 0; chunk < count; chunk++) {
        const entry = at + 12 + chunk * 4;
        view.setUint32(entry, view.getUint32(entry) + bytes.length);
      }
      moved++;
    }
    expect(moved).toBeGreaterThan(0);

    const error = await readMp4Audio(fileOf(bytes, 'moved.mov', 'video/quicktime')).catch(e => e);

    expect(error).toBeInstanceOf(Mp4AudioError);
    expect(error.code).toBe('mp4-invalid');
  });

  describe('createRangeGuard', () => {
    test('takes ranges inside the file whose sum is no more than the file', () => {
      const guard = createRangeGuard(100);

      expect(() => guard(0, 60)).not.toThrow();
      expect(() => guard(60, 40)).not.toThrow();
      expect(() => guard(100, 0)).not.toThrow();
    });

    test('refuses a range past the end, however it gets there', () => {
      expect(() => createRangeGuard(100)(60, 41)).toThrow(Mp4AudioError);
      expect(() => createRangeGuard(100)(101, 0)).toThrow(Mp4AudioError);
      expect(() => createRangeGuard(100)(0, 2 ** 64)).toThrow(Mp4AudioError);
      expect(() => createRangeGuard(100)(NaN, 5)).toThrow(Mp4AudioError);
      expect(() => createRangeGuard(100)(5, NaN)).toThrow(Mp4AudioError);
    });

    test('refuses ranges that together are more than the file: they overlap', () => {
      const guard = createRangeGuard(100);

      guard(0, 60);
      expect(() => guard(0, 60)).toThrow(Mp4AudioError);
    });
  });
});
