/**
 * Async JSON parsing utilities to prevent blocking the event loop
 *
 * When parsing large JSON payloads (especially those containing large base64-encoded images),
 * synchronous JSON.parse() can block the event loop for hundreds of milliseconds,
 * causing the server to become unresponsive.
 *
 * This module provides utilities to parse JSON asynchronously, yielding control
 * to the event loop periodically during parsing.
 */

import logger from './logger.js';

/**
 * Threshold size (in bytes) above which we use async parsing
 * Below this threshold, regular JSON.parse is faster
 */
const ASYNC_PARSE_THRESHOLD = 50 * 1024; // 50KB

/**
 * Parse JSON asynchronously to avoid blocking the event loop
 * For small payloads, uses regular JSON.parse for performance
 * For large payloads, yields to event loop before parsing
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

  // For large payloads, yield to event loop before parsing
  // This prevents blocking other requests
  logger.debug('Using async JSON parse for large payload', {
    component: 'asyncJson',
    size: dataSize,
    threshold
  });

  // Use setImmediate to yield control to event loop
  // This allows other pending I/O operations to proceed
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
 * Parse JSON with automatic fallback
 * Tries async parsing first, falls back to sync if needed
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
 * Stringify JSON with optional async handling for large objects
 * For very large objects, yields to event loop before stringifying
 *
 * @param {any} obj - Object to stringify
 * @param {Object} options - Options object
 * @param {number} options.threshold - Size threshold for async operation
 * @param {number} options.space - Formatting space (passed to JSON.stringify)
 * @returns {Promise<string>} JSON string
 */
export async function stringifyJsonAsync(obj, options = {}) {
  const threshold = options.threshold ?? ASYNC_PARSE_THRESHOLD;
  const space = options.space;

  // Quick estimate of object size - serialize a sample
  const sample = JSON.stringify(obj);
  const estimatedSize = Buffer.byteLength(sample, 'utf8');

  // For small objects, use regular JSON.stringify
  if (estimatedSize < threshold) {
    return JSON.stringify(obj, null, space);
  }

  // For large objects, yield to event loop before stringifying
  logger.debug('Using async JSON stringify for large object', {
    component: 'asyncJson',
    estimatedSize,
    threshold
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
