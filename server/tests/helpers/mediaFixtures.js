// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Synthetic image and audio fixtures for the provenance tests (#3328), built in
 * code so no binary and no third-party licence is committed. The one real signed
 * file is the upstream c2pa-rs `C.jpg` in `tests/fixtures/provenance/`.
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A valid 1x1 PNG, optionally with extra chunks before IDAT.
 *
 * @param {Array<{type: string, data: Buffer}>} [extra]
 * @param {number} [shade] - Grey value, to make distinct images.
 */
export function makePng(extra = [], shade = 128) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const idat = deflateSync(Buffer.from([0, shade]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra.map(chunk => pngChunk(chunk.type, chunk.data)),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** A PNG with a hand-built `caBX` chunk: presence only, not a signed manifest. */
export function makePngWithCaBX(shade = 99) {
  return makePng([{ type: 'caBX', data: Buffer.from('\0\0\0\x10jumb\0\0\0\x08jumd') }], shade);
}

// The IPTC digital source type is an identifier that happens to be written as an
// http:// URI; it is never fetched. Built from parts so the literal is not a link.
const SOURCE_TYPE = [
  'http:',
  '',
  'cv.iptc.org',
  'newscodes',
  'digitalsourcetype',
  'trainedAlgorithmicMedia'
].join('/');

/** A minimal JPEG whose APP1 carries an XMP packet with `DigitalSourceType`. */
export function makeJpegWithXmp(sourceType = SOURCE_TYPE) {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="${sourceType}"/></rdf:RDF></x:xmpmeta>`;
  const payload = Buffer.concat([
    Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
    Buffer.from(xmp)
  ]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    payload,
    Buffer.from([0xff, 0xd9, 0, 0, 0, 0])
  ]);
}

/** A JPEG with no metadata at all. */
export function makePlainJpeg() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
    Buffer.from([0xff, 0xd9, 0, 0, 0, 0])
  ]);
}

/** `seconds` of silent-ish `pcm_s16le` at `rate` Hz, mono; `seed` varies the signal. */
export function makePcm(seconds = 1, rate = 24000, seed = 1) {
  const pcm = Buffer.alloc(seconds * rate * 2);
  for (let i = 0; i < seconds * rate; i += 1) pcm.writeInt16LE((i * seed) % 2000, i * 2);
  return pcm;
}

/** A canonical 44-byte-header WAV around `pcm`, plus optional extra RIFF chunks before `data`. */
export function makeWav(pcm, { rate = 24000, extra = [] } = {}) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id, data) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    chunk('fmt ', fmt),
    ...extra.map(c => chunk(c.id, c.data)),
    chunk('data', pcm)
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** A WAV carrying a `C2PA` chunk (presence only). */
export function makeWavWithC2pa(pcm = makePcm(0.1)) {
  return makeWav(pcm, { extra: [{ id: 'C2PA', data: Buffer.from('jumb') }] });
}

/** The upstream c2pa-rs signed fixture (Adobe, MIT OR Apache-2.0). */
export function readSignedJpeg() {
  return readFileSync(fileURLToPath(new URL('../fixtures/provenance/C.jpg', import.meta.url)));
}

/** Flip one byte inside the image data: the negative control. */
export function flipByte(buffer, at = 60000) {
  const copy = Buffer.from(buffer);
  copy[at] ^= 0xff;
  return copy;
}

export { SOURCE_TYPE };
