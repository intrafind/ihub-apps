/**
 * Parses an SSE (Server-Sent Events) ReadableStream, calling onEvent for each dispatched event.
 *
 * Compliant with the SSE spec:
 * - Strips exactly one leading space from field values (per spec)
 * - Handles event:, data:, id:, retry: fields
 * - Dispatches on empty line
 * - Handles \r\n and \n line endings
 * - Handles multi-line data fields (joined with \n)
 *
 * @param {ReadableStream} body - Response body stream
 * @param {Function} onEvent - Callback: (eventName: string, data: object|{raw: string}) => void
 * @param {AbortSignal} [signal] - Optional AbortSignal to cancel parsing
 */
export async function parseSseStream(body, onEvent, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  const dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      currentEvent = '';
      return;
    }
    const raw = dataLines.join('\n');
    dataLines.length = 0;

    let payload = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // payload stays as raw string
    }

    const name =
      currentEvent ||
      (payload && typeof payload === 'object' && typeof payload.event === 'string'
        ? payload.event
        : '');

    if (name) {
      onEvent(name, typeof payload === 'object' && payload !== null ? payload : { raw });
    }

    currentEvent = '';
  };

  const processLine = line => {
    if (line === '') {
      flushEvent();
      return;
    }

    const colonIdx = line.indexOf(':');

    // Lines starting with ':' are comments — skip them
    if (colonIdx === 0) return;

    // Lines with no colon are field names with empty values — skip (not used in practice)
    if (colonIdx < 0) return;

    const field = line.slice(0, colonIdx);
    const rawValue = line.slice(colonIdx + 1);
    // Strip exactly one leading space per SSE spec
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      currentEvent = value;
    }
    // id: and retry: fields are intentionally ignored here
  };

  let completedCleanly = false;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        break;
      }

      let done, value;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        if (err.name === 'AbortError') break;

        // Handle stream reading errors gracefully
        console.error('Error reading SSE stream:', err);
        onEvent('error', {
          message: `Stream reading error: ${err.message}. The connection may have been interrupted.`
        });
        throw err;
      }

      if (done) {
        // Flush any remaining buffered line (stream ended without trailing newline)
        if (buffer) {
          const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
          try {
            processLine(line);
          } catch (err) {
            console.error('Error processing final SSE line:', err);
            onEvent('error', {
              message: `Error processing final data: ${err.message}`
            });
          }
        }
        flushEvent();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        try {
          processLine(line);
        } catch (err) {
          // Log parsing errors but continue processing
          console.error('Error processing SSE line:', err, 'Line:', line);
          // Don't send error event for individual line failures - just log
          // This prevents overwhelming the user with errors for minor parsing issues
        }
      }
    }
    completedCleanly = true;
  } catch (err) {
    // Major parsing error - inform the user
    console.error('Fatal SSE parsing error:', err);
    onEvent('error', {
      message: `Error parsing server events: ${err.message}. The server may have sent malformed data.`
    });
  } finally {
    // If we exited via an exception (e.g. consumer's onEvent threw), the
    // underlying body stream is still flowing — releaseLock alone won't
    // close the socket. Cancel the reader so the browser releases the
    // HTTP/1.1 connection slot.
    if (!completedCleanly) {
      try {
        await reader.cancel();
      } catch {
        // already cancelled — nothing to do
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // already released (cancel() releases the lock on some implementations)
    }
  }
}
