import compression from 'compression';

// Response types worth compressing: the client bundle, the SPA shell and JSON
// API payloads (apps, tools, translations, ...). Everything else is left alone
// on purpose — streamed responses (SSE chat streams, MCP / A2A event streams,
// NDJSON, audio) must reach the client as each chunk is written, and a
// compressor would hold chunks back until its buffer fills.
const COMPRESSIBLE_TYPES = new Set([
  'application/json',
  'application/javascript',
  'text/javascript',
  'text/css',
  'text/html',
  'text/plain',
  'image/svg+xml',
  'application/manifest+json'
]);

/**
 * Whether a response may be compressed, decided from its Content-Type once the
 * headers are about to be sent.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
export function shouldCompress(req, res) {
  const contentType = String(res.getHeader('Content-Type') || '');
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  return COMPRESSIBLE_TYPES.has(mimeType);
}

/**
 * gzip / brotli compression for the static client bundle and JSON API
 * responses. Without it the start page transfers its JavaScript, CSS and API
 * payloads uncompressed (roughly 4x the bytes).
 */
export function createCompressionMiddleware() {
  return compression({ filter: shouldCompress });
}
