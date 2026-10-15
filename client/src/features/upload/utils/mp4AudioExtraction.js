/**
 * The audio track of an MP4, MOV or M4A file of any size, read with
 * `File.slice()`.
 *
 * A browser cannot read more than about 2 GB of a file into one ArrayBuffer
 * (a 3 GB file fails with NotReadableError, a 1.9 GB one works), and the audio
 * of a video is a small part of it: half an hour of AAC is 30 MB, of a 10 GB
 * video. So only what is needed is read:
 *
 *   1. the top-level box headers (16 bytes each), hopping over the `mdat` that
 *      holds the picture, to find the `moov` index: at the start of the file
 *      for MP4 (`faststart`), after a multi-GB `mdat` for QuickTime and most
 *      cameras
 *   2. the `moov`, which is read whole and cut down to the one audio track
 *   3. the bytes of that track's samples, in reads of at most 8 MB. Bytes of
 *      other tracks in between are skipped, unless the gap is small enough to
 *      read through
 *
 * The result is what the browser can finish with:
 *
 *   - AAC: the raw frames, each wrapped in a 7-byte ADTS header, as an
 *     `audio/aac` Blob for `decodeAudioData`. The sample table comes from
 *     mp4box.js (loaded on first use), which also reads the AudioSpecificConfig
 *   - uncompressed PCM (QuickTime `sowt`, `twos`, `in24`, `in32`, `fl32`,
 *     `fl64`, `raw `, `lpcm`): the samples as mono floats in an AudioBuffer, no
 *     decoder needed. mp4box.js is not used here: it expands the sample table
 *     into one object per frame (86 million for half an hour of 48 kHz), where
 *     the raw table is a few thousand chunk offsets
 *
 * Anything else (fragmented files, Opus, AC-3, ALAC, ...) is refused with an
 * `Mp4AudioError`; the caller decides whether the whole-file path can take over.
 */
import { createAbortError, throwIfAborted } from '../../../utils/abortable';

/** The most that one read asks the file for. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Bytes between two samples that are read through instead of skipped. */
export const MAX_GAP_BYTES = 256 * 1024;
/** Reads in flight at once: hides the latency of a slow disk or share. */
const READ_AHEAD = 3;
/** The index of a video is some MB; this is far beyond any real one. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024;
/** Top-level boxes before the `moov` (ftyp, wide, mdat, free, uuid, ...). */
const MAX_TOP_LEVEL_BOXES = 256;
/** Mono floats at the source rate must fit in memory (about 3 hours at 48 kHz). */
const MAX_PCM_BYTES = 2 * 1024 * 1024 * 1024 - 1;
/** A PCM track is a few thousand chunks; one per frame would be millions. */
const MAX_CHUNKS = 500000;
/** Samples mp4box.js is given to turn into objects: 19 hours of AAC. */
const MAX_AAC_SAMPLES = 3000000;
/** An ftyp lists a few brands. */
const MAX_FTYP_BYTES = 64 * 1024;

export const MP4_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'audio/mp4',
  'audio/x-m4a'
];
// Boxes a file may start with: ftyp, or the legacy QuickTime layouts without one
const MP4_FIRST_BOXES = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'];

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
];
// ADTS channel configuration for a channel count, where the AudioSpecificConfig
// leaves it to a program config element
const ADTS_CHANNEL_CONFIG = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 8: 7 };

/**
 * Why the audio could not be read this way. `code` says what was wrong:
 * `mp4-invalid` (not an MP4/MOV file, damaged index), `mp4-no-moov`,
 * `mp4-fragmented`, `mp4-no-audio-track`, `mp4-unsupported-codec` (`codec` names
 * it), `mp4-unsupported-layout`, `mp4-too-large`.
 */
export class Mp4AudioError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'Mp4AudioError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// ---------------------------------------------------------------- bytes

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be64 = (b, o) => be32(b, o) * 4294967296 + be32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Read `file[start, end)`; stops with the abort error when `signal` fires. */
const readSlice = (file, start, end, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const reader = new FileReader();
    const onAbort = () => reader.abort();
    const settle = fn => value => {
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    reader.onload = settle(() => resolve(reader.result));
    reader.onerror = settle(() => reject(new Error('read-error')));
    reader.onabort = settle(() => reject(createAbortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.readAsArrayBuffer(file.slice(start, end));
  });

/**
 * Whether `file` is an MP4-family container (MP4, MOV, M4V, M4A), by its type
 * or, where the browser reports none or a wrong one, by the first box.
 */
export const isMp4Container = async (file, signal) => {
  if (MP4_MIME_TYPES.includes(file.type)) return true;
  if (!file.size || file.size < 12) return false;
  const head = new Uint8Array(await readSlice(file, 0, 12, signal));
  return MP4_FIRST_BOXES.includes(fourcc(head, 4));
};

// ------------------------------------------------------------ box walking

/** The boxes in `b[start, end)`, not their contents. Stops at a damaged one. */
const boxesIn = (b, start, end) => {
  const boxes = [];
  let position = start;
  while (position + 8 <= end) {
    let size = be32(b, position);
    let headerSize = 8;
    if (size === 1) {
      if (position + 16 > end) break;
      size = be64(b, position + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < headerSize || position + size > end) break;
    boxes.push({
      type: fourcc(b, position + 4),
      start: position,
      headerSize,
      end: position + size
    });
    position += size;
  }
  return boxes;
};

const childOf = (b, box, type) =>
  boxesIn(b, box.start + box.headerSize, box.end).find(child => child.type === type);

/** The header of the box at `position`: where the next one starts. */
const readBoxHeader = async (file, position, signal) => {
  const bytes = new Uint8Array(
    await readSlice(file, position, Math.min(position + 16, file.size), signal)
  );
  if (bytes.length < 8) throw new Mp4AudioError('mp4-invalid');
  const type = fourcc(bytes, 4);
  // A box type is four printable characters (the QuickTime ones include ©)
  if (![...type].every(char => char === '©' || (char >= ' ' && char <= '~'))) {
    throw new Mp4AudioError('mp4-invalid');
  }
  let size = be32(bytes, 0);
  let headerSize = 8;
  if (size === 1) {
    if (bytes.length < 16) throw new Mp4AudioError('mp4-invalid');
    size = be64(bytes, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = file.size - position;
  }
  if (size < headerSize) throw new Mp4AudioError('mp4-invalid');
  return { type, start: position, size, headerSize };
};

/**
 * Find the `moov` (and the `ftyp`) by hopping from box header to box header.
 * The `mdat` between them is never read, whatever its size.
 */
const locateIndex = async (file, signal) => {
  let ftyp = null;
  let position = 0;
  for (let hops = 0; position < file.size && hops < MAX_TOP_LEVEL_BOXES; hops++) {
    throwIfAborted(signal);
    const box = await readBoxHeader(file, position, signal);
    if (box.type === 'ftyp' && !ftyp) ftyp = box;
    if (box.type === 'moov') {
      if (position + box.size > file.size) throw new Mp4AudioError('mp4-invalid');
      return { moov: box, ftyp };
    }
    position += box.size;
  }
  throw new Mp4AudioError('mp4-no-moov');
};

// ------------------------------------------------------------ the tracks

/**
 * What an `enda` box in the sample entry says about the byte order of PCM: true
 * for little endian, false for big endian, undefined where there is none. A
 * QuickTime `in24`, `in32`, `fl32`, `fl64` or `twos` entry is big endian
 * unless it has one (ffmpeg writes it inside a `wave` box for the little endian
 * variants).
 */
const endianessOf = (b, start, end) => {
  const boxes = boxesIn(b, start, end);
  const wave = boxes.find(box => box.type === 'wave');
  const enda = [...boxes, ...(wave ? boxesIn(b, wave.start + wave.headerSize, wave.end) : [])].find(
    box => box.type === 'enda'
  );
  return enda ? be16(b, enda.start + enda.headerSize) === 1 : undefined;
};

/** `moov` bytes → what the first sample description of each track says. */
const describeTracks = (b, moov, isQuickTime) => {
  const tracks = [];
  for (const trak of boxesIn(b, moov.start + moov.headerSize, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = childOf(b, trak, 'mdia');
    const hdlr = mdia && childOf(b, mdia, 'hdlr');
    const minf = mdia && childOf(b, mdia, 'minf');
    const stbl = minf && childOf(b, minf, 'stbl');
    const stsd = stbl && childOf(b, stbl, 'stsd');
    const tkhd = childOf(b, trak, 'tkhd');
    if (!hdlr || !stsd || !tkhd) continue;

    const body = tkhd.start + tkhd.headerSize;
    const id = be32(b, body + 4 + (b[body] === 1 ? 16 : 8));
    const handler = fourcc(b, hdlr.start + hdlr.headerSize + 8);
    const entry = boxesIn(b, stsd.start + stsd.headerSize + 8, stsd.end)[0];
    const track = { trak, stbl, id, handler, format: entry?.type };
    if (handler === 'soun' && entry && entry.end - entry.start - entry.headerSize >= 28) {
      // After the 6 reserved bytes and the data reference index
      const at = entry.start + entry.headerSize + 8;
      const version = be16(b, at);
      // QuickTime sound description versions 1 and 2 carry more after these
      const extensionBytes = isQuickTime ? { 1: 16, 2: 36 }[version] || 0 : 0;
      track.sound = {
        version,
        channels: be16(b, at + 8),
        sampleSize: be16(b, at + 10),
        sampleRate: be32(b, at + 16) / 65536,
        extension: at + 20,
        entryEnd: entry.end,
        isQuickTime,
        littleEndian: endianessOf(b, at + 20 + extensionBytes, entry.end)
      };
    }
    tracks.push(track);
  }
  return tracks;
};

// ------------------------------------------------------------ PCM

const int24 = (view, p, little) => {
  const x = little
    ? view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16)
    : (view.getUint8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2);
  return ((x << 8) >> 8) / 8388608;
};

// One sample of a channel → -1..1
const SAMPLE_READERS = {
  uint8: { bytes: 1, read: (v, p) => (v.getUint8(p) - 128) / 128 },
  int8: { bytes: 1, read: (v, p) => v.getInt8(p) / 128 },
  int16le: { bytes: 2, read: (v, p) => v.getInt16(p, true) / 32768 },
  int16be: { bytes: 2, read: (v, p) => v.getInt16(p, false) / 32768 },
  int24le: { bytes: 3, read: (v, p) => int24(v, p, true) },
  int24be: { bytes: 3, read: (v, p) => int24(v, p, false) },
  int32le: { bytes: 4, read: (v, p) => v.getInt32(p, true) / 2147483648 },
  int32be: { bytes: 4, read: (v, p) => v.getInt32(p, false) / 2147483648 },
  float32le: { bytes: 4, read: (v, p) => v.getFloat32(p, true) },
  float32be: { bytes: 4, read: (v, p) => v.getFloat32(p, false) },
  float64le: { bytes: 8, read: (v, p) => v.getFloat64(p, true) },
  float64be: { bytes: 8, read: (v, p) => v.getFloat64(p, false) }
};

// QuickTime formats whose sample format the four characters give away
const PCM_BY_FORMAT = {
  sowt: 'int16le',
  in24: 'int24be',
  in32: 'int32be',
  '23ni': 'int32le',
  fl32: 'float32be',
  fl64: 'float64be',
  'raw ': 'uint8'
};

/**
 * How the samples of a PCM track are laid out, or null if `format` is not PCM
 * this reader handles. `{ reader, channels, sampleRate, frameBytes }`.
 */
export const describePcm = (b, track) => {
  const { format, sound } = track;
  if (!sound) return null;
  let kind = PCM_BY_FORMAT[format];
  let { channels, sampleRate } = sound;

  if (format === 'twos') {
    kind = { 8: 'int8', 16: 'int16be', 24: 'int24be', 32: 'int32be' }[sound.sampleSize];
  } else if (format === 'sowt' && sound.sampleSize === 8) {
    // ffmpeg writes signed 8-bit as `sowt` with a sample size of 8
    kind = 'int8';
  }
  // The byte order of the entry, where it says one (the format is big endian otherwise)
  if (kind && format !== 'sowt' && format !== 'lpcm' && sound.littleEndian !== undefined) {
    kind = kind.replace(/(le|be)$/, sound.littleEndian ? 'le' : 'be');
  }

  if (format === 'lpcm') {
    // Sound description version 2: the real values are in the extension
    if (!sound.isQuickTime || sound.version !== 2 || sound.entryEnd - sound.extension < 36) {
      return null;
    }
    const at = sound.extension;
    const flags = be32(b, at + 24);
    const bits = be32(b, at + 20);
    const little = !(flags & 2);
    const isFloat = flags & 1;
    const isSigned = flags & 4;
    const nonInterleaved = flags & 32;
    channels = be32(b, at + 12);
    sampleRate = new DataView(b.buffer, b.byteOffset + at + 4, 8).getFloat64(0, false);
    if (nonInterleaved || be32(b, at + 28) !== (channels * bits) / 8) return null;
    if (isFloat) kind = { 32: 'float32', 64: 'float64' }[bits];
    else if (bits === 8) kind = isSigned ? 'int8' : 'uint8';
    else kind = { 16: 'int16', 24: 'int24', 32: 'int32' }[bits];
    if (kind && !/^(u?int8)$/.test(kind)) kind += little ? 'le' : 'be';
  }

  const reader = SAMPLE_READERS[kind];
  if (!reader || !(channels >= 1 && channels <= 32) || !(sampleRate >= 1)) return null;
  return { reader, kind, channels, sampleRate, frameBytes: reader.bytes * channels };
};

/**
 * The byte ranges of the chunks of a track from its raw sample table:
 * `stsc` (samples per chunk), `stco`/`co64` (where each chunk starts) and a
 * constant sample size from `stsz`. `[{ offset, bytes }]`
 */
const readChunks = (b, track) => {
  const { stbl } = track;
  const stsz = childOf(b, stbl, 'stsz');
  const stsc = childOf(b, stbl, 'stsc');
  const stco = childOf(b, stbl, 'stco');
  const co64 = childOf(b, stbl, 'co64');
  if (!stsz || !stsc || !(stco || co64)) throw new Mp4AudioError('mp4-invalid');

  const sampleSize = be32(b, stsz.start + stsz.headerSize + 4);
  if (sampleSize === 0) {
    // One size per sample: PCM is not written that way
    throw new Mp4AudioError('mp4-unsupported-layout');
  }

  const offsetsBox = stco || co64;
  const offsetsAt = offsetsBox.start + offsetsBox.headerSize;
  const chunkCount = be32(b, offsetsAt + 4);
  if (chunkCount > MAX_CHUNKS) throw new Mp4AudioError('mp4-unsupported-layout');
  const wide = Boolean(co64);
  if (offsetsAt + 8 + chunkCount * (wide ? 8 : 4) > offsetsBox.end) {
    throw new Mp4AudioError('mp4-invalid');
  }

  const runsAt = stsc.start + stsc.headerSize;
  const runCount = be32(b, runsAt + 4);
  if (runsAt + 8 + runCount * 12 > stsc.end) throw new Mp4AudioError('mp4-invalid');

  const chunks = [];
  for (let run = 0; run < runCount; run++) {
    const entryAt = runsAt + 8 + run * 12;
    const first = be32(b, entryAt);
    const samplesPerChunk = be32(b, entryAt + 4);
    const descriptionIndex = be32(b, entryAt + 8);
    // A track mixing sample descriptions would mix sample formats
    if (descriptionIndex !== 1) throw new Mp4AudioError('mp4-unsupported-layout');
    const last = run + 1 < runCount ? be32(b, entryAt + 12) - 1 : chunkCount;
    for (let chunk = first; chunk <= last && chunk <= chunkCount; chunk++) {
      const at = offsetsAt + 8 + (chunk - 1) * (wide ? 8 : 4);
      chunks.push({
        offset: wide ? be64(b, at) : be32(b, at),
        bytes: samplesPerChunk * sampleSize
      });
    }
  }
  return chunks;
};

/** Pieces of at most `maxBytes`, each a whole number of frames. */
export const splitIntoFrames = (chunks, frameBytes, maxBytes = MAX_READ_BYTES) => {
  const piece = Math.max(frameBytes, Math.floor(maxBytes / frameBytes) * frameBytes);
  const pieces = [];
  for (const chunk of chunks) {
    const bytes = chunk.bytes - (chunk.bytes % frameBytes);
    for (let done = 0; done < bytes; done += piece) {
      pieces.push({ offset: chunk.offset + done, bytes: Math.min(piece, bytes - done) });
    }
  }
  return pieces;
};

/**
 * Samples → one mono channel (the mean of all channels), written to
 * `out[outIndex...]`. Returns the number of frames written.
 */
export const convertPcmToMono = (view, byteOffset, bytes, layout, out, outIndex) => {
  const { reader, channels, frameBytes } = layout;
  const frames = Math.floor(bytes / frameBytes);
  const { read, bytes: sampleBytes } = reader;
  let position = byteOffset;
  if (channels === 1) {
    for (let frame = 0; frame < frames; frame++, position += sampleBytes) {
      out[outIndex + frame] = read(view, position);
    }
  } else {
    for (let frame = 0; frame < frames; frame++, position += frameBytes) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) {
        sum += read(view, position + channel * sampleBytes);
      }
      out[outIndex + frame] = sum / channels;
    }
  }
  return frames;
};

// ------------------------------------------------------------ AAC

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
  }

  read(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.position >> 3];
      if (byte === undefined) throw new Mp4AudioError('mp4-invalid');
      value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1);
      this.position++;
    }
    return value;
  }
}

/**
 * What an AudioSpecificConfig (the `esds` of an AAC track) says that an ADTS
 * header needs. `objectType` is that of the AAC core: HE-AAC (5) and HE-AACv2
 * (29) wrap an AAC-LC core, which is what ADTS describes (the decoder finds the
 * SBR extension in the frames), and `sampleRate` is that of the core too. The
 * rate the player ends up with is `outputSampleRate`.
 */
export const parseAudioSpecificConfig = config => {
  const bits = new BitReader(config);
  const objectType = () => {
    const type = bits.read(5);
    return type === 31 ? 32 + bits.read(6) : type;
  };
  const frequency = () => {
    const index = bits.read(4);
    if (index === 15) return bits.read(24);
    if (index >= AAC_SAMPLE_RATES.length) throw new Mp4AudioError('mp4-invalid');
    return AAC_SAMPLE_RATES[index];
  };

  let type = objectType();
  const sampleRate = frequency();
  const channelConfig = bits.read(4);
  let outputSampleRate = sampleRate;
  const sbr = type === 5 || type === 29;
  if (sbr) {
    outputSampleRate = frequency();
    type = objectType();
  }
  return { objectType: type, sampleRate, channelConfig, sbr, outputSampleRate };
};

/**
 * The 7-byte ADTS header (MPEG-4, no CRC) of a raw AAC frame of
 * `payloadBytes`, written to `out[at...]`.
 */
export const writeAdtsHeader = (out, at, config, payloadBytes) => {
  const frameLength = payloadBytes + 7;
  const profile = config.objectType - 1;
  out[at] = 0xff;
  out[at + 1] = 0xf1;
  out[at + 2] = (profile << 6) | (config.samplingIndex << 2) | (config.channelConfig >> 2);
  out[at + 3] = ((config.channelConfig & 3) << 6) | (frameLength >> 11);
  out[at + 4] = (frameLength >> 3) & 0xff;
  out[at + 5] = ((frameLength & 7) << 5) | 0x1f; // buffer fullness: VBR
  out[at + 6] = 0xfc; // ... and one raw data block per frame
  return out;
};

/** The ADTS parameters of an AAC track, or an error saying why it has none. */
const adtsConfigOf = (asc, channelCount) => {
  const config = parseAudioSpecificConfig(asc);
  // ADTS can describe AAC Main, LC, SSR and LTP (profile = object type - 1)
  if (config.objectType < 1 || config.objectType > 4) {
    throw new Mp4AudioError('mp4-unsupported-codec', { codec: `mp4a.40.${config.objectType}` });
  }
  const samplingIndex = AAC_SAMPLE_RATES.indexOf(config.sampleRate);
  if (samplingIndex < 0) {
    throw new Mp4AudioError('mp4-unsupported-codec', { codec: `${config.sampleRate} Hz` });
  }
  let { channelConfig } = config;
  // 0: the layout is in a program config element, which ADTS frames do not carry
  if (channelConfig < 1 || channelConfig > 7) channelConfig = ADTS_CHANNEL_CONFIG[channelCount];
  if (!channelConfig) {
    throw new Mp4AudioError('mp4-unsupported-layout');
  }
  return { ...config, samplingIndex, channelConfig };
};

/**
 * `moov` cut down to the one track: `ftyp` + `moov` { `mvhd`, `trak` }. mp4box.js
 * builds an object per sample of every track it is given, 54,000 of them for
 * the picture of half an hour of video, which the audio does not need.
 */
const trimIndex = (b, moov, track, ftypBytes, isQuickTime) => {
  const mvhd = childOf(b, moov, 'mvhd');
  if (!mvhd) throw new Mp4AudioError('mp4-invalid');
  const parts = [b.subarray(mvhd.start, mvhd.end), b.subarray(track.trak.start, track.trak.end)];
  const moovBytes = parts.reduce((sum, part) => sum + part.length, 8);
  let ftyp = ftypBytes;
  if (!ftyp) {
    // A QuickTime file may have none; mp4box.js wants one
    ftyp = new Uint8Array(20);
    new DataView(ftyp.buffer).setUint32(0, 20);
    ftyp.set(new TextEncoder().encode(isQuickTime ? 'ftypqt  ' : 'ftypisom'), 4);
  }
  const out = new Uint8Array(ftyp.length + moovBytes);
  out.set(ftyp, 0);
  new DataView(out.buffer).setUint32(ftyp.length, moovBytes);
  out.set(new TextEncoder().encode('moov'), ftyp.length + 4);
  let at = ftyp.length + 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
};

/** Search the children of a box (the `esds` of a QuickTime `mp4a` is in a `wave`). */
const findBox = (box, type) => {
  for (const child of box.boxes || []) {
    if (child.type === type) return child;
    const nested = findBox(child, type);
    if (nested) return nested;
  }
  return undefined;
};

/** Sample table and AudioSpecificConfig of an AAC track, from mp4box.js. */
const readAacTable = async (trimmed, trackId, channelCount) => {
  const { createFile, MP4BoxBuffer } = await import('mp4box');
  const iso = createFile(false);
  let ready = false;
  let failure = null;
  iso.onReady = () => {
    ready = true;
  };
  iso.onError = (module, message) => {
    failure = failure || message;
  };
  try {
    iso.appendBuffer(MP4BoxBuffer.fromArrayBuffer(trimmed, 0), true);
  } catch (error) {
    // A sample entry or table it cannot make sense of
    throw new Mp4AudioError('mp4-invalid', { detail: error.message });
  }
  const trak = iso.getTrackById(trackId);
  if (!ready || !trak) throw new Mp4AudioError('mp4-invalid', { detail: failure });

  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const esds = entry.esds ?? findBox(entry, 'esds');
  const config = esds?.esd?.findDescriptor(4)?.findDescriptor(5)?.data;
  const objectTypeIndication = esds?.esd?.getOTI();
  if (
    !config ||
    (objectTypeIndication !== 0x40 &&
      !(objectTypeIndication >= 0x66 && objectTypeIndication <= 0x68))
  ) {
    throw new Mp4AudioError('mp4-unsupported-codec', {
      codec: esds ? `mp4a.${objectTypeIndication?.toString(16)}` : 'mp4a'
    });
  }

  const samples = iso.getTrackSamplesInfo(trackId) || [];
  const offsets = new Float64Array(samples.length);
  const sizes = new Uint32Array(samples.length);
  samples.forEach((sample, index) => {
    offsets[index] = sample.offset;
    sizes[index] = sample.size;
  });
  return { offsets, sizes, adts: adtsConfigOf(config, channelCount) };
};

// ------------------------------------------------------------ reading

/**
 * Group items (their byte ranges in the file, in order) into reads: an item
 * joins the read before it while it lies ahead of it by at most `maxGap` bytes
 * and the read stays within `maxRead`. A read is `{ start, end, first, last }`,
 * covering the items `first` up to (not including) `last`.
 */
export const planReads = (
  offsets,
  sizes,
  { maxRead = MAX_READ_BYTES, maxGap = MAX_GAP_BYTES } = {}
) => {
  const reads = [];
  let current = null;
  for (let index = 0; index < offsets.length; index++) {
    const start = offsets[index];
    const end = start + sizes[index];
    if (
      current &&
      start >= current.end &&
      start - current.end <= maxGap &&
      end - current.start <= maxRead
    ) {
      current.end = end;
      current.last = index + 1;
    } else {
      current = { start, end, first: index, last: index + 1 };
      reads.push(current);
    }
  }
  return reads;
};

/**
 * Read `reads` with `READ_AHEAD` of them in flight, handing each to `consume`
 * in order. `onBytes(total)` reports what has been read.
 */
const readInOrder = async (file, reads, { signal, consume, onBytes }) => {
  const queue = [];
  let next = 0;
  let done = 0;
  const fill = () => {
    while (queue.length < READ_AHEAD && next < reads.length) {
      const read = reads[next++];
      const pending = readSlice(file, read.start, read.end, signal).then(buffer => ({
        read,
        buffer
      }));
      // Reported where it is awaited, not here
      pending.catch(() => {});
      queue.push(pending);
    }
  };
  fill();
  while (queue.length) {
    const { read, buffer } = await queue.shift();
    throwIfAborted(signal);
    fill();
    consume(read, buffer);
    done += read.end - read.start;
    onBytes?.(done);
  }
};

/** An AudioBuffer-shaped holder of mono floats, where there is no AudioContext. */
const plainBuffer = (length, sampleRate) => {
  const data = new Float32Array(length);
  return {
    numberOfChannels: 1,
    sampleRate,
    length,
    duration: length / sampleRate,
    getChannelData: () => data
  };
};

/**
 * Read the audio of an MP4/MOV/M4A file.
 *
 * @param {File} file
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Stops at the next read, rejecting with
 *   the abort error (see `abortable.js`)
 * @param {(percent: number) => void} [options.onProgress] - 0-100 by bytes read
 *   (index and audio), never going down
 * @param {number} [options.maxReadBytes] - The most one read asks the file for
 *   (8 MB; smaller only to test reading in several steps)
 * @param {(length: number, sampleRate: number) => AudioBuffer} [options.createPcmBuffer] -
 *   Where PCM is written to: a mono buffer. `audioContext.createBuffer(1, ...)`
 *   makes one the Web Audio API can resample, which a plain buffer is not
 * @returns {Promise<{kind: 'aac', blob: Blob, codec: string, sampleRate: number,
 *   channels: number, duration: number} | {kind: 'pcm', buffer: AudioBuffer,
 *   codec: string, sampleRate: number, channels: number, duration: number}>}
 * @throws {Mp4AudioError} when this reader cannot take the file
 */
export const readMp4Audio = async (
  file,
  { signal, onProgress, createPcmBuffer = plainBuffer, maxReadBytes = MAX_READ_BYTES } = {}
) => {
  let lastPercent = -1;
  const report = (done, total) => {
    const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    if (percent > lastPercent) {
      lastPercent = percent;
      onProgress?.(percent);
    }
  };

  throwIfAborted(signal);
  report(0, 1);
  const { moov: moovHeader, ftyp: ftypHeader } = await locateIndex(file, signal);
  if (moovHeader.size > MAX_MOOV_BYTES) throw new Mp4AudioError('mp4-too-large');

  // The index, in reads of at most maxReadBytes
  const index = new Uint8Array(moovHeader.size);
  let indexRead = 0;
  while (indexRead < index.length) {
    throwIfAborted(signal);
    const end = Math.min(index.length, indexRead + maxReadBytes);
    const part = await readSlice(
      file,
      moovHeader.start + indexRead,
      moovHeader.start + end,
      signal
    );
    index.set(new Uint8Array(part), indexRead);
    indexRead = end;
  }
  let ftypBytes = null;
  if (ftypHeader) {
    if (ftypHeader.size > MAX_FTYP_BYTES) throw new Mp4AudioError('mp4-invalid');
    ftypBytes = new Uint8Array(
      await readSlice(file, ftypHeader.start, ftypHeader.start + ftypHeader.size, signal)
    );
  }
  const brand = ftypBytes ? fourcc(ftypBytes, 8) : null;
  // Without an ftyp it is an old QuickTime file
  const isQuickTime = brand === null || brand.startsWith('qt');

  const moov = { start: 0, headerSize: moovHeader.headerSize, end: index.length };
  const tracks = describeTracks(index, moov, isQuickTime);
  const audioTracks = tracks.filter(track => track.handler === 'soun');
  if (!audioTracks.length) throw new Mp4AudioError('mp4-no-audio-track');
  if (boxesIn(index, moov.start + moov.headerSize, moov.end).some(box => box.type === 'mvex')) {
    // The samples are in `moof` boxes between the `mdat`s: nothing here lists them
    const empty = audioTracks.every(track => {
      const stsz = childOf(index, track.stbl, 'stsz');
      return !stsz || be32(index, stsz.start + stsz.headerSize + 8) === 0;
    });
    if (empty) throw new Mp4AudioError('mp4-fragmented');
  }

  const track = audioTracks.find(
    candidate => candidate.format === 'mp4a' || describePcm(index, candidate)
  );
  if (!track) {
    throw new Mp4AudioError('mp4-unsupported-codec', { codec: audioTracks[0].format });
  }

  const total = { value: index.length };
  const progressOf = bytes => report(index.length + bytes, total.value);

  // ---- PCM: the samples straight into floats
  const pcm = track.format === 'mp4a' ? null : describePcm(index, track);
  if (pcm) {
    const pieces = splitIntoFrames(readChunks(index, track), pcm.frameBytes, maxReadBytes);
    const frames = pieces.reduce((sum, piece) => sum + piece.bytes / pcm.frameBytes, 0);
    if (!frames) throw new Mp4AudioError('mp4-invalid');
    if (frames * 4 > MAX_PCM_BYTES) throw new Mp4AudioError('mp4-too-large');
    const reads = planReads(
      pieces.map(piece => piece.offset),
      pieces.map(piece => piece.bytes),
      { maxRead: maxReadBytes }
    );
    total.value += reads.reduce((sum, read) => sum + read.end - read.start, 0);
    report(index.length, total.value);

    const buffer = createPcmBuffer(frames, pcm.sampleRate);
    const samples = buffer.getChannelData(0);
    let written = 0;
    await readInOrder(file, reads, {
      signal,
      onBytes: progressOf,
      consume: (read, data) => {
        const view = new DataView(data);
        for (let i = read.first; i < read.last; i++) {
          written += convertPcmToMono(
            view,
            pieces[i].offset - read.start,
            pieces[i].bytes,
            pcm,
            samples,
            written
          );
        }
      }
    });
    return {
      kind: 'pcm',
      buffer,
      codec: track.format,
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      duration: frames / pcm.sampleRate
    };
  }

  // ---- AAC: raw frames in ADTS
  const stsz = childOf(index, track.stbl, 'stsz');
  if (stsz && be32(index, stsz.start + stsz.headerSize + 8) > MAX_AAC_SAMPLES) {
    throw new Mp4AudioError('mp4-too-large');
  }
  const trimmed = trimIndex(index, moov, track, ftypBytes, isQuickTime);
  const table = await readAacTable(trimmed, track.id, track.sound?.channels);
  const { offsets, sizes, adts } = table;
  if (!offsets.length) throw new Mp4AudioError('mp4-invalid');
  for (const size of sizes) {
    if (size + 7 > 8191) throw new Mp4AudioError('mp4-unsupported-layout');
  }
  const reads = planReads(offsets, sizes, { maxRead: maxReadBytes });
  total.value += reads.reduce((sum, read) => sum + read.end - read.start, 0);
  report(index.length, total.value);

  const parts = [];
  await readInOrder(file, reads, {
    signal,
    onBytes: progressOf,
    consume: (read, data) => {
      const source = new Uint8Array(data);
      let bytes = 0;
      for (let i = read.first; i < read.last; i++) bytes += sizes[i] + 7;
      const out = new Uint8Array(bytes);
      let at = 0;
      for (let i = read.first; i < read.last; i++) {
        const from = offsets[i] - read.start;
        writeAdtsHeader(out, at, adts, sizes[i]);
        out.set(source.subarray(from, from + sizes[i]), at + 7);
        at += sizes[i] + 7;
      }
      parts.push(out);
    }
  });
  return {
    kind: 'aac',
    blob: new Blob(parts, { type: 'audio/aac' }),
    codec: `mp4a.40.${adts.objectType}`,
    sampleRate: adts.outputSampleRate,
    channels: track.sound?.channels,
    // An AAC frame is 1024 samples of the core's rate (before any SBR)
    duration: (offsets.length * 1024) / adts.sampleRate
  };
};
