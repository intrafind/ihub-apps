// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Prefixes of the browser copies chats used to keep in `sessionStorage` — the
 * transcript and the container project of a chat that was not stored
 * server-side. Every chat is stored now and nothing reads them; a tab that was
 * open across the upgrade still holds them, so they are cleared once at boot.
 */
const LEGACY_CHAT_KEY_PREFIXES = ['ai_hub_chat_messages_', 'ai_hub_chat_project_'];

/**
 * Remove the transcript copies an earlier version kept in `sessionStorage`.
 *
 * @param {Storage} [storage] - Defaults to `window.sessionStorage`.
 */
export function purgeLegacyChatCopies(storage = globalThis.sessionStorage) {
  try {
    if (!storage) return;
    const stale = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && LEGACY_CHAT_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) stale.push(key);
    }
    stale.forEach(key => storage.removeItem(key));
  } catch {
    // Storage blocked: there is nothing it could be holding either.
  }
}
