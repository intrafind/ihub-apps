import { useState, useEffect } from 'react';
import {
  SparklesIcon,
  EnvelopeIcon,
  ChatBubbleLeftRightIcon,
  ShieldCheckIcon
} from '@heroicons/react/24/outline';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import { openOfficeAuthDialog } from '../utilities/officeAuthDialog';
import {
  createPkceParams,
  getStoredPkceVerifier,
  parseAuthCodeFromUrl,
  exchangeAuthCodeForToken,
  getAuthorizeUrl
} from '../api/officeAuth';
import { buildAssetUrl } from '../../../utils/runtimeBasePath';

const OfficeLogin = ({ onSuccess, initialError = null }) => {
  const config = useOfficeConfig();
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Authenticating…');
  const [sessionBanner, setSessionBanner] = useState(initialError);
  const [apiError, setApiError] = useState(null);

  useEffect(() => {
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setSessionBanner(initialError);
  }, [initialError]);

  const handleAuthenticateClick = async () => {
    setApiError(null);
    setLoadingMessage('Complete authentication in the popup…');
    setIsLoading(true);

    try {
      const { codeVerifier, codeChallenge, state } = await createPkceParams();
      const authorizeUrl = getAuthorizeUrl(config, { codeChallenge, state });

      openOfficeAuthDialog(
        authorizeUrl,
        async redirectUrl => {
          setLoadingMessage('Getting your token…');
          const { code, state: returnedState } = parseAuthCodeFromUrl(redirectUrl);
          if (!code) {
            setApiError('Authorization failed: no code returned.');
            setIsLoading(false);
            return;
          }
          if (!returnedState || returnedState !== state) {
            setApiError('Authentication failed: state mismatch. Please try again.');
            setIsLoading(false);
            return;
          }

          try {
            const codeVerifierToUse = codeVerifier || getStoredPkceVerifier();
            if (!codeVerifierToUse) {
              setApiError('Authentication session expired. Please try again.');
              setIsLoading(false);
              return;
            }
            const tokenData = await exchangeAuthCodeForToken(config, {
              code,
              codeVerifier: codeVerifierToUse
            });

            setLoadingMessage('Loading your apps…');
            if (onSuccess) {
              onSuccess(tokenData);
            }
          } catch (err) {
            const message =
              err && typeof err === 'object' && typeof err.error === 'string'
                ? err.error
                : err && typeof err.message === 'string'
                  ? err.message
                  : 'Token request failed. Please try again.';
            setApiError(message);
            setIsLoading(false);
          }
        },
        error => {
          const message =
            error && typeof error === 'object' && typeof error.message === 'string'
              ? error.message
              : 'Unable to open the authentication dialog. Please try again.';
          setApiError(message);
          setIsLoading(false);
        }
      );
    } catch (err) {
      const message =
        err && typeof err.message === 'string'
          ? err.message
          : 'Authentication failed. Please try again.';
      setApiError(message);
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center bg-slate-50">
      <div className="relative w-full max-w-sm px-4">
        <div className="w-full shadow-lg rounded-xl overflow-hidden bg-white">
          <div className="flex flex-col items-center px-6 pt-6 pb-4 border-b border-slate-200">
            <div className="w-12 h-12 rounded-lg bg-slate-900 flex items-center justify-center mb-3">
              <img
                src={buildAssetUrl('icons/apps-svg-logo.svg')}
                alt="iHub Apps"
                className="w-8 h-8"
              />
            </div>
            <h1 className="text-lg font-semibold text-slate-900">Welcome</h1>
            <p className="text-sm text-slate-500 mt-1">iHub Apps for Outlook</p>
          </div>

          <div className="px-6 pt-4 pb-6 flex flex-col gap-4">
            {(sessionBanner || apiError) && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2 space-y-1">
                {sessionBanner && <p className="m-0">{sessionBanner}</p>}
                {apiError && (
                  <p className={`m-0 ${sessionBanner ? 'pt-1 border-t border-red-100' : ''}`}>
                    {apiError}
                  </p>
                )}
              </div>
            )}

            <ul className="flex flex-col gap-3 text-left list-none m-0 p-0">
              <li className="flex gap-3 items-start">
                <SparklesIcon className="h-5 w-5 shrink-0 text-slate-600 mt-0.5" aria-hidden />
                <span className="text-sm text-slate-700 leading-snug">
                  Use iHub AI apps—chat, translation, email tools, and more—directly inside Outlook.
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <EnvelopeIcon className="h-5 w-5 shrink-0 text-slate-600 mt-0.5" aria-hidden />
                <span className="text-sm text-slate-700 leading-snug">
                  Work with your mailbox context when an app needs the current email or attachments.
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <ChatBubbleLeftRightIcon
                  className="h-5 w-5 shrink-0 text-slate-600 mt-0.5"
                  aria-hidden
                />
                <span className="text-sm text-slate-700 leading-snug">
                  Choose an app after you connect, then chat and iterate in the task pane.
                </span>
              </li>
              <li className="flex gap-3 items-start">
                <ShieldCheckIcon className="h-5 w-5 shrink-0 text-slate-600 mt-0.5" aria-hidden />
                <span className="text-sm text-slate-700 leading-snug">
                  Sign in with your iHub account securely via the authentication popup.
                </span>
              </li>
            </ul>

            <button
              type="button"
              disabled={isLoading}
              onClick={handleAuthenticateClick}
              className="w-full mt-1 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? loadingMessage : 'Authenticate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OfficeLogin;
