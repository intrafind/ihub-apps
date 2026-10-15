/**
 * Fixtures and fakes for the tests of MP4/MOV audio extraction.
 *
 * The files in tests/fixtures/media are a few seconds long, made with ffmpeg
 * (the commands are in mp4-audio-extraction.test.jsx). What a video of several
 * GB does is tested with `inflate`: a file that says its `mdat` is GB larger,
 * which has no bytes there, and fails any read that reaches into them.
 */
import fs from 'fs';
import path from 'path';

const FIXTURES = path.resolve(__dirname, '../fixtures/media');

export const bytesOf = name => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
export const fileOf = (bytes, name, type = '') => new File([bytes], name, { type });
export const fixture = (name, type) => fileOf(bytesOf(name), name, type);

/** A file that remembers what it was asked to read. */
export const recording = (inner, onSlice) => {
  const reads = [];
  return {
    name: inner.name,
    type: inner.type,
    size: inner.size,
    reads,
    slice(start, end) {
      reads.push([start, Math.min(end, inner.size)]);
      onSlice?.(reads.length);
      return inner.slice(start, end);
    }
  };
};

export const bytesRead = file => file.reads.reduce((sum, [start, end]) => sum + end - start, 0);

export const topLevelBoxes = bytes => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  for (let at = 0; at < bytes.length;) {
    const size = view.getUint32(at);
    boxes.push({
      type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      start: at,
      size
    });
    at += size;
  }
  return boxes;
};

/**
 * The fixture with `gap` more bytes in its `mdat`, none of them real. The
 * `wide`/`free` box ffmpeg writes before the `mdat` and the 8-byte `mdat`
 * header make 16 bytes, which is a 64-bit `mdat` header: nothing in the file
 * moves, the `moov` after the `mdat` just starts `gap` bytes later. A read
 * into the gap of more than `gapAllowance` bytes throws.
 */
export const inflate = (bytes, gap, { gapAllowance = 4096, name = 'huge.mov' } = {}) => {
  const boxes = topLevelBoxes(bytes);
  const mdatIndex = boxes.findIndex(box => box.type === 'mdat');
  const pad = boxes[mdatIndex - 1];
  const moov = boxes.find(box => box.type === 'moov');
  if (pad.size !== 8 || boxes[mdatIndex].start + boxes[mdatIndex].size !== moov.start) {
    throw new Error('the fixture does not have its moov after the mdat');
  }

  const payload = bytes.subarray(boxes[mdatIndex].start + 8, moov.start);
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  header.set([0x6d, 0x64, 0x61, 0x74], 4);
  const mdatSize = 16 + payload.length + gap;
  view.setUint32(8, Math.floor(mdatSize / 2 ** 32));
  view.setUint32(12, mdatSize % 2 ** 32);
  const head = new Uint8Array(pad.start + 16 + payload.length);
  head.set(bytes.subarray(0, pad.start), 0);
  head.set(header, pad.start);
  head.set(payload, pad.start + 16);
  const tail = bytes.subarray(moov.start);

  const size = head.length + gap + tail.length;
  const reads = [];
  let gapBytes = 0;
  return {
    name,
    type: 'video/quicktime',
    size,
    reads,
    get gapBytes() {
      return gapBytes;
    },
    slice(start, end) {
      end = Math.min(end, size);
      reads.push([start, end]);
      const parts = [];
      if (start < head.length) parts.push(head.subarray(start, Math.min(end, head.length)));
      const inGap = Math.min(end, head.length + gap) - Math.max(start, head.length);
      if (inGap > 0) {
        gapBytes += inGap;
        if (inGap > gapAllowance) throw new Error(`read ${inGap} bytes of the mdat`);
        parts.push(new Uint8Array(inGap));
      }
      if (end > head.length + gap) {
        const from = Math.max(start, head.length + gap) - head.length - gap;
        parts.push(tail.subarray(from, end - head.length - gap));
      }
      return new Blob(parts);
    }
  };
};

export const readAll = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });

/** The frames of an ADTS stream: what each header says, and where the payload is. */
export const parseAdts = bytes => {
  const frames = [];
  for (let at = 0; at < bytes.length;) {
    expect(bytes[at]).toBe(0xff);
    expect(bytes[at + 1] & 0xf6).toBe(0xf0); // syncword, layer 00
    const length = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
    frames.push({
      mpeg2: Boolean(bytes[at + 1] & 8),
      hasCrc: !(bytes[at + 1] & 1),
      profile: bytes[at + 2] >> 6,
      samplingIndex: (bytes[at + 2] >> 2) & 15,
      channels: ((bytes[at + 2] & 1) << 2) | (bytes[at + 3] >> 6),
      length,
      fullness: ((bytes[at + 5] & 31) << 6) | (bytes[at + 6] >> 2),
      blocks: bytes[at + 6] & 3,
      payload: bytes.subarray(at + 7, at + length)
    });
    at += length;
  }
  return frames;
};

/** 'mp4a' → another sample entry type, so that no reader knows the codec. */
export const withAudioFormat = (bytes, format) => {
  const copy = new Uint8Array(bytes);
  const at = copy.findIndex(
    (byte, i) =>
      byte === 0x6d && copy[i + 1] === 0x70 && copy[i + 2] === 0x34 && copy[i + 3] === 0x61
  );
  if (at < 0) throw new Error('no mp4a sample entry in the fixture');
  copy.set(
    [...format].map(char => char.charCodeAt(0)),
    at
  );
  return copy;
};

// ---------------------------------------------------------------- built in memory

const u16 = value => new Uint8Array([(value >> 8) & 255, value & 255]);
const u32 = value =>
  new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
// 64-bit, signed where `value` is negative (-1 is all ones)
const u64 = value => {
  const high = Math.floor(value / 2 ** 32);
  return new Uint8Array([...u32(high), ...u32(value - high * 2 ** 32)]);
};
const f64 = value => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
};
const ascii = text => Uint8Array.from([...text].map(char => char.charCodeAt(0)));
const concat = parts => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const box = (type, ...parts) => {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(type), body]);
};
const fullBox = (type, version, flags, ...parts) =>
  box(type, new Uint8Array([version, 0, 0, flags]), ...parts);

/**
 * A QuickTime file with one uncompressed audio track, built from the pieces the
 * reader looks at: ftyp, mdat, and a moov with a track whose sample description
 * is `entry` (the box of the sample entry). The PCM bytes are written in chunks
 * of `chunkFrames` frames. Only for what no tool in reach writes, e.g. `lpcm`.
 *
 * `tables` replaces what the sample tables say, to build the damaged or crafted
 * files a reader must not believe: `runs` (`[first chunk, samples per chunk,
 * description index = 1]` per `stsc` entry), `sampleSize` and `sampleCount`
 * (`stsz`), `chunkOffsets` (`stco`, or `co64` with `wideOffsets`).
 */
export const buildPcmMov = ({ entry, pcm, frameBytes, chunkFrames, tables = {} }) => {
  const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
  const mdat = box('mdat', pcm);
  const frames = pcm.length / frameBytes;
  const chunks = [];
  for (let frame = 0; frame < frames; frame += chunkFrames) chunks.push(frame);
  // The last chunk holds what is left, as in a real file
  const runs = tables.runs ?? [[1, chunkFrames]];
  if (!tables.runs && frames % chunkFrames) {
    // A single chunk that is not full has the one run to itself
    if (chunks.length === 1) runs[0][1] = frames % chunkFrames;
    else runs.push([chunks.length, frames % chunkFrames]);
  }
  const firstChunkAt = ftyp.length + 8;
  const chunkOffsets =
    tables.chunkOffsets ?? chunks.map(frame => firstChunkAt + frame * frameBytes);
  const writeOffset = tables.wideOffsets ? u64 : u32;
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox(
      'stsc',
      0,
      0,
      u32(runs.length),
      ...runs.flatMap(([first, perChunk, description = 1]) => [
        u32(first),
        u32(perChunk),
        u32(description)
      ])
    ),
    fullBox('stsz', 0, 0, u32(tables.sampleSize ?? frameBytes), u32(tables.sampleCount ?? frames)),
    fullBox(
      tables.wideOffsets ? 'co64' : 'stco',
      0,
      0,
      u32(chunkOffsets.length),
      ...chunkOffsets.map(writeOffset)
    )
  );
  const trak = box(
    'trak',
    fullBox('tkhd', 0, 7, u32(0), u32(0), u32(1), new Uint8Array(72)),
    box(
      'mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(48000), u32(frames), u16(0), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(13)),
      box('minf', stbl)
    )
  );
  const moov = box('moov', fullBox('mvhd', 0, 0, new Uint8Array(96)), trak);
  return concat([ftyp, mdat, moov]);
};

/**
 * The `lpcm` sample entry of QuickTime sound description version 2. `flags` are
 * the CoreAudio format flags: 1 float, 2 big endian, 4 signed integer, 8 packed,
 * 32 not interleaved.
 */
export const lpcmEntry = ({ channels, sampleRate, bits, flags }) =>
  box(
    'lpcm',
    new Uint8Array(6),
    u16(1), // data reference index
    u16(2), // sound description version
    u16(0),
    u32(0),
    u16(3),
    u16(16),
    u16(0xfffe),
    u16(0),
    u32(65536),
    u32(72), // the rest of the description
    f64(sampleRate),
    u32(channels),
    u32(0x7f000000),
    u32(bits),
    u32(flags),
    u32((channels * bits) / 8),
    u32(1)
  );

// ---------------------------------------------------------------- changed in place

/** The boxes in `bytes[start, end)`: `{ type, start, end }`, 32-bit sizes only. */
const childrenOf = (bytes, start, end) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const children = [];
  for (let at = start; at < end;) {
    const size = view.getUint32(at);
    children.push({
      type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      start: at,
      end: at + size
    });
    at += size;
  }
  return children;
};

/** The `moov` of a fixture that has it last, its children, and the end of the file before it. */
const moovOf = bytes => {
  const moov = topLevelBoxes(bytes).find(candidate => candidate.type === 'moov');
  if (moov.start + moov.size !== bytes.length) {
    throw new Error('the fixture does not have its moov last');
  }
  return { start: moov.start, children: childrenOf(bytes, moov.start + 8, bytes.length) };
};

const sliceOf = (bytes, child) => bytes.subarray(child.start, child.end);

/** `container` as a box of its own type, each child as `replace(child)` or as it was. */
const mapChildren = (bytes, container, replace) =>
  box(
    container.type,
    ...childrenOf(bytes, container.start + 8, container.end).map(
      child => replace(child) ?? sliceOf(bytes, child)
    )
  );

/** Whether a `trak` is the sound track: its `hdlr` says `soun`. */
const isAudioTrack = (bytes, trak) => {
  const mdia = childrenOf(bytes, trak.start + 8, trak.end).find(child => child.type === 'mdia');
  const hdlr = mdia && childrenOf(bytes, mdia.start + 8, mdia.end).find(c => c.type === 'hdlr');
  return (
    Boolean(hdlr) &&
    String.fromCharCode(...bytes.subarray(hdlr.start + 16, hdlr.start + 20)) === 'soun'
  );
};

/**
 * An `elst` box. `entries` are `{ segmentDuration, mediaTime, rate = 1 }` (a
 * `mediaTime` of -1 is an empty edit). `version` 1 writes 64-bit fields. `count`
 * writes another number of entries than there are: what a damaged file does.
 */
export const elstBox = (entries, { version = 0, count = entries.length } = {}) => {
  const wide = version === 1;
  const field = value => (wide ? u64(value) : u32(value));
  return fullBox(
    'elst',
    version,
    0,
    u32(count),
    ...entries.flatMap(({ segmentDuration, mediaTime, rate = 1 }) => {
      const whole = Math.floor(rate);
      return [
        field(segmentDuration),
        field(mediaTime),
        u16(whole),
        u16(Math.round((rate - whole) * 65536))
      ];
    })
  );
};

/**
 * The fixture (which has its `moov` last) with the edit list of its audio track
 * replaced by `elst` (a box from `elstBox`), or with none where `elst` is null.
 */
export const withEditList = (bytes, elst) => {
  const { start, children } = moovOf(bytes);
  const audioIndex = children.findIndex(
    child => child.type === 'trak' && isAudioTrack(bytes, child)
  );
  if (audioIndex < 0) throw new Error('no audio track in the fixture');
  const trak = children[audioIndex];
  const parts = childrenOf(bytes, trak.start + 8, trak.end).filter(child => child.type !== 'edts');
  const kept = parts.map(part => sliceOf(bytes, part));
  // Where it belongs: after the track header
  if (elst) kept.splice(parts.findIndex(part => part.type === 'tkhd') + 1, 0, box('edts', elst));
  const moov = box(
    'moov',
    ...children.map((child, i) => (i === audioIndex ? box('trak', ...kept) : sliceOf(bytes, child)))
  );
  return concat([bytes.subarray(0, start), moov]);
};

/** An `mvhd` or `mdhd` (the `tail` is what follows the duration in each). */
const timesBox = (type, { timescale, duration, wide = false }, tail) =>
  fullBox(
    type,
    wide ? 1 : 0,
    0,
    wide ? u64(0) : u32(0), // creation
    wide ? u64(0) : u32(0), // modification
    u32(timescale),
    wide ? u64(duration) : u32(duration),
    tail
  );

/**
 * The fixture (which has its `moov` last) with the timescale and duration of its
 * movie (`mvhd`) and of the media of its audio track (`mdhd`) replaced:
 * `{ timescale, duration, wide }` each, `wide` for the 64-bit version 1 boxes.
 */
export const withTimes = (bytes, { movie, media }) => {
  const { start, children } = moovOf(bytes);
  const replaced = children.map(child => {
    if (child.type === 'mvhd' && movie) return timesBox('mvhd', movie, new Uint8Array(80));
    if (child.type !== 'trak' || !media || !isAudioTrack(bytes, child)) return null;
    return mapChildren(bytes, child, part =>
      part.type === 'mdia'
        ? mapChildren(bytes, part, header =>
            header.type === 'mdhd' ? timesBox('mdhd', media, new Uint8Array(4)) : null
          )
        : null
    );
  });
  const moov = box('moov', ...children.map((child, i) => replaced[i] ?? sliceOf(bytes, child)));
  return concat([bytes.subarray(0, start), moov]);
};

/** The fixture (which has its `moov` last) with an empty box of `type` added to its `moov`. */
export const withMoovChild = (bytes, type) => {
  const { start, children } = moovOf(bytes);
  const moov = box('moov', ...children.map(child => sliceOf(bytes, child)), box(type));
  return concat([bytes.subarray(0, start), moov]);
};
