# Concept: Chat Performance Optimization

## Summary

To maintain a smooth user experience during long conversations, we need to reduce memory consumption and storage overhead of chat transcripts. This concept describes strategies to offload data to IndexedDB, batch writes, virtualize message rendering, and free DOM elements when chats are hidden.

## Background

Currently, all chat messages are kept in React state and persisted to `sessionStorage` on every update. Large discussions quickly exhaust the small browser quota and create thousands of DOM nodes, making the UI sluggish and sometimes crashing the browser.

## Proposed Improvements

1. **Persist messages in IndexedDB**
   - Replace `sessionStorage` with an IndexedDB database (e.g., using `idb` or `Dexie.js`).
   - IndexedDB offers asynchronous access and large quotas, preventing quota errors.
   - On logout we already remove any IndexedDB databases.

2. **Debounced writes**
   - Buffer incoming chunks in memory and write to IndexedDB only every ~500 ms or after a final 'done' event.
   - Use a helper similar to `debouncedSaveToStorage()` to avoid thousands of tiny writes.

3. **Limit in-memory history**
   - Keep only the most recent N messages in React state and load older ones on demand.
   - This reduces rendering and memory pressure for long chats.

4. **Virtualize `ChatMessageList`**
   - Implement list virtualization (e.g., `react-window`) so only visible messages are mounted.
   - This keeps the DOM small even for extensive conversations.

5. **Cleanup hidden chats**
   - Unmount chat components when the widget is not visible instead of merely hiding them.
   - Ensure SSE streams and timers are cleaned up in `useEventSource`.

6. **Optional history trimming**
   - Provide a setting to clear or archive old chats automatically to keep the database small.

## Expected Benefits

- Avoids `sessionStorage` quota errors during long sessions.
- Keeps the DOM lightweight for faster rendering and scrolling.
- Reduces memory footprint by storing older history offline.
- Prevents lingering SSE connections or event listeners after closing the widget.

---

_Document created: 2025-07-21_
_Author: AI Hub Development Team_
