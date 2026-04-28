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

  // Per Microsoft guidance, the dialog must open in a separate webview (not an
  // iframe) for sign-in scenarios. With displayInIframe:true, Outlook on the web
  // renders the dialog as a third-party iframe inside outlook.office.com — that
  // breaks SameSite=Lax session cookies and modern browser third-party cookie
  // policies, so the OIDC state cookie set during /api/oauth/authorize is not
  // returned on the IDP callback and Passport rejects it with
  // "Failed to verify request state". Desktop Outlook ignores the flag, which is
  // why the same flow works there.
  // https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-with-office-dialog-api
  Office.context.ui.displayDialogAsync(
    authorizeUrl,
    {
      height: 65,
      width: 40
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
