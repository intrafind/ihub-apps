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

/**
 * Parse JSON safely, returning a fallback value on error
 *
 * @param {string} data - JSON string to parse
 * @param {any} fallbackValue - Value to return if parsing fails
 * @returns {Promise<any>} Parsed JSON object or fallback value
 */
export async function safeParseJsonAsync(data, fallbackValue = null) {
  try {
    return await parseJsonAsync(data);
  } catch (error) {
    logger.warn('JSON parse failed, using fallback', {
      component: 'asyncJson',
      error: error.message
    });
    return fallbackValue;
  }
}

/**
 * Stringify JSON with deferred execution for large objects
 *
 * For primitive values and small objects, uses regular JSON.stringify.
 * For large objects/arrays, defers stringification to avoid blocking,
 * but note that JSON.stringify() itself still blocks while executing.
 *
 * @param {any} obj - Object to stringify
 * @param {Object} options - Options object
 * @param {number} options.space - Formatting space (passed to JSON.stringify)
 * @returns {Promise<string>} JSON string
 */
export async function stringifyJsonAsync(obj, options = {}) {
  const space = options.space;

  // Primitive values are inexpensive to stringify, so use synchronous path
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return JSON.stringify(obj, null, space);
  }

  // For objects and arrays, defer stringification to next event loop phase
  // This allows pending I/O operations to be processed before stringifying
  logger.debug('Using async JSON stringify for object', {
    component: 'asyncJson'
  });

  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const result = JSON.stringify(obj, null, space);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
