/* global Office */

/**
 * Opens the OAuth URL in an Office dialog and delivers the redirect URL via `messageParent`.
 * @param {string} authorizeUrl
 * @param {(redirectUrl: string) => void} onRedirectUrl
 * @param {(err: unknown) => void} [onError]
 */
export const openOfficeAuthDialog = (authorizeUrl, onRedirectUrl, onError) => {
  if (typeof Office === 'undefined' || !Office.context || !Office.context.ui) {
    if (onError) {
      onError(new Error('Office.js is not available in this context.'));
    }
    return;
  }

  Office.context.ui.displayDialogAsync(
    authorizeUrl,
    {
      height: 65,
      width: 40,
      displayInIframe: true
    },
    asyncResult => {
      if (asyncResult.status !== Office.AsyncResultStatus.Succeeded) {
        if (onError) {
          onError(asyncResult.error);
        }
        return;
      }

      const dialog = asyncResult.value;

      dialog.addEventHandler(Office.EventType.DialogMessageReceived, arg => {
        try {
          const redirectUrl = arg?.message;
          if (redirectUrl && typeof onRedirectUrl === 'function') {
            onRedirectUrl(redirectUrl);
          }
        } catch (err) {
          if (onError) {
            onError(err);
          }
        } finally {
          dialog.close();
        }
      });

      dialog.addEventHandler(Office.EventType.DialogEventReceived, arg => {
        if (onError) {
          onError(arg);
        }
      });
    }
  );
};
