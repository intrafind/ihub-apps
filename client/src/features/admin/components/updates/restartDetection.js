// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether a status answer comes from the restarted server.
 *
 * A new boot id says so directly. A version from before this check existed
 * (a rollback to it) reports no boot id; then the server counts as back once
 * it was seen down, or once it reports another version — the old process
 * keeps answering for a moment after it scheduled the restart.
 *
 * @param {Object|null} status - /admin/update/status
 * @param {{ bootId?: string, version?: string }} before - The server before the restart
 * @param {boolean} sawDown - A status request failed since the restart was requested
 */
export function isRestartedServer(status, before, sawDown) {
  if (!status || status.pendingRestart) return false;
  if (status.bootId) return status.bootId !== before.bootId;
  return sawDown || (Boolean(before.version) && status.currentVersion !== before.version);
}
