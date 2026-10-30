// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import Icon from '../../../shared/components/Icon';

const INPUT_CLASS =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';

const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
const HELP_CLASS = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

const GRANT_TYPES = ['tokenExchange', 'entraObo'];

/**
 * Settings of the iFinder token exchange (`platform.iFinder.tokenExchange`):
 * which OIDC provider iHub shares with iFinder, the grant, an optional
 * separate exchange client, the audience and the scope map.
 */
export default function IFinderTokenExchangeSettings({
  t,
  settings,
  oidcProviders,
  onChange,
  scopeMapEntries,
  setScopeMapEntries
}) {
  const isObo = settings.grantType === 'entraObo';

  const updateEntry = (index, key, value) => {
    const next = scopeMapEntries.map((entry, i) => (i === index ? [key, value] : entry));
    setScopeMapEntries(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="iFinderExchangeProvider" className={LABEL_CLASS}>
          {t('admin.iFinder.tokenExchange.provider', 'OIDC provider')} *
        </label>
        <select
          id="iFinderExchangeProvider"
          value={settings.oidcProvider}
          onChange={e => onChange('oidcProvider', e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">
            {t('admin.iFinder.tokenExchange.selectProvider', 'Select a provider…')}
          </option>
          {oidcProviders.map(provider => (
            <option key={provider.name} value={provider.name}>
              {provider.displayName || provider.name}
              {provider.enabled === false
                ? ` (${t('admin.iFinder.tokenExchange.providerDisabled', 'disabled')})`
                : ''}
            </option>
          ))}
        </select>
        <p className={HELP_CLASS}>
          {oidcProviders.length === 0
            ? t(
                'admin.iFinder.tokenExchange.noProviders',
                'No OIDC provider is configured. Add the provider iFinder uses under Admin > Authentication first.'
              )
            : t(
                'admin.iFinder.tokenExchange.providerHelp',
                'The provider iHub and iFinder share. Its sign-in tokens are kept (encrypted) and exchanged for iFinder tokens with the client ID and secret configured for it under Admin > Authentication. Add "offline_access" to its scopes so background runs keep working.'
              )}
        </p>
      </div>

      <div>
        <label htmlFor="iFinderExchangeGrant" className={LABEL_CLASS}>
          {t('admin.iFinder.tokenExchange.grantType', 'Grant type')}
        </label>
        <select
          id="iFinderExchangeGrant"
          value={settings.grantType}
          onChange={e => onChange('grantType', e.target.value)}
          className={INPUT_CLASS}
        >
          {GRANT_TYPES.map(grant => (
            <option key={grant} value={grant}>
              {grant === 'entraObo'
                ? t(
                    'admin.iFinder.tokenExchange.grantEntraObo',
                    'On-Behalf-Of (Microsoft Entra ID)'
                  )
                : t(
                    'admin.iFinder.tokenExchange.grantTokenExchange',
                    'Token exchange (RFC 8693: Zitadel, Keycloak)'
                  )}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="iFinderExchangeAudience" className={LABEL_CLASS}>
          {t('admin.iFinder.tokenExchange.audience', 'Audience')}
        </label>
        <input
          id="iFinderExchangeAudience"
          type="text"
          value={settings.audience}
          onChange={e => onChange('audience', e.target.value)}
          className={INPUT_CLASS}
          disabled={isObo}
          placeholder={isObo ? '' : 'ifinder'}
        />
        <p className={HELP_CLASS}>
          {isObo
            ? t(
                'admin.iFinder.tokenExchange.audienceObo',
                'Not used by On-Behalf-Of: Entra takes the audience from the scope (api://<ifinder-app-id>/.default).'
              )
            : t(
                'admin.iFinder.tokenExchange.audienceHelp',
                'The client or project id of iFinder at the provider. The issued token carries it as "aud".'
              )}
        </p>
      </div>

      <div>
        <span className={LABEL_CLASS}>
          {t('admin.iFinder.tokenExchange.scopeMap', 'Scope map')}
        </span>
        <p className={`${HELP_CLASS} mb-2`}>
          {t(
            'admin.iFinder.tokenExchange.scopeMapHelp',
            'Translates the scopes iHub asks for into the scopes of the provider (Zitadel role scopes, Entra api://…/.default). An empty value sends the iHub scope unchanged.'
          )}
        </p>
        <div className="space-y-2">
          {scopeMapEntries.map(([key, value], index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={key}
                onChange={e => updateEntry(index, e.target.value, value)}
                className={`${INPUT_CLASS} font-mono text-sm`}
                aria-label={t('admin.iFinder.tokenExchange.ihubScope', 'iHub scope')}
                placeholder="fa_index_read"
              />
              <Icon name="arrow-right" size="sm" className="text-gray-400 shrink-0" />
              <input
                type="text"
                value={value}
                onChange={e => updateEntry(index, key, e.target.value)}
                className={`${INPUT_CLASS} font-mono text-sm`}
                aria-label={t('admin.iFinder.tokenExchange.providerScope', 'Provider scope')}
                placeholder={t('admin.iFinder.tokenExchange.unchanged', '(unchanged)')}
              />
              <button
                type="button"
                onClick={() => setScopeMapEntries(scopeMapEntries.filter((_, i) => i !== index))}
                className="p-2 text-gray-500 hover:text-red-600"
                aria-label={t('admin.iFinder.tokenExchange.removeScope', 'Remove scope')}
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setScopeMapEntries([...scopeMapEntries, ['', '']])}
            className="inline-flex items-center text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700"
          >
            <Icon name="plus" size="sm" className="mr-1" />
            {t('admin.iFinder.tokenExchange.addScope', 'Add scope')}
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="iFinderExchangeExtraScopes" className={LABEL_CLASS}>
          {t('admin.iFinder.tokenExchange.extraScopes', 'Additional scopes')}
        </label>
        <input
          id="iFinderExchangeExtraScopes"
          type="text"
          value={(settings.extraScopes || []).join(' ')}
          onChange={e => onChange('extraScopes', e.target.value.split(/\s+/).filter(Boolean))}
          className={`${INPUT_CLASS} font-mono text-sm`}
          placeholder="urn:zitadel:iam:org:project:id:<id>:aud"
        />
        <p className={HELP_CLASS}>
          {t(
            'admin.iFinder.tokenExchange.extraScopesHelp',
            'Space-separated scopes sent with every exchange.'
          )}
        </p>
      </div>

      <div className="border rounded-md p-4 bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800">
        <div className="flex">
          <Icon name="info" size="md" className="mt-0.5 mr-3 shrink-0 text-indigo-500" />
          <div className="text-sm text-indigo-800 dark:text-indigo-200">
            <p className="font-medium">
              {t('admin.iFinder.tokenExchange.ifinderSetupTitle', 'Configure iFinder with:')}
            </p>
            <pre className="mt-2 text-xs bg-indigo-100 dark:bg-indigo-900/40 rounded-sm p-2 font-mono whitespace-pre-wrap">
              {`spring.security.oauth2.resourceserver.jwt.issuer-uri: <${t(
                'admin.iFinder.tokenExchange.providerIssuer',
                'issuer URL of the provider'
              )}>\nintrafind.security.auth.enable-oauth2-resource-server: true`}
            </pre>
            <p className="mt-2 text-indigo-700 dark:text-indigo-300">
              {t(
                'admin.iFinder.tokenExchange.ifinderSetupHelp',
                'The token iHub sends must also carry the fa_* claims iFinder reads, either as requested scopes or added by a claim mapper on the provider. The connection test below shows which ones are present.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
