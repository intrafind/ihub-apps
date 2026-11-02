// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import { getBasePath } from '../../../../../utils/runtimeBasePath';
import { fetchAdminPlatformConfig } from '../../../../../api/adminApi';
import { CredentialRefSelect } from '../../OpenApiToolEditor';
import ConfigFieldInput from '../ConfigFieldInput';
import {
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS
} from '../../formStyles';
import useInstallationEditor from './useInstallationEditor';
import {
  AccessSection,
  ActionsSection,
  EditorFooter,
  EditorSection,
  FieldError,
  NameSection
} from './InstallationEditorParts';
import IFinderTokenExchangeSettings from './IFinderTokenExchangeSettings';
import {
  ALGORITHM_OPTIONS,
  AUTH_MODES,
  CUSTOM_SUBJECT_TEMPLATE,
  JWT_SUBJECT_OPTIONS,
  effectiveIssuer,
  iFinderEditorValues,
  isCustomSubject,
  parseProfileList,
  validateIFinderValues
} from './iFinderEditorModel';

const K = 'admin.integrations.editors.ifinder';
const FORM_ID = 'ifinder-editor-form';

/**
 * Install fields the editor has no section of its own for: rarely changed
 * paths and limits, offered under "Advanced" with the definition's own
 * titles and help texts.
 */
const ADVANCED_KEYS = Object.freeze([
  'searchProfileApplication',
  'timeout',
  'downloadDir',
  'searchEndpoint',
  'documentEndpoint',
  'fieldsEndpoint',
  'facetsEndpoint'
]);

/** The URL iHub would publish as its issuer, as `server/routes/wellKnown.js` derives it. */
function detectedIssuer() {
  if (typeof window === 'undefined') return '';
  const basePath = getBasePath();
  return basePath ? `${window.location.origin}${basePath}` : window.location.origin;
}

/**
 * The dedicated editor of the iFinder installation (`com.intrafind/ifinder`,
 * installation `ifinder`): the editor iFinder had on the Providers page
 * before it became an installation, now reading the installation
 * (`GET /api/admin/integrations/installed/ifinder`) and saving it
 * (`PUT …/installed/ifinder`).
 *
 * Sections: name; connection (base URL, who issues the token, the OIDC key
 * pair with the effective issuer and the iFinder settings to copy, the
 * private key, algorithm, lifetime, issuer, audience, scope and the user
 * identity sent to iFinder, or the token exchange settings); search profiles;
 * advanced paths and limits; who may use it; the actions.
 *
 * **Test connection** runs the connector's diagnostics against the unsaved
 * values (`POST …/installed/ifinder/_test`) as the signed-in admin.
 *
 * Registered in `editors/index.js`; the props are the editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values` and `liveActions`
 * @param {Object} props.definition - the definition detail (install fields, actions)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function IFinderEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const lang = editor.lang;

  const [values, setValues] = useState(() => iFinderEditorValues(instance.values));
  // The allow-list is edited as text, one profile id per line, and parsed on save.
  const [allowedProfilesText, setAllowedProfilesText] = useState(() =>
    (Array.isArray(instance.values?.allowedSearchProfiles)
      ? instance.values.allowedSearchProfiles
      : []
    ).join('\n')
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [oidcProviders, setOidcProviders] = useState([]);
  const [oauthIssuer, setOauthIssuer] = useState('');
  const autoDetectedIssuer = useMemo(() => detectedIssuer(), []);

  // The OIDC providers (token exchange) and the OAuth issuer (OIDC key pair)
  // live in platform.json; the editor works without them.
  useEffect(() => {
    let cancelled = false;
    fetchAdminPlatformConfig()
      .then(platform => {
        if (cancelled) return;
        setOidcProviders(
          Array.isArray(platform?.oidcAuth?.providers) ? platform.oidcAuth.providers : []
        );
        setOauthIssuer(platform?.oauth?.issuer || '');
      })
      .catch(() => {
        if (!cancelled) setOidcProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fieldByKey = useMemo(
    () => Object.fromEntries((definition?.install || []).map(field => [field.key, field])),
    [definition]
  );
  const advancedFields = ADVANCED_KEYS.map(key => fieldByKey[key]).filter(Boolean);
  const privateKeyField = fieldByKey.privateKeyRef;

  const setValue = (key, value) => setValues(prev => ({ ...prev, [key]: value }));
  const isExchangeMode = values.authMode === 'oidcTokenExchange';
  const issuer = effectiveIssuer(oauthIssuer, autoDetectedIssuer);
  const issuerReady = issuer.startsWith('http');
  const customSubject = isCustomSubject(values.jwtSubjectField);
  const errors = editor.fieldErrors;

  /** The values to test or save: the edited ones plus the parsed profile list. */
  const valuesToSend = () => ({
    ...values,
    allowedSearchProfiles: parseProfileList(allowedProfilesText)
  });

  const submit = event => {
    event.preventDefault();
    const problem = validateIFinderValues(values, { issuer });
    if (problem) {
      editor.reject(problem.key, t(problem.messageKey, problem.messageDefault));
      return;
    }
    void editor.save(valuesToSend());
  };

  const numberValue = (key, fallback) => event => {
    const parsed = Number.parseInt(event.target.value, 10);
    setValue(key, Number.isFinite(parsed) ? parsed : fallback);
  };

  const jwtFields = (
    <>
      {!values.useOidcKeyPair && (
        <>
          <div>
            <CredentialRefSelect
              id="ifinder-private-key"
              value={values.privateKeyRef || ''}
              onChange={id => setValue('privateKeyRef', id)}
              types={privateKeyField?.credentialTypes || ['privateKey', 'secret']}
              label={t(`${K}.privateKey`, 'Private key')}
              help={t(
                `${K}.privateKeyHelp`,
                'The stored credential holding the RSA or EC private key (PEM) that signs the iFinder JWT. Alternatively set the IFINDER_PRIVATE_KEY environment variable on the server.'
              )}
              required
            />
            <FieldError message={errors.privateKeyRef} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="ifinder-algorithm" className={LABEL_CLASS}>
                {t(`${K}.algorithm`, 'JWT algorithm')}
              </label>
              <select
                id="ifinder-algorithm"
                value={values.algorithm}
                onChange={e => setValue('algorithm', e.target.value)}
                className={INPUT_CLASS}
              >
                {ALGORITHM_OPTIONS.map(algorithm => (
                  <option key={algorithm} value={algorithm}>
                    {algorithm}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ifinder-issuer" className={LABEL_CLASS}>
                {t(`${K}.issuer`, 'JWT issuer')}
              </label>
              <input
                id="ifinder-issuer"
                type="text"
                value={values.issuer}
                onChange={e => setValue('issuer', e.target.value)}
                className={INPUT_CLASS}
                placeholder="ihub-apps"
              />
            </div>
          </div>
        </>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="ifinder-audience" className={LABEL_CLASS}>
            {t(`${K}.audience`, 'JWT audience')}
          </label>
          <input
            id="ifinder-audience"
            type="text"
            value={values.audience}
            onChange={e => setValue('audience', e.target.value)}
            className={INPUT_CLASS}
            placeholder="ifinder-api"
          />
        </div>
        <div>
          <label htmlFor="ifinder-token-expiration" className={LABEL_CLASS}>
            {t(`${K}.tokenExpiration`, 'Token lifetime (seconds)')}
          </label>
          <input
            id="ifinder-token-expiration"
            type="number"
            min={60}
            max={86400}
            value={values.tokenExpirationSeconds}
            onChange={numberValue('tokenExpirationSeconds', 3600)}
            className={INPUT_CLASS}
          />
        </div>
      </div>
    </>
  );

  const keyPairStatus = values.useOidcKeyPair && (
    <>
      <div>
        <span className={LABEL_CLASS} id="ifinder-effective-issuer-label">
          {t(`${K}.effectiveIssuer`, 'Effective OAuth issuer URL')}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="flex-1 min-w-0 break-all px-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md text-gray-900 dark:text-gray-100"
            aria-labelledby="ifinder-effective-issuer-label"
          >
            {issuer || t(`${K}.issuerNotAvailable`, 'Not available')}
          </code>
          {!oauthIssuer && autoDetectedIssuer && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200">
              {t(`${K}.autoDetected`, 'Auto-detected')}
            </span>
          )}
        </div>
        <p className={HELP_CLASS}>
          {oauthIssuer
            ? t(`${K}.effectiveIssuerConfiguredHelp`, 'Configured under Admin → OAuth Server.')
            : t(
                `${K}.effectiveIssuerAutoHelp`,
                'Detected from your server URL. Set a custom issuer under Admin → OAuth Server if needed.'
              )}
        </p>
      </div>
      <div
        className={`border rounded-md p-4 ${
          issuerReady
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
        }`}
        data-testid="ifinder-keypair-status"
      >
        <div className="flex">
          <Icon
            name={issuerReady ? 'check' : 'warning'}
            size="md"
            className={`mt-0.5 mr-3 shrink-0 ${
              issuerReady
                ? 'text-green-600 dark:text-green-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          />
          <div className="text-sm min-w-0">
            {issuerReady ? (
              <>
                <p className="font-medium text-green-800 dark:text-green-200">
                  {t(`${K}.oidcKeyPairReady`, 'OIDC key pair ready')}
                </p>
                <p className="mt-1 text-green-700 dark:text-green-300">
                  {t(`${K}.oidcKeyPairReadyHelp`, 'Configure iFinder with:')}
                </p>
                <pre className="mt-2 text-xs bg-green-100 dark:bg-green-900/40 rounded-sm p-2 font-mono text-green-800 dark:text-green-200 whitespace-pre-wrap break-all">
                  {`spring.security.oauth2.resourceserver.jwt.issuer-uri: ${issuer}\nintrafind.security.auth.enable-oauth2-resource-server: true`}
                </pre>
              </>
            ) : (
              <>
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  {t(`${K}.oidcKeyPairMissingIssuer`, 'OAuth issuer URL required')}
                </p>
                <p className="mt-1 text-amber-700 dark:text-amber-300">
                  {t(
                    `${K}.oidcKeyPairMissingIssuerHelp`,
                    'Set the OAuth issuer URL under Admin → Authentication → OAuth Server before saving.'
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="space-y-5" data-testid="ifinder-editor">
      <form id={FORM_ID} onSubmit={submit} className="space-y-5" noValidate>
        <div className="bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 rounded-md p-4">
          <div className="flex">
            <Icon
              name="info"
              size="md"
              className="text-indigo-600 dark:text-indigo-300 mt-0.5 mr-3 shrink-0"
            />
            <div>
              <h3 className="text-sm font-medium text-indigo-800 dark:text-indigo-200">
                {t(`${K}.info.title`, 'iFinder JWT authentication')}
              </h3>
              <p className="text-sm text-indigo-700 dark:text-indigo-300 mt-1">
                {t(
                  `${K}.info.description`,
                  'Every call runs as the signed-in user: iHub signs a JWT for the user, or exchanges the user’s sign-in token at a shared OIDC provider. iAssistant runs on this connection.'
                )}
              </p>
            </div>
          </div>
        </div>

        <NameSection editor={editor} definition={definition} idPrefix="ifinder" />

        <EditorSection
          id="ifinder-connection"
          title={t(`${K}.connectionSection`, 'iFinder connection')}
        >
          <div>
            <label htmlFor="ifinder-base-url" className={LABEL_CLASS}>
              {t(`${K}.baseUrl`, 'iFinder base URL')}
              <span className="text-red-600 dark:text-red-400 ml-0.5">*</span>
            </label>
            <input
              id="ifinder-base-url"
              type="url"
              required
              value={values.baseUrl}
              onChange={e => setValue('baseUrl', e.target.value)}
              className={INPUT_CLASS}
              placeholder="https://ifinder.example.com"
              aria-invalid={errors.baseUrl ? 'true' : undefined}
              aria-describedby="ifinder-base-url-help"
            />
            <p id="ifinder-base-url-help" className={HELP_CLASS}>
              {t(
                `${K}.baseUrlHelp`,
                'Your iFinder / iAssistant server; the API paths are appended.'
              )}
            </p>
            <FieldError message={errors.baseUrl} />
          </div>

          <div>
            <label htmlFor="ifinder-auth-mode" className={LABEL_CLASS}>
              {t(`${K}.authMode.label`, 'Token issuer')}
            </label>
            <select
              id="ifinder-auth-mode"
              value={values.authMode || 'ihubSigned'}
              onChange={e => setValue('authMode', e.target.value)}
              className={INPUT_CLASS}
              aria-describedby="ifinder-auth-mode-help"
            >
              {AUTH_MODES.map(mode => (
                <option key={mode} value={mode}>
                  {mode === 'ihubSigned'
                    ? t(`${K}.authMode.ihubSigned`, 'iHub signs the token')
                    : t(`${K}.authMode.oidcTokenExchange`, 'Shared OIDC provider (token exchange)')}
                </option>
              ))}
            </select>
            <p id="ifinder-auth-mode-help" className={HELP_CLASS}>
              {isExchangeMode
                ? t(
                    `${K}.authMode.oidcTokenExchangeHelp`,
                    'iHub and iFinder share one OIDC provider. iHub keeps the sign-in token of each user and exchanges it at the provider for a token for iFinder. Users must sign in to iHub through that provider; background runs use the stored refresh token.'
                  )
                : t(
                    `${K}.authMode.ihubSignedHelp`,
                    'iHub signs the iFinder token itself, with a private key or the iHub OIDC key pair. iFinder trusts iHub as the issuer.'
                  )}
            </p>
          </div>

          {isExchangeMode ? (
            <IFinderTokenExchangeSettings
              values={values}
              oidcProviders={oidcProviders}
              onChange={setValue}
              fieldErrors={errors}
            />
          ) : (
            <>
              <div>
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    id="ifinder-use-oidc-key-pair"
                    checked={values.useOidcKeyPair === true}
                    onChange={e => setValue('useOidcKeyPair', e.target.checked)}
                    className={`${CHECKBOX_CLASS} mt-0.5`}
                    aria-describedby="ifinder-use-oidc-key-pair-help"
                  />
                  <label
                    htmlFor="ifinder-use-oidc-key-pair"
                    className="text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t(`${K}.useOidcKeyPair`, 'Sign with the iHub OIDC key pair')}
                  </label>
                </div>
                <p id="ifinder-use-oidc-key-pair-help" className={`${HELP_CLASS} ml-6`}>
                  {t(
                    `${K}.useOidcKeyPairHelp`,
                    'Tokens are signed with the RSA key of the iHub OIDC server. iFinder validates them through JWKS discovery (/.well-known/jwks.json); no key has to be distributed.'
                  )}
                </p>
                <FieldError message={errors.useOidcKeyPair} />
              </div>
              {keyPairStatus}
              {jwtFields}
            </>
          )}

          <div>
            <label htmlFor="ifinder-default-scope" className={LABEL_CLASS}>
              {t(`${K}.defaultScope`, 'Token scope')}
            </label>
            <input
              id="ifinder-default-scope"
              type="text"
              value={values.defaultScope}
              onChange={e => setValue('defaultScope', e.target.value)}
              className={MONO_INPUT_CLASS}
              placeholder="fa_index_read"
            />
          </div>

          {!isExchangeMode && (
            <>
              <div>
                <label htmlFor="ifinder-jwt-subject" className={LABEL_CLASS}>
                  {t(`${K}.jwtSubjectField`, 'User identity sent to iFinder')}
                </label>
                <select
                  id="ifinder-jwt-subject"
                  value={customSubject ? 'custom' : values.jwtSubjectField}
                  onChange={e =>
                    setValue(
                      'jwtSubjectField',
                      e.target.value === 'custom' ? CUSTOM_SUBJECT_TEMPLATE : e.target.value
                    )
                  }
                  className={INPUT_CLASS}
                  aria-describedby="ifinder-jwt-subject-help"
                >
                  {JWT_SUBJECT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {t(`${K}.jwtSubject.${option.labelKey}`, option.labelDefault)}
                    </option>
                  ))}
                  <option value="custom">{t(`${K}.jwtSubject.custom`, 'Custom template')}</option>
                </select>
                <p id="ifinder-jwt-subject-help" className={HELP_CLASS}>
                  {t(
                    `${K}.jwtSubjectFieldHelp`,
                    'The "sub" claim of the iFinder JWT: which user attribute identifies the user, as iFinder knows them.'
                  )}
                </p>
              </div>
              {customSubject && (
                <div>
                  <label htmlFor="ifinder-jwt-subject-template" className={LABEL_CLASS}>
                    {t(`${K}.jwtSubjectTemplate`, 'Custom subject template')}
                  </label>
                  <input
                    id="ifinder-jwt-subject-template"
                    type="text"
                    value={values.jwtSubjectField}
                    onChange={e => setValue('jwtSubjectField', e.target.value)}
                    className={MONO_INPUT_CLASS}
                    placeholder={String.raw`CONTOSO\${user.username}`}
                    aria-describedby="ifinder-jwt-subject-template-help"
                  />
                  <p id="ifinder-jwt-subject-template-help" className={HELP_CLASS}>
                    {t(
                      `${K}.jwtSubjectTemplateHelp`,
                      'Placeholders: ${user.email}, ${user.username}, ${user.domain}, ${user.id}, ${user.name}.'
                    )}
                  </p>
                  <FieldError message={errors.jwtSubjectField} />
                </div>
              )}
            </>
          )}
        </EditorSection>

        <EditorSection
          id="ifinder-search"
          title={t(`${K}.searchSection`, 'Search profiles')}
          description={t(
            `${K}.searchSectionHelp`,
            'Which iFinder search profile a chat searches, and which ones users may pick.'
          )}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="ifinder-default-search-profile" className={LABEL_CLASS}>
                {t(`${K}.defaultSearchProfile`, 'Default search profile')}
              </label>
              <input
                id="ifinder-default-search-profile"
                type="text"
                value={values.defaultSearchProfile || ''}
                onChange={e => setValue('defaultSearchProfile', e.target.value)}
                className={MONO_INPUT_CLASS}
                placeholder="searchprofile-standard"
                aria-describedby="ifinder-default-search-profile-help"
              />
              <p id="ifinder-default-search-profile-help" className={HELP_CLASS}>
                {t(
                  `${K}.defaultSearchProfileHelp`,
                  'The search profile a chat searches until the user picks another one.'
                )}
              </p>
            </div>
            <div>
              <label htmlFor="ifinder-allowed-search-profiles" className={LABEL_CLASS}>
                {t(`${K}.allowedSearchProfiles`, 'Search profiles users may pick')}
              </label>
              <textarea
                id="ifinder-allowed-search-profiles"
                rows={3}
                value={allowedProfilesText}
                onChange={e => setAllowedProfilesText(e.target.value)}
                className={MONO_INPUT_CLASS}
                placeholder={t(
                  `${K}.allowedSearchProfilesPlaceholder`,
                  "All of the user's profiles"
                )}
                aria-describedby="ifinder-allowed-search-profiles-help"
              />
              <p id="ifinder-allowed-search-profiles-help" className={HELP_CLASS}>
                {t(
                  `${K}.allowedSearchProfilesHelp`,
                  'One search profile id per line. Empty offers every profile the user has in iFinder.'
                )}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <input
              id="ifinder-allow-user-search-profile-change"
              type="checkbox"
              checked={values.allowUserSearchProfileChange !== false}
              onChange={e => setValue('allowUserSearchProfileChange', e.target.checked)}
              className={`${CHECKBOX_CLASS} mt-0.5`}
              aria-describedby="ifinder-allow-user-search-profile-change-help"
            />
            <span>
              <label
                htmlFor="ifinder-allow-user-search-profile-change"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t(`${K}.allowUserSearchProfileChange`, 'Users may change the search profile')}
              </label>
              <span id="ifinder-allow-user-search-profile-change-help" className={HELP_CLASS}>
                {t(
                  `${K}.allowUserSearchProfileChangeHelp`,
                  'Off: every chat searches the default search profile, and neither the user nor the model can pick another.'
                )}
              </span>
            </span>
          </div>
        </EditorSection>

        {advancedFields.length > 0 && (
          <EditorSection id="ifinder-advanced" title={t(`${K}.advancedSection`, 'Advanced')}>
            <button
              type="button"
              className="text-sm text-indigo-700 dark:text-indigo-300 hover:underline inline-flex items-center gap-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
              onClick={() => setShowAdvanced(open => !open)}
              aria-expanded={showAdvanced}
              aria-controls="ifinder-advanced-fields"
            >
              <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size="sm" />
              {t(`${K}.advancedToggle`, 'Request timeout, download directory and API paths')}
            </button>
            {showAdvanced && (
              <div id="ifinder-advanced-fields" className="space-y-3">
                {advancedFields.map(field => (
                  <ConfigFieldInput
                    key={field.key}
                    field={field}
                    value={values[field.key] ?? ''}
                    onChange={value => setValue(field.key, value)}
                    language={lang}
                    error={errors[field.key]}
                  />
                ))}
              </div>
            )}
          </EditorSection>
        )}

        <AccessSection editor={editor} idPrefix="ifinder" />
        <ActionsSection
          editor={editor}
          definition={definition}
          instance={instance}
          idPrefix="ifinder"
        />
      </form>

      <EditorFooter
        editor={editor}
        formId={FORM_ID}
        onTest={() => editor.runTest(valuesToSend())}
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'iFinder connection test')}
        testHelp={
          isExchangeMode
            ? t(
                `${K}.diagnostics.exchangeDescription`,
                'The test exchanges your own stored sign-in token at the OIDC provider and calls the endpoints the integration uses, with the values above (unsaved). It always runs as you: the exchange needs your sign-in.'
              )
            : t(
                `${K}.diagnostics.description`,
                'The test signs a JWT for your own admin account and calls the endpoints the integration uses, with the values above (unsaved).'
              )
        }
      />
    </div>
  );
}

export default IFinderEditor;
