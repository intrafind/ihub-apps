import { MemoryStreamBuffer } from './MemoryStreamBuffer.js';

/**
 * Thin, swappable wrapper around MemoryStreamBuffer so callers depend on a
 * service, not the storage implementation (a future multi-instance
 * deployment could back this with a shared store instead).
 */
class StreamBufferService {
  constructor() {
    this.buffer = new MemoryStreamBuffer();
  }

  record(chatId, event, data) {
    if (!chatId) return undefined;
    return this.buffer.append(chatId, event, data);
  }

  replaySince(chatId, lastEventId) {
    return this.buffer.eventsSince(chatId, lastEventId);
  }

  clear(chatId) {
    this.buffer.clear(chatId);
  }
}

export const streamBufferService = new StreamBufferService();
