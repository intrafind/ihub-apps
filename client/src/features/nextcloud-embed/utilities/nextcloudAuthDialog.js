/**
 * Opens the iHub OAuth URL in a standard browser popup window and delivers the
 * redirect URL back to the embed via `window.postMessage`.
 *
 * Differs from `openOfficeAuthDialog` (which uses `Office.context.ui.displayDialogAsync`)
 * because the Nextcloud embed is a plain iframe with no host-specific dialog API.
 * The matching `nextcloud/callback.html` posts `window.location.href` to its
 * `window.opener` and then closes the popup.
 *
 * Same callback signature as `openOfficeAuthDialog` so it can be slotted into
 * the `EmbeddedHostAdapter.runAuthDialog` field unchanged.
 *
 * @param {string} authorizeUrl
 * @param {(redirectUrl: string) => void} onRedirectUrl
 * @param {(err: unknown) => void} [onError]
 */
export function openNextcloudAuthDialog(authorizeUrl, onRedirectUrl, onError) {
  let popup;
  try {
    // 480×640 fits the iHub login form comfortably and matches the
    // popup size used by the Office dialog (5/8ths of screen ~= 65×40 vw).
    popup = window.open(
      authorizeUrl,
      'ihub-nextcloud-oauth',
      'width=480,height=640,resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no'
    );
  } catch (err) {
    if (onError) onError(err);
    return;
  }

  if (!popup) {
    if (onError) {
      onError(
        new Error('OAuth popup was blocked. Allow pop-ups for this site and try signing in again.')
      );
    }
    return;
  }

  // We post the redirect URL from the callback page back to this window. The
  // iHub OAuth callback is served by iHub itself, so `event.origin` equals
  // `window.location.origin`.
  const expectedOrigin = window.location.origin;
  let settled = false;

  function cleanup() {
    settled = true;
    window.removeEventListener('message', onMessage);
    clearInterval(closedPoll);
    try {
      if (popup && !popup.closed) popup.close();
    } catch {
      /* popup may already be closed by the callback page */
    }
  }

  function onMessage(event) {
    if (event.origin !== expectedOrigin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.kind !== 'ihub.nextcloud.authCallback') return;
    if (typeof data.redirectUrl !== 'string') return;
    if (settled) return;
    cleanup();
    onRedirectUrl(data.redirectUrl);
  }

  window.addEventListener('message', onMessage);

  // If the user manually closes the popup before completing OAuth, surface
  // that as an error so the UI doesn't sit on a spinner forever.
  const closedPoll = setInterval(() => {
    if (settled) return;
    if (popup && popup.closed) {
      cleanup();
      if (onError) {
        onError(new Error('Sign-in window was closed before completing authentication.'));
      }
    }
  }, 500);
}
