// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useSyncExternalStore } from 'react';

/**
 * A one-time secret waiting to be shown, held above the routes.
 *
 * A rotate request can finish after the page that started it is gone (browser
 * Back while the POST runs). The server has already replaced the secret, so the
 * result must not depend on that page's lifetime: it is put here, and
 * `AdminSecretRevealHost` (mounted by the admin layout) shows it until Done.
 *
 * @typedef {{ title: string, description?: string, fieldLabel?: string, secret: string }} SecretReveal
 */

/** @type {SecretReveal|null} */
let current = null;
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

/** @param {SecretReveal} reveal */
export function showSecretReveal(reveal) {
  current = reveal;
  emit();
}

export function clearSecretReveal() {
  current = null;
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return current;
}

/** @returns {SecretReveal|null} The secret waiting to be shown, if any. */
export function useSecretReveal() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
