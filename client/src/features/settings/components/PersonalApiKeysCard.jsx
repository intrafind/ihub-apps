import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * A read-only value with a copy button — used for both endpoint URLs and the
 * credentials that are shown exactly once.
 */
function CopyField({ label, value, mono = true, secret = false }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);

  const handleCopy = async () => {
    // Optional chaining alone would resolve to undefined where the Clipboard API
    // is missing, and the button would claim it copied something it did not.
    if (typeof navigator?.clipboard?.writeText !== 'function') return;

    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (insecure origin, browser policy). The
      // value stays selectable, so there is nothing to recover from here.
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type={revealed ? 'text' : 'password'}
          readOnly
          value={value}
          className={`flex-1 min-w-0 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-1.5 text-xs ${
            mono ? 'font-mono' : ''
          } text-gray-700 dark:text-gray-200 focus:outline-none`}
          onClick={e => e.target.select()}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setRevealed(current => !current)}
            title={
              revealed
                ? t('integrations.page.apiKeys.hide', 'Hide')
                : t('integrations.page.apiKeys.reveal', 'Reveal')
            }
            className="shrink-0 rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <Icon name={revealed ? 'x' : 'eye'} className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          {copied
            ? t('integrations.page.apiKeys.copied', 'Copied')
            : t('integrations.page.apiKeys.copy', 'Copy')}
        </button>
      </div>
    </div>
  );
}

function formatDate(value, locale) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale);
}

/**
 * Settings > Integrations card for personal API keys.
 *
 * Shows the endpoints a key works against, the keys the user already has, and a
 * single button that mints a new one. The API key and client secret come back
 * only in the create/rotate response, so they are rendered in a one-time panel
 * that disappears as soon as the user dismisses it.
 */
export default function PersonalApiKeysCard({
  limits,
  endpoints = {},
  keys = [],
  onCreate,
  onRotate,
  onRevoke,
  busy = false,
  secrets = null,
  onDismissSecrets
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [expirationDays, setExpirationDays] = useState('');
  const [showForm, setShowForm] = useState(false);

  const atLimit = keys.length >= (limits?.maxKeysPerUser ?? 0);

  const endpointRows = [
    { key: 'baseUrl', label: t('integrations.page.apiKeys.endpoints.baseUrl', 'Base URL') },
    {
      key: 'openaiCompatible',
      label: t('integrations.page.apiKeys.endpoints.openaiCompatible', 'OpenAI-compatible API')
    },
    { key: 'mcp', label: t('integrations.page.apiKeys.endpoints.mcp', 'MCP endpoint') },
    { key: 'mcpSse', label: t('integrations.page.apiKeys.endpoints.mcpSse', 'MCP endpoint (SSE)') },
    { key: 'token', label: t('integrations.page.apiKeys.endpoints.token', 'OAuth token endpoint') }
  ].filter(row => endpoints[row.key]);

  const handleCreate = () => {
    onCreate({
      name: name.trim(),
      expirationDays: expirationDays ? Number(expirationDays) : undefined
    });
    setName('');
    setExpirationDays('');
    setShowForm(false);
  };

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex items-start space-x-4">
        <div className="flex-shrink-0">
          <div className="w-12 h-12 bg-indigo-600 rounded-lg flex items-center justify-center">
            <Icon name="key" className="w-7 h-7 text-white" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('integrations.page.apiKeys.title', 'Personal API Key')}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 text-sm">
                {t(
                  'integrations.page.apiKeys.description',
                  'Generate a key that lets external tools call iHub Apps as you, with exactly your permissions.'
                )}
              </p>
            </div>
            <span className="shrink-0 px-3 py-1 text-xs font-medium rounded-full bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300">
              {t('integrations.page.apiKeys.available', 'Available')}
            </span>
          </div>

          {/* One-time credentials, shown only right after create/rotate */}
          {secrets && (
            <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center text-sm font-medium text-amber-800 dark:text-amber-300">
                  <Icon name="warning" className="w-4 h-4 mr-2 shrink-0" />
                  {t(
                    'integrations.page.apiKeys.secretsWarning',
                    'Copy these now — they are shown only once.'
                  )}
                </div>
                <button
                  type="button"
                  onClick={onDismissSecrets}
                  className="shrink-0 p-1 rounded-full text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                  aria-label={t('integrations.page.apiKeys.dismiss', 'Dismiss')}
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>

              <div className="mt-3 space-y-3">
                <CopyField
                  label={t('integrations.page.apiKeys.apiKey', 'API key')}
                  value={secrets.apiKey}
                  secret
                />
                {secrets.clientId && (
                  <CopyField
                    label={t('integrations.page.apiKeys.clientId', 'Client ID')}
                    value={secrets.clientId}
                  />
                )}
                {secrets.clientSecret && (
                  <CopyField
                    label={t('integrations.page.apiKeys.clientSecret', 'Client secret')}
                    value={secrets.clientSecret}
                    secret
                  />
                )}
              </div>
            </div>
          )}

          {/* Endpoints this key can be used against */}
          {endpointRows.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('integrations.page.apiKeys.endpointsTitle', 'Endpoints')}
              </h4>
              <div className="space-y-2">
                {endpointRows.map(row => (
                  <CopyField key={row.key} label={row.label} value={endpoints[row.key]} />
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'integrations.page.apiKeys.usageHint',
                  'Send the API key as an Authorization: Bearer header.'
                )}
              </p>
            </div>
          )}

          {/* Existing keys */}
          <div className="mt-4">
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
              {t('integrations.page.apiKeys.yourKeys', 'Your keys')}
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                {t('integrations.page.apiKeys.keyCount', '{{count}} of {{max}}', {
                  count: keys.length,
                  max: limits?.maxKeysPerUser ?? 0
                })}
              </span>
            </h4>

            {keys.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('integrations.page.apiKeys.noKeys', 'You have not created an API key yet.')}
              </p>
            ) : (
              <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
                {keys.map(key => (
                  <li
                    key={key.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {key.name}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {key.expiresAt
                          ? t('integrations.page.apiKeys.expiresOn', 'Expires {{date}}', {
                              date: formatDate(key.expiresAt, i18n.language)
                            })
                          : t('integrations.page.apiKeys.noExpiry', 'No expiry recorded')}
                        {key.lastUsed &&
                          ` · ${t('integrations.page.apiKeys.lastUsed', 'Last used {{date}}', {
                            date: formatDate(key.lastUsed, i18n.language)
                          })}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRotate(key)}
                        className="inline-flex items-center rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                      >
                        <Icon name="refresh" className="w-4 h-4 mr-1.5" />
                        {t('integrations.page.apiKeys.rotate', 'Rotate')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRevoke(key)}
                        className="inline-flex items-center rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                      >
                        <Icon name="trash" className="w-4 h-4 mr-1.5" />
                        {t('integrations.page.apiKeys.revoke', 'Revoke')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Create */}
          <div className="mt-4">
            {showForm ? (
              <div className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    {t('integrations.page.apiKeys.nameLabel', 'Name (optional)')}
                  </label>
                  <input
                    type="text"
                    value={name}
                    maxLength={60}
                    onChange={e => setName(e.target.value)}
                    placeholder={t('integrations.page.apiKeys.namePlaceholder', 'My laptop')}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    {t('integrations.page.apiKeys.expiryLabel', 'Valid for (days)')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={limits?.maxExpirationDays}
                    value={expirationDays}
                    onChange={e => setExpirationDays(e.target.value)}
                    placeholder={String(limits?.defaultExpirationDays ?? '')}
                    className="w-full sm:w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('integrations.page.apiKeys.expiryHint', 'Maximum {{max}} days', {
                      max: limits?.maxExpirationDays ?? 0
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleCreate}
                    className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <Icon name="key" className="w-4 h-4 mr-2" />
                    {t('integrations.page.apiKeys.create', 'Generate API key')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    {t('common.cancel', 'Cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy || atLimit}
                  onClick={() => setShowForm(true)}
                  className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Icon name="plus" className="w-4 h-4 mr-2" />
                  {t('integrations.page.apiKeys.create', 'Generate API key')}
                </button>
                {atLimit && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    {t(
                      'integrations.page.apiKeys.limitReached',
                      'You have reached the maximum number of API keys. Revoke one to create another.'
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
