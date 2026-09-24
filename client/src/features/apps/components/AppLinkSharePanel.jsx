import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { createShortLink, getShortLink } from '../../../api';
import { buildPath } from '../../../utils/runtimeBasePath';
import ShareLinkResult, { shareInputClass } from '../../chat/components/ShareLinkResult';

/** Shortest custom code the form accepts. */
const CODE_MIN_LENGTH = 5;

const getUsername = () => {
  try {
    return localStorage.getItem('ihub_username') || 'anonymous';
  } catch {
    return 'anonymous';
  }
};

/**
 * The absolute URL of a short link, including the deployment base path.
 *
 * @param {string} code - Short code.
 * @returns {string}
 */
function shortLinkUrl(code) {
  return `${window.location.origin}${buildPath(`/s/${encodeURIComponent(code)}`)}`;
}

/**
 * Share the app as a short link — the "Link to the app" part of the share
 * dialog. The link opens the app for a new chat, optionally with the
 * current settings; it never carries the conversation.
 *
 * One click creates a link with a generated code. A custom code and an
 * expiry are optional and sit behind "More options".
 *
 * @param {Object} props - Component properties.
 * @param {string} props.appId - The app the link opens.
 * @param {string} props.appName - Its display name, for the explanation.
 * @param {string} props.path - Where the link leads.
 * @param {Object} props.params - The current settings, passed on when included.
 * @returns {JSX.Element}
 */
function AppLinkSharePanel({ appId, appName, path, params }) {
  const { t } = useTranslation();
  const [includeParams, setIncludeParams] = useState(true);
  const [code, setCode] = useState('');
  // The last availability answer, with the code it answers for.
  const [codeCheck, setCodeCheck] = useState({ code: '', state: null });
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [createdUrl, setCreatedUrl] = useState('');

  const customCode = code.trim();
  const checkable = customCode.length >= CODE_MIN_LENGTH;

  // A custom code is checked against the existing links, debounced.
  useEffect(() => {
    if (!checkable) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let state = 'taken';
      try {
        await getShortLink(customCode);
      } catch (err) {
        if (err?.status === 404) state = 'available';
      }
      if (!cancelled) setCodeCheck({ code: customCode, state });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customCode, checkable]);

  // idle (no custom code) | short | checking | available | taken
  const codeState = !customCode
    ? 'idle'
    : !checkable
      ? 'short'
      : codeCheck.code === customCode
        ? codeCheck.state
        : 'checking';

  const canSubmit = !creating && (codeState === 'idle' || codeState === 'available');

  const handleCreate = async event => {
    event.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setCreateError(null);
    try {
      const data = await createShortLink({
        appId,
        path,
        params,
        userId: getUsername(),
        includeParams,
        // Without a code the server picks a random one.
        ...(customCode ? { code: customCode } : {}),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      setCreatedUrl(shortLinkUrl(data.code));
    } catch (err) {
      setCreateError(
        err?.status === 409
          ? t('common.codeTaken', 'Code taken')
          : t('shareDialog.appLink.createFailed', 'The link could not be created.')
      );
    } finally {
      setCreating(false);
    }
  };

  const description = (
    <p className="text-sm text-gray-500 dark:text-gray-400">
      {t('shareDialog.appLink.description', {
        app: appName || t('shareDialog.thisApp', 'this app'),
        defaultValue:
          'A short link that opens {{app}} for a new chat. Your conversation is not part of it.'
      })}
    </p>
  );

  if (createdUrl) {
    return (
      <div className="space-y-4">
        {description}
        <ShareLinkResult
          url={createdUrl}
          onCreateAnother={() => {
            setCreatedUrl('');
            setCode('');
          }}
        />
      </div>
    );
  }

  const codeStatus = {
    short: (
      <span className="text-red-600 dark:text-red-400">
        {t('common.codeTooShort', 'Code must be at least 5 characters')}
      </span>
    ),
    checking: t('common.loading', 'Loading…'),
    available: (
      <span className="text-green-600 dark:text-green-400">
        {t('common.codeAvailable', 'Code available')}
      </span>
    ),
    taken: (
      <span className="text-red-600 dark:text-red-400">{t('common.codeTaken', 'Code taken')}</span>
    )
  }[codeState];

  return (
    <form onSubmit={handleCreate} className="space-y-5">
      {description}

      <div className="flex items-start gap-2 text-sm">
        <input
          id="share-app-settings"
          type="checkbox"
          checked={includeParams}
          onChange={e => setIncludeParams(e.target.checked)}
          aria-describedby="share-app-settings-hint"
          className="mt-0.5"
        />
        <div>
          <label
            htmlFor="share-app-settings"
            className="block font-medium text-gray-900 dark:text-gray-100"
          >
            {t('common.includeSettings', 'Include settings & variables')}
          </label>
          <p id="share-app-settings-hint" className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'shareDialog.appLink.includeSettingsHint',
              'Recipients start with the model, style and input values you have selected now.'
            )}
          </p>
        </div>
      </div>

      <details className="group">
        <summary className="inline-flex items-center gap-1 cursor-pointer text-sm font-medium text-indigo-600 dark:text-indigo-400 list-none [&::-webkit-details-marker]:hidden">
          <Icon
            name="chevron-right"
            size="sm"
            className="transition-transform group-open:rotate-90"
          />
          {t('shareDialog.appLink.moreOptions', 'More options')}
        </summary>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="share-app-code"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('shareDialog.appLink.codeLabel', 'Custom short code')}
            </label>
            <input
              id="share-app-code"
              type="text"
              autoComplete="off"
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder={t('shareDialog.appLink.codePlaceholder', 'Generated automatically')}
              aria-describedby="share-app-code-status"
              className={shareInputClass}
            />
            <p
              id="share-app-code-status"
              aria-live="polite"
              className="text-xs text-gray-500 dark:text-gray-400 mt-1"
            >
              {codeStatus ||
                t('shareDialog.appLink.codeHint', {
                  count: CODE_MIN_LENGTH,
                  defaultValue: 'Optional, at least {{count}} characters.'
                })}
            </p>
          </div>
          <div>
            <label
              htmlFor="share-app-expiry"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('chatSharing.expiryLabel', 'Link expires')}
            </label>
            <input
              id="share-app-expiry"
              type="datetime-local"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              className={shareInputClass}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('shareDialog.appLink.expiryHint', 'Leave empty and the link does not expire.')}
            </p>
          </div>
        </div>
      </details>

      {createError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {createError}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Icon name="link" size="sm" />
          {creating
            ? t('chatSharing.creating', 'Creating…')
            : t('chatSharing.create', 'Create link')}
        </button>
      </div>
    </form>
  );
}

export default AppLinkSharePanel;
