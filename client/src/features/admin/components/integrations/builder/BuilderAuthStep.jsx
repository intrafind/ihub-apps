// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CredentialRefSelect } from '../../OpenApiToolEditor';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS, RADIO_CLASS } from '../../formStyles';
import { authKindsFor, authModesFor } from './builderModel';

/** The label of a sign-in mode. */
function modeLabel(t, mode) {
  switch (mode) {
    case 'service-account':
      return t(
        'admin.integrationBuilder.auth.mode.serviceAccount',
        'Service account (one shared credential)'
      );
    case 'oauth-user':
      return t(
        'admin.integrationBuilder.auth.mode.oauthUser',
        'Per-user OAuth (each user signs in)'
      );
    default:
      return t('admin.integrationBuilder.auth.mode.none', 'None (public endpoint)');
  }
}

/** The label of how a credential is sent. */
function kindLabel(t, kind) {
  switch (kind) {
    case 'credential':
      return t(
        'admin.integrationBuilder.auth.kind.credential',
        'As the credential says (bearer, basic, API key, OAuth2)'
      );
    case 'bearer':
      return t('admin.integrationBuilder.auth.kind.bearer', 'Authorization: Bearer <token>');
    case 'header':
      return t('admin.integrationBuilder.auth.kind.header', 'API key in a header');
    case 'basic':
      return t('admin.integrationBuilder.auth.kind.basic', 'Basic auth ("user:password" secret)');
    default:
      return kind;
  }
}

/**
 * Step 2 of the integration builder: how iHub signs in to the system.
 * None; a service account whose credential is picked from the credential
 * store (sent as the credential's type says, as a bearer token, in a named
 * header as an API key, or as basic auth); or, for an MCP server, per-user
 * OAuth (each user connects their own account).
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(patch: Object) => void} props.onChange
 * @param {Object<string, {key: string, defaultValue: string}>} props.errors
 * @returns {JSX.Element}
 */
function BuilderAuthStep({ draft, onChange, errors }) {
  const { t } = useTranslation();
  const groupId = useId();
  const kindId = useId();
  const headerId = useId();
  const prefixId = useId();
  const credentialId = useId();
  const scopesId = useId();
  const clientId = useId();
  const auth = draft.auth || { mode: 'none' };
  const setAuth = patch => onChange({ auth: { ...auth, ...patch } });
  const modes = authModesFor(draft.source);
  const kinds = authKindsFor(draft.source);

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className={LABEL_CLASS}>
          {t('admin.integrationBuilder.auth.mode.label', 'Sign-in')}
        </legend>
        <div className="space-y-2">
          {modes.map(mode => (
            <div key={mode} className="flex items-center gap-2">
              <input
                id={`${groupId}-${mode}`}
                type="radio"
                name={`${groupId}-mode`}
                value={mode}
                checked={auth.mode === mode}
                onChange={() => setAuth({ mode })}
                className={RADIO_CLASS}
              />
              <label
                htmlFor={`${groupId}-${mode}`}
                className="text-sm text-gray-800 dark:text-gray-200"
              >
                {modeLabel(t, mode)}
              </label>
            </div>
          ))}
        </div>
        {draft.source === 'script' && (
          <p className={HELP_CLASS}>
            {t(
              'admin.integrationBuilder.auth.scriptHelp',
              'A script integration signs in itself: its module reads its settings from ctx.values.'
            )}
          </p>
        )}
      </fieldset>

      {auth.mode === 'service-account' && (
        <>
          <CredentialRefSelect
            id={credentialId}
            value={auth.credentialRef || ''}
            onChange={credentialRef => setAuth({ credentialRef })}
            label={t('admin.integrationBuilder.auth.credential', 'Credential')}
            required
            help={
              errors.credentialRef
                ? t(errors.credentialRef.key, errors.credentialRef.defaultValue)
                : t(
                    'admin.integrationBuilder.auth.credentialHelp',
                    'Secrets live in the credential store; the integration only references one.'
                  )
            }
          />
          <div>
            <label htmlFor={kindId} className={LABEL_CLASS}>
              {t('admin.integrationBuilder.auth.kind.label', 'How the credential is sent')}
            </label>
            <select
              id={kindId}
              value={auth.kind}
              onChange={e => setAuth({ kind: e.target.value })}
              className={INPUT_CLASS}
            >
              {kinds.map(kind => (
                <option key={kind} value={kind}>
                  {kindLabel(t, kind)}
                </option>
              ))}
            </select>
          </div>
          {auth.kind === 'header' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor={headerId} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.auth.header', 'Header name')}
                </label>
                <input
                  id={headerId}
                  type="text"
                  value={auth.header || ''}
                  onChange={e => setAuth({ header: e.target.value })}
                  className={INPUT_CLASS}
                  placeholder="X-API-Key"
                  aria-invalid={Boolean(errors.header)}
                />
                {errors.header && (
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                    {t(errors.header.key, errors.header.defaultValue)}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor={prefixId} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.auth.prefix', 'Value prefix (optional)')}
                </label>
                <input
                  id={prefixId}
                  type="text"
                  value={auth.valuePrefix || ''}
                  onChange={e => setAuth({ valuePrefix: e.target.value })}
                  className={INPUT_CLASS}
                  placeholder="Token "
                />
              </div>
            </div>
          )}
        </>
      )}

      {auth.mode === 'oauth-user' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={scopesId} className={LABEL_CLASS}>
              {t('admin.integrationBuilder.auth.scopes', 'Scopes (optional, space-separated)')}
            </label>
            <input
              id={scopesId}
              type="text"
              value={(auth.oauthScopes || []).join(' ')}
              onChange={e => setAuth({ oauthScopes: e.target.value.split(/\s+/).filter(Boolean) })}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label htmlFor={clientId} className={LABEL_CLASS}>
              {t('admin.integrationBuilder.auth.clientId', 'Client ID (optional)')}
            </label>
            <input
              id={clientId}
              type="text"
              value={auth.oauthClientId || ''}
              onChange={e => setAuth({ oauthClientId: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          <p className={`${HELP_CLASS} sm:col-span-2`}>
            {t(
              'admin.integrationBuilder.auth.oauthHelp',
              'Without a client ID iHub registers itself with the server (dynamic client registration or a client ID metadata document).'
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export default BuilderAuthStep;
