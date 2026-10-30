// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';

/**
 * Collapse, expand and pin the input parameters panel beside the chat
 * (issue #3053).
 *
 * A chat always opens with the panel expanded. Unpinned, it collapses each
 * time a message is sent, so the conversation gets the room; the user can
 * expand it again, and the next message collapses it again. Pinned, it stays
 * as the user left it. The app's `variablesPanel.pinned` is the default (on
 * when unset); the user's own choice is remembered per app in this browser.
 */

const STORAGE_PREFIX = 'ihub.variablesPanel.pinned.';

/**
 * @param {Object|null} app
 * @returns {boolean} Whether the app's panel starts pinned.
 */
export function isVariablesPanelPinnedByDefault(app) {
  return app?.variablesPanel?.pinned !== false;
}

function readPinned(appId) {
  try {
    const stored = window.localStorage.getItem(STORAGE_PREFIX + appId);
    return stored === null ? null : stored === 'true';
  } catch {
    return null;
  }
}

function writePinned(appId, pinned) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + appId, String(pinned));
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts this visit.
  }
}

/**
 * @param {Object} params
 * @param {Object|null} params.app
 * @param {string} params.appId
 * @param {string} params.chatId - A new or another chat expands the panel again.
 */
export default function useVariablesPanel({ app, appId, chatId }) {
  const [userPinned, setUserPinned] = useState(() => readPinned(appId));
  const [collapsed, setCollapsed] = useState(false);
  // Another app or chat: reset while rendering, so it never shows stale state.
  const [shown, setShown] = useState({ appId, chatId });
  if (shown.appId !== appId || shown.chatId !== chatId) {
    if (shown.appId !== appId) setUserPinned(readPinned(appId));
    setShown({ appId, chatId });
    setCollapsed(false);
  }

  const pinned = userPinned ?? isVariablesPanelPinnedByDefault(app);

  const togglePinned = useCallback(() => {
    const next = !pinned;
    setUserPinned(next);
    writePinned(appId, next);
  }, [appId, pinned]);

  const toggleCollapsed = useCallback(() => setCollapsed(c => !c), []);
  const expand = useCallback(() => setCollapsed(false), []);
  const collapseAfterSend = useCallback(() => {
    if (!pinned) setCollapsed(true);
  }, [pinned]);

  return { pinned, collapsed, togglePinned, toggleCollapsed, expand, collapseAfterSend };
}
