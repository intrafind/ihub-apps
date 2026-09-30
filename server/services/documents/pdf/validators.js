/**
 * Validation shared by the Markdown converter and the layout-block sanitiser.
 *
 * Everything a document references is inline: images are `data:` URIs, SVG
 * is markup, links are only ever annotations. Nothing here resolves a path
 * or fetches a URL, and the renderer denies both anyway (see `renderPdf.js`).
 */

export const LIMITS = Object.freeze({
  /** Largest single image, decoded. */
  maxImageBytes: 5 * 1024 * 1024,
  /** All images of one document together, decoded. */
  maxTotalImageBytes: 15 * 1024 * 1024,
  /** Largest SVG, as markup. */
  maxSvgChars: 500_000,
  /** Nodes in the layout tree after Markdown is expanded. */
  maxNodes: 50_000,
  /** Nesting depth of layout blocks. */
  maxDepth: 40,
  /** Characters in one text string. */
  maxTextChars: 200_000,
  /** Rows in one table. */
  maxTableRows: 5_000
});

const IMAGE_DATA_URI = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i;

/**
 * Check an image source and return the bytes it decodes to.
 *
 * Only PNG and JPEG `data:` URIs are accepted, and the decoded bytes must
 * start with the matching signature — pdfkit would otherwise fail the whole
 * document on one broken picture.
 *
 * @param {unknown} src
 * @returns {{ ok: true, dataUri: string, bytes: number } | { ok: false, reason: string }}
 */
export function checkImageDataUri(src) {
  if (typeof src !== 'string') return { ok: false, reason: 'not a string' };
  const match = IMAGE_DATA_URI.exec(src.trim());
  if (!match) {
    return {
      ok: false,
      reason: 'only data:image/png or data:image/jpeg base64 URIs are supported'
    };
  }
  const base64 = match[2].replace(/\s+/g, '');
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > LIMITS.maxImageBytes) return { ok: false, reason: 'image too large' };
  const head = Buffer.from(base64.slice(0, 16), 'base64');
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const wantsPng = match[1].toLowerCase() === 'png';
  if ((wantsPng && !isPng) || (!wantsPng && !isJpeg)) {
    return { ok: false, reason: 'image data does not match its declared type' };
  }
  return { ok: true, dataUri: `data:image/${wantsPng ? 'png' : 'jpeg'};base64,${base64}`, bytes };
}

/**
 * Pixel size of an accepted PNG/JPEG data URI, read from its header.
 *
 * @param {string} dataUri - A URI that passed {@link checkImageDataUri}.
 * @returns {{ width: number, height: number } | null}
 */
export function imagePixelSize(dataUri) {
  const comma = dataUri.indexOf(',');
  if (comma < 0) return null;
  const isPng = dataUri.startsWith('data:image/png');
  // The header is near the start; JPEG may carry EXIF/ICC blocks before its
  // frame header, so it gets a larger window.
  const window = dataUri.slice(comma + 1, comma + 1 + (isPng ? 64 : 262144));
  const bytes = Buffer.from(window.slice(0, window.length - (window.length % 4)), 'base64');
  if (isPng) {
    if (bytes.length < 24) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function svgLength(value) {
  const match = /^\s*([\d.]+)\s*(px|pt)?\s*$/i.exec(String(value ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Size of an SVG from its root element: `width`/`height`, else `viewBox`.
 *
 * @param {string} svg
 * @returns {{ width: number, height: number } | null}
 */
export function svgSize(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const attr = name => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  const width = svgLength(attr('width'));
  const height = svgLength(attr('height'));
  if (width && height) return { width, height };
  const viewBox = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return null;
}

/**
 * pdfmake sizing for a picture: its natural size, scaled down (never up) to
 * fit the text column and at most `maxHeightShare` of the page height.
 *
 * @param {{ width: number, height: number } | null} natural - In points.
 * @param {number} contentWidth
 * @param {number} contentHeight
 * @param {number} [maxHeightShare]
 * @returns {{ width: number } | { fit: [number, number] }}
 */
export function fitWithin(natural, contentWidth, contentHeight, maxHeightShare = 0.6) {
  const maxHeight = contentHeight * maxHeightShare;
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) {
    return { fit: [contentWidth, maxHeight] };
  }
  const scale = Math.min(1, contentWidth / natural.width, maxHeight / natural.height);
  return { width: Math.max(1, Math.round(natural.width * scale * 100) / 100) };
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/**
 * A link target that may become a PDF link annotation.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function safeLink(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length > 2000 || !SAFE_LINK.test(trimmed)) return null;
  return trimmed;
}

/**
 * Remove what an SVG could use to reach outside the document.
 *
 * svg-to-pdfkit opens `<image href>` targets with pdfkit, which reads local
 * files for anything that is not a `data:` URI. The renderer also replaces
 * its image callback, so this is the first of two layers.
 *
 * @param {string} svg
 * @returns {string}
 */
export function sanitizeSvg(svg) {
  return String(svg)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<(image|feImage)\b[^>]*>(?:[\s\S]*?<\/\1\s*>)?/gi, tag =>
      /(?:xlink:)?href\s*=\s*["']\s*data:image\/(png|jpe?g);/i.test(tag) ? tag : ''
    )
    .replace(/<use\b[^>]*>/gi, tag =>
      /(?:xlink:)?href\s*=\s*["']\s*#/i.test(tag) || !/href\s*=/i.test(tag) ? tag : ''
    )
    .replace(/@import[^;]*;?/gi, '');
}

/**
 * The image callback given to svg-to-pdfkit: only inline PNG/JPEG pass.
 *
 * @param {string} link
 * @returns {string}
 */
export function svgImageCallback(link) {
  const check = checkImageDataUri(link);
  return check.ok ? check.dataUri : TRANSPARENT_PIXEL;
}

/** A 1×1 transparent PNG, drawn in place of a refused SVG image. */
export const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * A finite number clamped into a range, or `undefined`.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number|undefined}
 */
export function clampNumber(value, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * pdfmake margins: one number, `[horizontal, vertical]` or
 * `[left, top, right, bottom]`, each clamped.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {number|number[]|undefined}
 */
export function sanitizeMargin(value, max = 200) {
  if (typeof value === 'number') return clampNumber(value, 0, max);
  if (Array.isArray(value) && (value.length === 2 || value.length === 4)) {
    const parts = value.map(v => clampNumber(v, -max, max));
    return parts.every(v => v !== undefined) ? parts : undefined;
  }
  return undefined;
}
