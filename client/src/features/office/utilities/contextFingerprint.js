// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A short identity of what a send is about: the open email or meeting in
 * Outlook, the active tab (and its selection) in the extension.
 *
 * The AI-use dialog does not block the host: while it is open the user can
 * click another email or switch tab. The message is captured when Send is
 * pressed, so after "Confirm" it is only sent on its own when this fingerprint
 * still matches the live context. Otherwise the draft stays in the composer
 * and the user is asked to check it first: an email B must never go out under a
 * question typed about email A.
 *
 * @param {Object|null|undefined} ctx - A host context (`readMessageContext()`)
 * @returns {string} Empty when there is no context
 */
export function contextFingerprint(ctx) {
  if (!ctx || ctx.available === false) return '';
  const body = typeof ctx.bodyText === 'string' ? ctx.bodyText : '';
  return JSON.stringify([
    ctx.itemKind ?? '',
    ctx.itemId ?? '',
    ctx.url ?? '',
    ctx.subject ?? ctx.title ?? '',
    // A selection on the page changes the text, not the address.
    body.length,
    body.slice(0, 120)
  ]);
}

/**
 * Whether the context a send was captured with still is the live one.
 *
 * @param {Object|null|undefined} captured - Context at the time of the press
 * @param {Object|null|undefined} live - Context now; null while it reloads
 * @returns {boolean}
 */
export function sameContext(captured, live) {
  return contextFingerprint(captured) === contextFingerprint(live);
}
