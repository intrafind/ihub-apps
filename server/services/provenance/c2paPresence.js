// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Presence-only C2PA detection, with no dependency (#3328).
 *
 * The fallback when the WebAssembly reader cannot load or fails on a file. It
 * answers "does this file carry a C2PA manifest (or a reference to one)?" by
 * walking the container, and reads `Iptc4xmpExt:DigitalSourceType` from the XMP
 * packet as plain text. It never validates a signature: `validated` is always
 * false and `issuer` null.
 *
 * Containers: JPEG (APP11 JUMBF segments), PNG (`caBX` chunk), RIFF/WebP/WAV
 * (`C2PA` chunk), ISOBMFF/HEIC/AVIF/M4A (`uuid` box
 * d8fec3d6-1b0e-483c-9297-5828877ec481).
 *
 * @module services/provenance/c2paPresence
 */

const ISOBMFF_C2PA_UUID = Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex');

const XMP_SOURCE_TYPE = /DigitalSourceType(?:=["']|>\s*)(https?:\/\/[^"'<\s]+)/;

/** The IPTC digital source type named by an XMP packet, or null. */
export function digitalSourceTypeFromXmp(xmp) {
  const match = XMP_SOURCE_TYPE.exec(xmp);
  return match ? match[1] : null;
}

function jpeg(buffer) {
  let offset = 2;
  let c2pa = false;
  let xmp = null;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const start = offset + 4;
    const end = Math.min(offset + 2 + length, buffer.length);
    if (marker === 0xeb && buffer.toString('latin1', start, start + 2) === 'JP') {
      // 'JP' + en(2) + seq(4) + JUMBF box: LBox(4) TBox('jumb')
      // The first JUMBF box is the manifest store: its `jumd` type UUID starts
      // with the ASCII bytes "c2pa" (other JUMBF payloads, e.g. JPEG 360, do not).
      if (
        buffer.toString('latin1', start + 12, start + 16) === 'jumb' &&
        buffer.subarray(start + 16, Math.min(end, start + 64)).includes('c2pa')
      ) {
        c2pa = true;
      }
    } else if (
      marker === 0xe1 &&
      buffer.toString('latin1', start, start + 28).startsWith('http://ns.adobe.com/xap/1.0/')
    ) {
      xmp = buffer.toString('utf8', start + 29, end);
    }
    offset += 2 + length;
  }
  return { c2pa, xmp };
}

function png(buffer) {
  let offset = 8;
  let c2pa = false;
  let xmp = null;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (type === 'caBX') c2pa = true;
    if (type === 'iTXt' && buffer.toString('latin1', start, start + 17) === 'XML:com.adobe.xmp') {
      xmp = buffer.toString('utf8', start, Math.min(start + length, buffer.length));
    }
    if (type === 'IEND') break;
    offset = start + length + 4;
  }
  return { c2pa, xmp };
}

function riff(buffer) {
  let offset = 12;
  let c2pa = false;
  let xmp = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'C2PA') c2pa = true;
    if (id === 'XMP ') xmp = buffer.toString('utf8', start, Math.min(start + size, buffer.length));
    if (size > buffer.length) break;
    offset = start + size + (size % 2);
  }
  return { c2pa, xmp };
}

function isobmff(buffer) {
  let offset = 0;
  let c2pa = false;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1 && offset + 16 <= buffer.length) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < header) break;
    if (
      type === 'uuid' &&
      buffer.subarray(offset + header, offset + header + 16).equals(ISOBMFF_C2PA_UUID)
    ) {
      c2pa = true;
    }
    offset += size;
  }
  return { c2pa, xmp: null };
}

/**
 * Presence of a C2PA manifest, from the container structure alone.
 *
 * @param {Buffer} buffer
 * @param {string} container - `sniffMedia(...).container`.
 * @returns {{present: boolean, validated: false, issuer: null, digitalSourceType: string|null, supported: boolean}}
 */
export function detectC2paPresence(buffer, container) {
  let found = null;
  try {
    if (container === 'jpeg') found = jpeg(buffer);
    else if (container === 'png') found = png(buffer);
    else if (container === 'webp' || container === 'wav') found = riff(buffer);
    else if (container === 'heic' || container === 'avif' || container === 'm4a') {
      found = isobmff(buffer);
    }
  } catch {
    found = null;
  }
  return {
    present: Boolean(found?.c2pa),
    validated: false,
    issuer: null,
    digitalSourceType: found?.xmp ? digitalSourceTypeFromXmp(found.xmp) : null,
    supported: found !== null
  };
}
