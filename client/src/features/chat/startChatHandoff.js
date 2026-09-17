// Lightweight in-memory handoff used to carry a started message (and any
// already-processed file attachments) from the start page into the target
// app's chat. Files cannot travel through the URL, so we stash the processed
// upload payload here and let AppChat consume it on mount. The text + auto-send
// still flow through the `prefill` / `send=true` query params so a refresh or a
// shared link keeps working without relying on this volatile state.
//
// The same channel carries the feature toggles the user picked in the start
// page's actions menu (web search, tools, image settings, transcription).
// Those are per-chat choices rather than shareable link state, so they ride
// along here instead of bloating the query string — AppChat applies them once
// its own settings have been seeded from the app config.
//
// The Outlook task pane's start page uses the same channel to open its default
// app: there is no URL to carry anything, so the message text itself, the
// emails the user collected and the edited snapshot of the open email all ride
// here and OfficeChatPanel sends them on mount (issue #2368).

let pending = null;

/**
 * Store a pending handoff for a specific app.
 * @param {{ appId: string, files?: any, settings?: {
 *   enabledTools?: string[],
 *   websearchEnabled?: boolean,
 *   transcriptionEnabled?: boolean,
 *   imageAspectRatio?: string,
 *   imageQuality?: string
 * },
 *   text?: string,
 *   autoSend?: boolean,
 *   pinnedEmails?: Array<object>,
 *   hostContextOverride?: object|null,
 *   starterPrompt?: object|null
 * }} data - `text` onwards are the Outlook start page's fields: the message,
 *   whether to send it or only prefill it, the collected emails, the edited
 *   snapshot of the open email and the starter prompt it came from, if any.
 */
export function setPendingChatStart(data) {
  pending = data || null;
}

/**
 * Consume (and clear) the pending handoff if it matches the given app.
 * @param {string} appId
 * @returns {{ appId: string, files?: any, settings?: Object } | null}
 */
export function consumePendingChatStart(appId) {
  if (pending && pending.appId === appId) {
    const data = pending;
    pending = null;
    return data;
  }
  return null;
}
