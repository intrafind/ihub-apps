/**
 * In-memory, per-chat buffer of SSE events, keyed by a monotonically
 * increasing id per chat. Lets a reconnecting client replay whatever it
 * missed (via a `Last-Event-ID` header) instead of losing a partial AI
 * response to a brief network drop.
 *
 * Bounded by a sliding TTL: a chat's buffer is evicted `ttlMs` after its
 * *last* event, not from creation, so a chat that's still actively
 * streaming never expires mid-stream.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class MemoryStreamBuffer {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.chats = new Map(); // chatId -> { events: [{id, event, data}], counter, timer }
  }

  /**
   * Append an event for chatId and return the id assigned to it.
   */
  append(chatId, event, data) {
    let entry = this.chats.get(chatId);
    if (!entry) {
      entry = { events: [], counter: 0, timer: null };
      this.chats.set(chatId, entry);
    }
    entry.counter += 1;
    const id = entry.counter;
    entry.events.push({ id, event, data });
    this._resetEviction(chatId, entry);
    return id;
  }

  /**
   * Events buffered for chatId after lastId (exclusive), in order.
   * Returns null if nothing is buffered for chatId (unknown/expired chat —
   * the caller should treat this as a fresh connection, not an empty replay).
   */
  eventsSince(chatId, lastId) {
    const entry = this.chats.get(chatId);
    if (!entry) return null;
    const n = Number(lastId);
    if (!Number.isFinite(n)) return entry.events.slice();
    return entry.events.filter(e => e.id > n);
  }

  clear(chatId) {
    const entry = this.chats.get(chatId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.chats.delete(chatId);
  }

  _resetEviction(chatId, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.chats.delete(chatId), this.ttlMs);
    entry.timer.unref?.();
  }
}
