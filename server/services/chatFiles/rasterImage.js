// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the server accepts as the image of a chat message.
 *
 * A picture a user attached is sent inline as a data URL and stored so its thumbnail survives a
 * reload. It is served back inline from the application's own origin, so only a raster format
 * that a browser cannot run anything from is accepted (never SVG), and the type is read from the
 * bytes, not taken from what the client said.
 *
 * @module services/chatFiles/rasterImage
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The raster types stored, with the signature that proves each one. */
const SIGNATURES = [
  { mime: 'image/png', test: b => b.length > 8 && b.subarray(0, 8).equals(PNG) },
  {
    mime: 'image/jpeg',
    test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  { mime: 'image/gif', test: b => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
  {
    mime: 'image/webp',
    test: b =>
      b.length > 12 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP'
  },
  { mime: 'image/bmp', test: b => b.length > 14 && b[0] === 0x42 && b[1] === 0x4d }
];
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i;

/**
 * The raster media type of some bytes, or `null` when they are not a PNG, JPEG, GIF, WebP or
 * BMP image.
 *
 * @param {Buffer} bytes
 * @returns {string|null}
 */
export function sniffRasterImage(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  return SIGNATURES.find(signature => signature.test(bytes))?.mime ?? null;
}

/**
 * The bytes and media type of an image data URL, or `null` when it is not an image of a type
 * {@link sniffRasterImage} knows. The type returned is the one the bytes show.
 *
 * @param {unknown} dataUrl
 * @returns {{bytes: Buffer, mimeType: string}|null}
 */
export function decodeRasterDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  const mimeType = sniffRasterImage(bytes);
  return mimeType ? { bytes, mimeType } : null;
}
