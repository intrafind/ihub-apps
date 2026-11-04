// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Async JSON parsing utilities to reduce event loop blocking
 *
 * When parsing large JSON payloads (especially those containing large base64-encoded images),
 * synchronous JSON.parse() can block the event loop for hundreds of milliseconds,
 * causing the server to become unresponsive.
 *
 * This module provides utilities that defer JSON parsing using setImmediate(), allowing
 * pending I/O operations to be processed before the parse begins. Note that JSON.parse()
 * itself still runs synchronously once started - this approach defers when parsing starts,
 * not eliminating blocking during the parse itself.
 *
 * For true non-blocking parsing of very large payloads, consider using worker threads.
 */

import logger from './logger.js';

/**
 * Threshold size (in bytes) above which we use async parsing
 * Below this threshold, regular JSON.parse is faster
 */
const ASYNC_PARSE_THRESHOLD = 50 * 1024; // 50KB

/**
 * Parse JSON with deferred execution to reduce event loop blocking
 *
 * For small payloads, uses regular JSON.parse for performance.
 * For large payloads, uses setImmediate() to defer parsing to the next event loop phase,
 * allowing pending I/O operations to be processed first. Note that JSON.parse() itself
 * still blocks while executing - this defers when it starts, not eliminates blocking.
 *
 * @param {string} data - JSON string to parse
 * @param {Object} options - Options object
 * @param {number} options.threshold - Size threshold for async parsing (default: 50KB)
 * @returns {Promise<any>} Parsed JSON object
 */
export async function parseJsonAsync(data, options = {}) {
  if (!data) {
    throw new Error('Cannot parse empty data');
  }

  const threshold = options.threshold ?? ASYNC_PARSE_THRESHOLD;
  const dataSize = Buffer.byteLength(data, 'utf8');

  // For small payloads, use regular JSON.parse - it's faster
  if (dataSize < threshold) {
    return JSON.parse(data);
  }

  // For large payloads, defer parsing to next event loop phase
  // This allows pending I/O operations to be serviced before parsing starts
  logger.debug('Using async JSON parse for large payload', {
    component: 'asyncJson',
    size: dataSize,
    threshold
  });

  // Use setImmediate to defer parsing until after current event loop phase
  // This allows health checks and other pending work to proceed before blocking
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}
