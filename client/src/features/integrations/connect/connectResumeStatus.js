// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What became of the call that waited for a connection (#3752), per
 * integration, for the Connect card of that integration.
 *
 * The chat asks the server to continue the stored call once the browser comes
 * back from a sign-in (`useConnectResume`). The card only shows the outcome;
 * it never decides it. A tiny external store keeps the card free of prop
 * drilling through the message list.
 *
 * States: `resuming` (the request went out, the call is running), `done` (the
 * turn ended), `refused` with the server's `code` (`CONNECT_RESUME_EXPIRED`,
 * `CONNECT_RESUME_NOT_PENDING`, `CONNECT_RESUME_NOT_CONNECTED`).
 *
 * @module features/integrations/connect/connectResumeStatus
 */
import { useSyncExternalStore } from 'react';

/** @type {Map<string, {state: string, code?: string}>} */
let statuses = new Map();
const listeners = new Set();

function emit() {
  // A new Map so a subscriber sees a changed snapshot.
  statuses = new Map(statuses);
  listeners.forEach(listener => listener());
}

/**
 * Record the outcome for an integration.
 * @param {string} integration - Installation id
 * @param {{state: 'resuming'|'done'|'refused', code?: string}|null} status - null clears it
 */
export function setConnectResumeStatus(integration, status) {
  if (!integration) return;
  if (status) statuses.set(integration, status);
  else statuses.delete(integration);
  emit();
}

/**
 * The outcome for an integration, or null.
 * @param {string} integration
 * @returns {{state: string, code?: string}|null}
 */
export function getConnectResumeStatus(integration) {
  return statuses.get(integration) || null;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Subscribe a component to the outcome for an integration.
 * @param {string} integration
 * @returns {{state: string, code?: string}|null}
 */
export function useConnectResumeStatus(integration) {
  return useSyncExternalStore(
    subscribe,
    () => statuses.get(integration) || null,
    () => null
  );
}

/** Test seam. */
export function resetConnectResumeStatusForTests() {
  statuses = new Map();
  emit();
}
