// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../../formStyles';
import { FieldError } from './InstallationEditorParts';
import { GRANT_TYPES, TOKEN_EXCHANGE_SCOPES, parseScopeList } from './iFinderEditorModel';

const K = 'admin.integrations.editors.ifinder.tokenExchange';

/**
 * The token exchange settings of the iFinder installation (shown while
 * "Token issuer" is the shared OIDC provider): which provider iHub shares
 * with iFinder, the grant, the audience, how iHub's scopes map to the
 * provider's, and extra scopes. Restored from the editor that configured
 * `platform.iFinder.tokenExchange`; the values are now the installation's
 * `tokenExchange*` values (see `iFinderEditorModel.js`).
 *
 * @param {Object} props
 * @param {Object} props.values - the editor's values
 * @param {Array<{ name: string, displayName?: string, enabled?: boolean }>} props.oidcProviders
 * @param {(key: string, value: unknown) => void} props.onChange
 * @param {Object<string,string>} [props.fieldErrors]
 */
export default function IFinderTokenExchangeSettings({
  values,
  oidcProviders,
  onChange,
  fieldErrors = {}
}) {
  const { t } = useTranslation();
  const isObo = values.tokenExchangeGrant === 'entraObo';
  // Typed as text (a trailing space must survive typing), stored as a list.
  const [extraScopesText, setExtraScopesText] = useState(() =>
    (values.tokenExchangeExtraScopes || []).join(' ')
  );

  return (
    <div className="space-y-4" data-testid="ifinder-token-exchange">
      <div>
        <label htmlFor="ifinder-exchange-provider" className={LABEL_CLASS}>
          {t(`${K}.provider`, 'OIDC provider')}
          <span className="text-red-600 dark:text-red-400 ml-0.5">*</span>
        </label>
        <select
          id="ifinder-exchange-provider"
          value={values.tokenExchangeProvider || ''}
          onChange={e => onChange('tokenExchangeProvider', e.target.value)}
          className={INPUT_CLASS}
          aria-describedby="ifinder-exchange-provider-help"
          aria-invalid={fieldErrors.tokenExchangeProvider ? 'true' : undefined}
        >
          <option value="">{t(`${K}.selectProvider`, 'Select a provider…')}</option>
          {values.tokenExchangeProvider &&
            !oidcProviders.some(p => p.name === values.tokenExchangeProvider) && (
              <option value={values.tokenExchangeProvider}>{values.tokenExchangeProvider}</option>
            )}
          {oidcProviders.map(provider => (
            <option key={provider.name} value={provider.name}>
              {provider.displayName || provider.name}
              {provider.enabled === false ? ` (${t(`${K}.providerDisabled`, 'disabled')})` : ''}
            </option>
          ))}
        </select>
        <p id="ifinder-exchange-provider-help" className={HELP_CLASS}>
          {oidcProviders.length === 0
            ? t(
                `${K}.noProviders`,
                'No OIDC provider is configured. Add the provider iFinder uses under Admin → Authentication first.'
              )
            : t(
                `${K}.providerHelp`,
                'The provider iHub and iFinder share. Its sign-in tokens are kept (encrypted) and exchanged for iFinder tokens with the client ID and secret configured for it under Admin → Authentication. Add "offline_access" to its scopes so background runs keep working.'
              )}
        </p>
        <FieldError message={fieldErrors.tokenExchangeProvider} />
      </div>

      <div>
        <label htmlFor="ifinder-exchange-grant" className={LABEL_CLASS}>
          {t(`${K}.grantType`, 'Grant type')}
        </label>
        <select
          id="ifinder-exchange-grant"
          value={values.tokenExchangeGrant || 'tokenExchange'}
          onChange={e => onChange('tokenExchangeGrant', e.target.value)}
          className={INPUT_CLASS}
        >
          {GRANT_TYPES.map(grant => (
            <option key={grant} value={grant}>
              {grant === 'entraObo'
                ? t(`${K}.grantEntraObo`, 'On-Behalf-Of (Microsoft Entra ID)')
                : t(`${K}.grantTokenExchange`, 'Token exchange (RFC 8693: Zitadel, Keycloak)')}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="ifinder-exchange-audience" className={LABEL_CLASS}>
          {t(`${K}.audience`, 'Audience')}
        </label>
        <input
          id="ifinder-exchange-audience"
          type="text"
          value={values.tokenExchangeAudience || ''}
          onChange={e => onChange('tokenExchangeAudience', e.target.value)}
          className={INPUT_CLASS}
          disabled={isObo}
          placeholder={isObo ? '' : 'ifinder'}
          aria-describedby="ifinder-exchange-audience-help"
        />
        <p id="ifinder-exchange-audience-help" className={HELP_CLASS}>
          {isObo
            ? t(
                `${K}.audienceObo`,
                'Not used by On-Behalf-Of: Entra takes the audience from the scope (api://<ifinder-app-id>/.default).'
              )
            : t(
                `${K}.audienceHelp`,
                'The client or project id of iFinder at the provider. The issued token carries it as "aud".'
              )}
        </p>
      </div>

      <fieldset>
        <legend className={LABEL_CLASS}>{t(`${K}.scopeMap`, 'Scope map')}</legend>
        <p className={`${HELP_CLASS} mb-2`}>
          {t(
            `${K}.scopeMapHelp`,
            'Translates the scopes iHub asks for into the scopes of the provider (Zitadel role scopes, Entra api://…/.default). An empty value sends the iHub scope unchanged.'
          )}
        </p>
        <div className="space-y-2">
          {TOKEN_EXCHANGE_SCOPES.map(({ scope, key }) => (
            <div key={key} className="flex items-center gap-2">
              <span
                className="w-44 shrink-0 font-mono text-sm text-gray-800 dark:text-gray-200"
                id={`ifinder-scope-${scope}`}
              >
                {scope}
              </span>
              <Icon name="arrow-right" size="sm" className="text-gray-400 shrink-0" />
              <input
                type="text"
                value={values[key] || ''}
                onChange={e => onChange(key, e.target.value)}
                className={`${INPUT_CLASS} font-mono`}
                aria-label={t(`${K}.providerScopeFor`, 'Provider scope for {{scope}}', { scope })}
                placeholder={t(`${K}.unchanged`, '(unchanged)')}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="ifinder-exchange-extra-scopes" className={LABEL_CLASS}>
          {t(`${K}.extraScopes`, 'Additional scopes')}
        </label>
        <input
          id="ifinder-exchange-extra-scopes"
          type="text"
          value={extraScopesText}
          onChange={e => {
            setExtraScopesText(e.target.value);
            onChange('tokenExchangeExtraScopes', parseScopeList(e.target.value));
          }}
          className={`${INPUT_CLASS} font-mono`}
          placeholder="urn:zitadel:iam:org:project:id:<id>:aud"
          aria-describedby="ifinder-exchange-extra-scopes-help"
        />
        <p id="ifinder-exchange-extra-scopes-help" className={HELP_CLASS}>
          {t(`${K}.extraScopesHelp`, 'Space-separated scopes sent with every exchange.')}
        </p>
      </div>

      <div className="border rounded-md p-4 bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800">
        <div className="flex">
          <Icon
            name="information-circle"
            size="md"
            className="mt-0.5 mr-3 shrink-0 text-indigo-600 dark:text-indigo-300"
          />
          <div className="text-sm text-indigo-900 dark:text-indigo-100">
            <p className="font-medium">{t(`${K}.ifinderSetupTitle`, 'Configure iFinder with:')}</p>
            <pre className="mt-2 text-xs bg-indigo-100 dark:bg-indigo-900/40 rounded-sm p-2 font-mono whitespace-pre-wrap">
              {`spring.security.oauth2.resourceserver.jwt.issuer-uri: <${t(
                `${K}.providerIssuer`,
                'issuer URL of the provider'
              )}>\nintrafind.security.auth.enable-oauth2-resource-server: true`}
            </pre>
            <p className="mt-2 text-indigo-800 dark:text-indigo-200">
              {t(
                `${K}.ifinderSetupHelp`,
                'The token iHub sends must also carry the fa_* claims iFinder reads, either as requested scopes or added by a claim mapper on the provider. The connection test shows which ones are present.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
