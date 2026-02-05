/**
 * Stream Utilities
 * Provides utilities for working with different stream types (Web Streams vs Node.js streams)
 */
import { Readable } from 'stream';

/**
 * Convert a fetch response body to a Web Streams ReadableStream.
 * Handles compatibility between:
 * - Native fetch (returns Web Streams API ReadableStream with getReader())
 * - node-fetch (returns Node.js Readable stream with pipe())
 *
 * This is necessary because throttledFetch uses node-fetch when proxy/SSL
 * configuration is enabled, which returns Node.js streams instead of Web Streams.
 *
 * @param {Response} response - The fetch response object
 * @returns {ReadableStream} Web Streams ReadableStream with getReader() method
 * @throws {Error} If response body is not a readable stream
 */
export function getReadableStream(response) {
  // Check if body already has getReader (native fetch with Web Streams API)
  if (response.body && typeof response.body.getReader === 'function') {
    return response.body;
  }

  // node-fetch returns a Node.js stream - convert to Web Streams
  if (response.body && typeof response.body.pipe === 'function') {
    // Use Node.js Readable.toWeb() to convert Node.js stream to Web Streams ReadableStream
    return Readable.toWeb(response.body);
  }

  throw new Error(
    'Response body is not a readable stream. Expected Web Streams API or Node.js stream.'
  );
}

/**
 * Get a reader from a fetch response, handling both native fetch and node-fetch responses.
 * Convenience wrapper around getReadableStream().
 *
 * @param {Response} response - The fetch response object
 * @returns {ReadableStreamDefaultReader} Reader from the response body
 */
export function getStreamReader(response) {
  return getReadableStream(response).getReader();
}
