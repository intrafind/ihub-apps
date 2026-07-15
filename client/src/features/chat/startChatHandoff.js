// Lightweight in-memory handoff used to carry a started message (and any
// already-processed file attachments) from the start page into the target
// app's chat. Files cannot travel through the URL, so we stash the processed
// upload payload here and let AppChat consume it on mount. The text + auto-send
// still flow through the `prefill` / `send=true` query params so a refresh or a
// shared link keeps working without relying on this volatile state.

let pending = null;

/**
 * Store a pending handoff for a specific app.
 * @param {{ appId: string, files?: any }} data
 */
export function setPendingChatStart(data) {
  pending = data || null;
}

/**
 * Consume (and clear) the pending handoff if it matches the given app.
 * @param {string} appId
 * @returns {{ appId: string, files?: any } | null}
 */
export function consumePendingChatStart(appId) {
  if (pending && pending.appId === appId) {
    const data = pending;
    pending = null;
    return data;
  }
  return null;
}
