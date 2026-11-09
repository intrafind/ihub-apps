// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The keys that send a multi-line message, as the user's keyboard labels them:
 * `⌘ + Enter` on Apple devices, `Ctrl + Enter` everywhere else.
 *
 * @returns {string}
 */
export function submitShortcutLabel() {
  const isApple =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  return isApple ? '⌘ + Enter' : 'Ctrl + Enter';
}
