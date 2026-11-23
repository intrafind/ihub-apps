// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * Whether a message bubble shows the admin diagnostics of a failed model call
 * (HTTP status, host, error code, what to check, a link to the SSL / TLS
 * settings). Provided as `true` only by the admin test panels (`TestChat` in
 * `admin/components/AppTestPanel.jsx`); everywhere else a failed call shows
 * the end-user message alone. The host and error code reach the client only
 * for an administrator in the first place (server/services/chat/chatErrors.js).
 *
 * @type {import('react').Context<boolean>}
 */
const ChatDiagnosticsContext = createContext(false);

export default ChatDiagnosticsContext;

/** @returns {boolean} Whether this chat shows the admin diagnostics of a failure */
export function useChatDiagnostics() {
  return useContext(ChatDiagnosticsContext);
}
