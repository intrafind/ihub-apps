/**
 * Minimal image plumbing for marking: decode PNG/JPEG to RGB pixels, encode
 * pixels back in the same format, and embed an XMP packet with the IPTC
 * `DigitalSourceType` (the metadata fallback for tools that do not read C2PA).
 *
 * Pure JS (pngjs, jpeg-js) so it runs on every platform the server runs on.
 *
 * @module services/provenance/image/imageFormats
 */
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { DIGITAL_SOURCE_TYPES } from '../../../../shared/aiTransparency.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XMP_JPEG_NS = 'http://ns.adobe.com/xap/1.0/\0';

/** MIME type sniffed from the bytes (the declared type can be wrong). */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

/** Whether the pixel watermark can round-trip this format. */
export function supportsPixelWatermark(mimeType) {
  return mimeType === 'image/png' || mimeType === 'image/jpeg';
}

/**
 * Decode to RGB (3 bytes per pixel).
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {{width: number, height: number, rgb: Buffer}}
 */
export function decodeRgb(buffer, mimeType) {
  let width;
  let height;
  let rgba;
  if (mimeType === 'image/png') {
    const png = PNG.sync.read(buffer);
    ({ width, height } = png);
    rgba = png.data;
  } else if (mimeType === 'image/jpeg') {
    const img = jpeg.decode(buffer, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 1024
    });
    ({ width, height } = img);
    rgba = Buffer.from(img.data);
  } else {
    throw new Error(`Cannot decode ${mimeType}`);
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { width, height, rgb };
}

/**
 * Encode RGB pixels.
 * @param {{width: number, height: number, rgb: Buffer}} image
 * @param {string} mimeType
 * @param {{quality?: number}} [opts]
 * @returns {Buffer}
 */
export function encodeRgb({ width, height, rgb }, mimeType, { quality = 95 } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    rgba[i] = rgb[j];
    rgba[i + 1] = rgb[j + 1];
    rgba[i + 2] = rgb[j + 2];
    rgba[i + 3] = 255;
  }
  if (mimeType === 'image/jpeg') {
    return jpeg.encode({ width, height, data: rgba }, quality).data;
  }
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  return PNG.sync.write(png);
}

function xmlEscape(value) {
  return String(value).replace(
    /[<>&"']/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  );
}

/**
 * An XMP packet declaring the content AI-generated.
 * @param {{creatorTool: string, createdAt?: string, description?: string, contentId?: string}} fields
 */
export function buildXmpPacket({
  creatorTool,
  createdAt = new Date().toISOString(),
  description = 'AI-generated image',
  contentId
}) {
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:ihub="https://ihub.intrafind.com/ns/provenance/1.0/">',
    `   <Iptc4xmpExt:DigitalSourceType>${DIGITAL_SOURCE_TYPES.trainedAlgorithmicMedia}</Iptc4xmpExt:DigitalSourceType>`,
    `   <xmp:CreatorTool>${xmlEscape(creatorTool)}</xmp:CreatorTool>`,
    `   <xmp:CreateDate>${xmlEscape(createdAt)}</xmp:CreateDate>`,
    `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(description)}</rdf:li></rdf:Alt></dc:description>`,
    contentId ? `   <ihub:contentId>${xmlEscape(contentId)}</ihub:contentId>` : null,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>'
  ]
    .filter(Boolean)
    .join('\n');
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function hasPngXmp(buffer) {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (
      type === 'iTXt' &&
      buffer.toString('latin1', offset + 8, offset + 8 + 17) === 'XML:com.adobe.xmp'
    ) {
      return true;
    }
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

function hasJpegXmp(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) return false;
    const length = buffer.readUInt16BE(offset + 2);
    if (
      marker === 0xe1 &&
      buffer.toString('latin1', offset + 4, offset + 4 + XMP_JPEG_NS.length) === XMP_JPEG_NS
    ) {
      return true;
    }
    offset += 2 + length;
  }
  return false;
}

/**
 * Embed an XMP packet. An image that already carries XMP keeps its own
 * (upstream metadata is preserved, CoP Measure 1.2); the C2PA manifest then
 * carries the declaration.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} xmp
 * @returns {{buffer: Buffer, embedded: boolean}}
 */
export function embedXmp(buffer, mimeType, xmp) {
  if (mimeType === 'image/png') {
    if (hasPngXmp(buffer)) return { buffer, embedded: false };
    // iTXt: keyword \0 compression-flag compression-method language \0 translated \0 text
    const data = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp\0', 'latin1'),
      Buffer.from([0, 0]),
      Buffer.from('\0\0', 'latin1'),
      Buffer.from(xmp, 'utf8')
    ]);
    // Insert right after IHDR (first chunk: 8-byte signature + 25-byte IHDR chunk).
    const ihdrEnd = 8 + 12 + buffer.readUInt32BE(8);
    return {
      buffer: Buffer.concat([
        buffer.subarray(0, ihdrEnd),
        pngChunk('iTXt', data),
        buffer.subarray(ihdrEnd)
      ]),
      embedded: true
    };
  }
  if (mimeType === 'image/jpeg') {
    if (hasJpegXmp(buffer)) return { buffer, embedded: false };
    const payload = Buffer.concat([Buffer.from(XMP_JPEG_NS, 'latin1'), Buffer.from(xmp, 'utf8')]);
    if (payload.length + 2 > 0xffff) return { buffer, embedded: false };
    const segment = Buffer.alloc(4);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment.writeUInt16BE(payload.length + 2, 2);
    // After SOI and an APP0 (JFIF) segment if present.
    let insertAt = 2;
    if (buffer[2] === 0xff && buffer[3] === 0xe0) insertAt = 4 + buffer.readUInt16BE(4);
    return {
      buffer: Buffer.concat([
        buffer.subarray(0, insertAt),
        segment,
        payload,
        buffer.subarray(insertAt)
      ]),
      embedded: true
    };
  }
  return { buffer, embedded: false };
}

/**
 * Read the XMP packet of a PNG or JPEG, if any.
 * @param {Buffer} buffer
 * @returns {string|null}
 */
export function readXmp(buffer) {
  const type = sniffImageType(buffer);
  const text = buffer.toString('latin1');
  const start = text.indexOf('<x:xmpmeta');
  if (start === -1 || (type !== 'image/png' && type !== 'image/jpeg')) return null;
  const end = text.indexOf('</x:xmpmeta>', start);
  if (end === -1) return null;
  return Buffer.from(text.slice(start, end + 12), 'latin1').toString('utf8');
}
