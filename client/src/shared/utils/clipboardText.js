/**
 * Put text on the clipboard that is still being fetched.
 *
 * Browsers only allow a clipboard write during a user gesture, and Safari
 * counts the gesture as over once the click handler awaited a network
 * request. Handing the clipboard a `ClipboardItem` whose value is a promise
 * keeps the write inside the gesture while the text (e.g. a server-side
 * export) is still on its way. Where that is not supported the text is
 * awaited and written with `writeText`.
 *
 * @module shared/utils/clipboardText
 */

/**
 * @param {string|Promise<string>|(() => (string|Promise<string>))} source - The text,
 *   a promise of it, or a function producing either (called once)
 * @returns {Promise<void>}
 * @throws The error of `source` when producing the text failed, or the
 *   clipboard's error when no write path worked
 * @example
 * await writeTextToClipboard(() => requestExportText(body));
 */
export async function writeTextToClipboard(source) {
  let pending;
  try {
    pending = Promise.resolve(typeof source === 'function' ? source() : source);
  } catch (error) {
    pending = Promise.reject(error);
  }
  // Observed below; silences the unhandled-rejection warning in the meantime.
  pending.catch(() => {});

  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;

  if (typeof clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({
        'text/plain': pending.then(text => new Blob([String(text ?? '')], { type: 'text/plain' }))
      });
      await clipboard.write([item]);
      return;
    } catch {
      // Either the text failed (re-thrown just below) or this browser does
      // not take promised clipboard items — fall back to writeText.
    }
  }

  const text = await pending;
  if (typeof clipboard?.writeText !== 'function') {
    throw new Error('Clipboard is not available');
  }
  await clipboard.writeText(String(text ?? ''));
}
