// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Minimal Server-Sent Events reader over a fetch body stream.
 * Yields `{ event, data }` where `data` is parsed JSON when possible.
 * Comment lines (`: heartbeat`) are skipped.
 */
export async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      const ev = parseBlock(block);
      if (ev) yield ev;
    }
  }
  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const raw = data.join('\n');
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* plain text payload, e.g. [DONE] */
  }
  return { event, data: parsed };
}

/**
 * Wrap an async iterator so a consumer can pull one event at a time with a
 * timeout and keep the stream open between pulls (a chat session reads one
 * turn, waits through think time, then reads the next).
 */
export class EventPuller {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.pending = null;
    this.done = false;
  }

  /** Next event, or null when the stream ended. Rejects on timeout. */
  async next(timeoutMs) {
    if (this.done) return null;
    if (!this.pending) this.pending = this.iterator.next();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`no stream event within ${timeoutMs} ms`);
        err.code = 'STREAM_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([this.pending, timeout]);
      this.pending = null;
      if (result.done) {
        this.done = true;
        return null;
      }
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }
}
