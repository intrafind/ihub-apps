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
 */
export const buildPcmMov = ({ entry, pcm, frameBytes, chunkFrames }) => {
  const ftyp = box('ftyp', ascii('qt  '), u32(0), ascii('qt  '));
  const mdat = box('mdat', pcm);
  const frames = pcm.length / frameBytes;
  const chunks = [];
  for (let frame = 0; frame < frames; frame += chunkFrames) chunks.push(frame);
  // The last chunk holds what is left, as in a real file
  const runs = [[1, chunkFrames]];
  if (frames % chunkFrames) runs.push([chunks.length, frames % chunkFrames]);
  const firstChunkAt = ftyp.length + 8;
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox(
      'stsc',
      0,
      0,
      u32(runs.length),
      ...runs.flatMap(([first, perChunk]) => [u32(first), u32(perChunk), u32(1)])
    ),
    fullBox('stsz', 0, 0, u32(frameBytes), u32(frames)),
    fullBox(
      'stco',
      0,
      0,
      u32(chunks.length),
      ...chunks.map(frame => u32(firstChunkAt + frame * frameBytes))
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
