/**
 * Read a fetch Response body into a Buffer with a hard byte cap.
 *
 * The client picker enforces a per-file upload cap, but routes that
 * download from upstream providers (Microsoft Graph, Google Drive,
 * Nextcloud WebDAV, …) need a server-side guard too — otherwise an
 * attacker who knows the download URL can issue a direct request and
 * OOM the worker. This helper aborts mid-stream the moment the cap is
 * exceeded, so we never accumulate more than `maxBytes + last_chunk_size`
 * of memory.
 *
 * `response` is the value returned by `fetch()` (node-fetch or undici);
 * `response.body` must be a Node Readable stream.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @param {string} label — included in the thrown error message for
 *   easier debugging (e.g. `'Nextcloud PROPFIND response'`).
 * @returns {Promise<Buffer>}
 * @throws {Error} when the body exceeds `maxBytes` (either via
 *   `Content-Length` pre-check or mid-stream detection).
 */
export async function readBoundedBody(response, maxBytes, label) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) {
      try {
        response.body.destroy();
      } catch {
        /* ignore */
      }
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB

export default readBoundedBody;
