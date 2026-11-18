// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A window event the SSL card sends after its configuration was saved, so
 * other cards on the Security page that show part of it (the SSRF card lists
 * the SSL domain whitelist read-only) can reload the saved state. Unsaved
 * edits on the SSL card are never announced.
 */
export const SSL_CONFIG_SAVED_EVENT = 'ihub:admin-ssl-config-saved';

/** Announces that the SSL configuration was saved. */
export function announceSslConfigSaved() {
  window.dispatchEvent(new Event(SSL_CONFIG_SAVED_EVENT));
}
