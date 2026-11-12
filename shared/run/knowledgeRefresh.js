// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `tool/progress` phase of the refresh a chat turn waits for before it
 * reads its projects (#3622): outdated documents are fetched again, within the
 * installation's `refreshWaitSeconds`. `data: {total, done}`; the server sends
 * it, the client shows it as the turn's status line until the turn starts.
 */
export const KNOWLEDGE_REFRESH_PHASE = 'knowledge.refresh';
