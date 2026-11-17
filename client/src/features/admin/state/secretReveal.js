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
// A request that will produce a secret is running. Kept here, not in the
// page, so leaving and returning to the page cannot start a second one whose
// result would replace the first before it was saved.
let pending = false;
let snapshot = { reveal: null, pending: false };
const listeners = new Set();

function emit() {
  snapshot = { reveal: current, pending };
  for (const listener of listeners) listener();
}

/** @param {SecretReveal} reveal */
export function showSecretReveal(reveal) {
  current = reveal;
  pending = false;
  emit();
}

/**
 * Mark a secret-producing request as started (true) or failed (false).
 * `showSecretReveal` ends it on success.
 *
 * @param {boolean} value
 */
export function setSecretRequestPending(value) {
  pending = Boolean(value);
  emit();
}

export function clearSecretReveal() {
  current = null;
  pending = false;
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

/** @returns {SecretReveal|null} The secret waiting to be shown, if any. */
export function useSecretReveal() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).reveal;
}

/**
 * Whether a new secret may be requested now: not while one is on its way or
 * still waiting to be saved.
 *
 * @returns {boolean}
 */
export function useSecretRequestBlocked() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return Boolean(state.reveal) || state.pending;
}
