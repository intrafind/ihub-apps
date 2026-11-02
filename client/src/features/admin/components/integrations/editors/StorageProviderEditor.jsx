// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import { CredentialRefSelect } from '../../OpenApiToolEditor';
import IntegrationConnectionsDialog from '../IntegrationConnectionsDialog';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../../formStyles';
import { buildApiUrl } from '../../../../../utils/runtimeBasePath';
import { fetchIntegrationConnections } from '../../../../../api/integrationsAdminApi';
import useInstallationEditor from './useInstallationEditor';
import {
  AccessSection,
  ActionsSection,
  CopyableValue,
  EditorFooter,
  EditorSection,
  FieldError,
  NameSection
} from './InstallationEditorParts';
import {
  initialStorageValues,
  storageEditorSpec,
  storageRedirectUri,
  storageValuesProblem,
  storageValuesToSave
} from './storageEditorModel';

const K = 'admin.integrations.editors.storage';

/** Where each provider's admin registers iHub's redirect URI. */
const REGISTER_HELP = {
  office365: [
    `${K}.register.office365`,
    'Azure portal → Microsoft Entra ID → App registrations → your app → Authentication → Platform "Web" → Redirect URIs.'
  ],
  googledrive: [
    `${K}.register.googledrive`,
    'Google Cloud console → APIs & Services → Credentials → your OAuth 2.0 client (Web application) → Authorized redirect URIs.'
  ],
  nextcloud: [
    `${K}.register.nextcloud`,
    'Nextcloud → Administration settings → Security → OAuth 2.0 clients → add a client with this redirect URI.'
  ]
};

/**
 * The default text of the OAuth section's help (`oauthSectionHelp.<type>`):
 * what the provider's OAuth app is.
 *
 * @param {string} type - Provider type (`office365`, `googledrive`, `nextcloud`)
 * @returns {string}
 */
function oauthSectionHelp(type) {
  if (type === 'office365') {
    return 'The Azure app registration users sign in with (Microsoft Graph, delegated permissions).';
  }
  if (type === 'googledrive') {
    return 'The OAuth 2.0 client (Web application) of your Google Cloud project, with the Drive API enabled.';
  }
  return 'The Nextcloud server and the OAuth 2.0 client registered in it.';
}

/**
 * A text input of the editor with its label, help and field error.
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} props.label
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.help]
 * @param {string} [props.error]
 * @param {boolean} [props.required]
 * @param {boolean} [props.mono]
 * @param {string} [props.placeholder]
 * @param {string} [props.type]
 */
function TextField({
  id,
  label,
  value,
  onChange,
  help,
  error,
  required = false,
  mono = false,
  placeholder,
  type = 'text'
}) {
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
        {required && <span className="text-red-600 dark:text-red-400 ml-0.5">*</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className={mono ? MONO_INPUT_CLASS : INPUT_CLASS}
        placeholder={placeholder}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy || undefined}
        aria-required={required || undefined}
      />
      {help && (
        <p id={`${id}-help`} className={HELP_CLASS}>
          {help}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * The users who connected their own account: how many, and the dialog to
 * see and disconnect them.
 *
 * @param {Object} props
 * @param {Object} props.instance - `id`, `label`, `enabled`
 * @param {string} props.idPrefix
 */
function ConnectionsSection({ instance, idPrefix }) {
  const { t } = useTranslation();
  const [count, setCount] = useState(null);
  const [open, setOpen] = useState(false);
  const instanceId = instance.id;

  useEffect(() => {
    let cancelled = false;
    fetchIntegrationConnections(instanceId)
      .then(list => {
        if (!cancelled) setCount(Array.isArray(list) ? list.length : 0);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, open]);

  return (
    <EditorSection
      id={`${idPrefix}-connections`}
      title={t(`${K}.connectionsSection`, 'Connection and users')}
      description={t(
        `${K}.connectionsSectionHelp`,
        'Every user connects their own account, under Settings → Integrations or from the file picker. Connections are stored per installation.'
      )}
    >
      <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
        <li>
          {instance.enabled === false
            ? t(`${K}.statusDisabled`, 'Disabled: users cannot connect or pick files from it.')
            : t(`${K}.statusEnabled`, 'Enabled: users whose groups grant it can connect.')}
        </li>
        {count !== null && (
          <li data-testid={`${idPrefix}-connection-count`}>
            {t(`${K}.connectedUsers`, '{{count}} user(s) connected', { count })}
          </li>
        )}
      </ul>
      <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => setOpen(true)}>
        <Icon name="users" size="sm" />
        {t('admin.integrationCatalog.connections.title', 'Connected users')}
      </button>
      {open && <IntegrationConnectionsDialog instance={instance} onClose={() => setOpen(false)} />}
    </EditorSection>
  );
}

/**
 * The dedicated editor of a storage provider installation — Microsoft Office
 * 365 (`com.intrafind/office365`), Google Drive (`com.intrafind/google-drive`)
 * or Nextcloud (`com.intrafind/nextcloud`) — restored from the provider
 * editor they had before they became installations (`CloudStorageConfig.jsx`
 * before commit e53c041), on the installation's values:
 *
 * - **Register iHub with the provider**: the redirect URI to register, with a
 *   Copy button — the configured one, or the one the server derives (origin,
 *   base path, `/api/integrations/<service>/<installation id>/callback`) — and
 *   where to register it; the optional override.
 * - **OAuth app**: tenant (Office 365) or server URL (Nextcloud), client id,
 *   client secret as a credential.
 * - **Sources** (Office 365, Google Drive) and, for Office 365, the advanced
 *   site and drive restrictions.
 * - **Connection and users**: enabled or not, how many users connected, the
 *   Connected users dialog.
 * - Name, who may use it, and Test / Cancel / Save.
 *
 * **Test connection** runs the connector's checks on the unsaved values
 * (`POST /api/admin/integrations/installed/:id/_test`): client and secret,
 * provider settings, redirect URI, the provider's authorization server, the
 * connected users.
 *
 * Registered in `editors/index.js` for the three definitions; the props are
 * the editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values`
 * @param {Object} props.definition - the definition detail (install fields)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function StorageProviderEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const spec = storageEditorSpec(instance.definition || definition?.id);
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const [values, setValues] = useState(() =>
    spec ? initialStorageValues(spec, instance.values) : {}
  );
  const [showAdvanced, setShowAdvanced] = useState(() =>
    Boolean(instance.values?.siteUrl || instance.values?.driveId)
  );
  if (!spec) return null;

  const errors = editor.fieldErrors;
  const p = spec.idPrefix;
  const formId = `${p}-editor-form`;
  const setValue = (key, value) => setValues(prev => ({ ...prev, [key]: value }));
  const redirect = storageRedirectUri(
    spec,
    instance.id,
    { origin: window.location.origin, apiUrl: buildApiUrl },
    values.redirectUri
  );
  const [registerKey, registerDefault] = REGISTER_HELP[spec.type];

  const submit = event => {
    event.preventDefault();
    const problem = storageValuesProblem(spec, instance.id, values);
    if (problem) {
      editor.reject(problem.key, t(problem.messageKey, problem.messageDefault, problem.params));
      return;
    }
    void editor.save(storageValuesToSave(spec, values));
  };

  const field = (key, label, options = {}) => (
    <TextField
      id={`${p}-${key}`}
      label={label}
      value={values[key]}
      onChange={value => setValue(key, value)}
      error={errors[key]}
      required={spec.required.includes(key)}
      {...options}
    />
  );

  return (
    <div className="space-y-5" data-testid={`${p}-editor`}>
      <form id={formId} onSubmit={submit} className="space-y-5" noValidate>
        <NameSection editor={editor} definition={definition} idPrefix={p} />

        <EditorSection
          id={`${p}-register`}
          title={t(`${K}.registerSection`, 'Register iHub with the provider')}
          description={t(
            `${K}.registerSectionHelp`,
            'The provider sends users back to this URL after they sign in. It contains the installation id "{{id}}", which never changes.',
            { id: instance.id }
          )}
        >
          <CopyableValue
            id={`${p}-redirect-to-register`}
            label={t(`${K}.redirectToRegister`, 'Redirect URI to register')}
            value={redirect.url}
            help={
              <>
                {t(registerKey, registerDefault)}{' '}
                {redirect.derived
                  ? t(
                      `${K}.redirectDerivedHelp`,
                      'Derived the way the server derives it from each request: this address, the base path and the callback path. Set the field below when the provider must see a different address (an unusual proxy setup).'
                    )
                  : t(
                      `${K}.redirectConfiguredHelp`,
                      'The configured redirect URI below is used for every sign-in.'
                    )}
              </>
            }
          />
          {field('redirectUri', t(`${K}.redirectUri`, 'Redirect URI (optional)'), {
            mono: true,
            type: 'url',
            placeholder: redirect.derived ? redirect.url : undefined,
            help: t(
              `${K}.redirectUriHelp`,
              'Leave empty to derive it from each request (recommended).'
            )
          })}
        </EditorSection>

        <EditorSection
          id={`${p}-oauth`}
          title={t(`${K}.oauthSection`, 'OAuth app')}
          description={t(`${K}.oauthSectionHelp.${spec.type}`, oauthSectionHelp(spec.type))}
        >
          {spec.type === 'nextcloud' &&
            field('serverUrl', t(`${K}.serverUrl`, 'Nextcloud server URL'), {
              mono: true,
              type: 'url',
              placeholder: 'https://nextcloud.example.com',
              help: t(
                `${K}.serverUrlHelp`,
                'The base URL of the instance (no trailing slash); the base for OAuth, OCS and WebDAV.'
              )
            })}
          {spec.type === 'office365' &&
            field('tenantId', t(`${K}.tenantId`, 'Directory (tenant) ID'), {
              mono: true,
              placeholder: '00000000-0000-0000-0000-000000000000',
              help: t(
                `${K}.tenantIdHelp`,
                'An identifier, not a secret: stored in the installation as plain text.'
              )
            })}
          {field('clientId', t(`${K}.clientId`, 'Client ID'), {
            mono: true,
            placeholder:
              spec.type === 'googledrive' ? '…apps.googleusercontent.com' : 'your-client-id'
          })}
          <div>
            <CredentialRefSelect
              id={`${p}-clientSecretRef`}
              value={values.clientSecretRef || ''}
              onChange={value => setValue('clientSecretRef', value)}
              types={['secret']}
              label={t(`${K}.clientSecret`, 'Client secret')}
              help={t(
                `${K}.clientSecretHelp`,
                'A credential of type secret holding the client secret (Admin → Integrations → Credentials).'
              )}
              required
            />
            <FieldError message={errors.clientSecretRef} />
          </div>
        </EditorSection>

        {spec.sources.length > 0 && (
          <EditorSection
            id={`${p}-sources`}
            title={t(`${K}.sourcesSection`, 'Sources users may browse')}
            description={
              spec.type === 'office365'
                ? t(
                    `${K}.sourcesSectionHelp.office365`,
                    'Sign-in asks only for the Microsoft Graph permissions the checked sources need; switch off what your tenant does not consent to.'
                  )
                : t(
                    `${K}.sourcesSectionHelp.googledrive`,
                    'The picker offers only the checked sources.'
                  )
            }
          >
            <fieldset className="space-y-2">
              <legend className="sr-only">
                {t(`${K}.sourcesSection`, 'Sources users may browse')}
              </legend>
              {spec.sources.map(source => (
                <label
                  key={source.key}
                  htmlFor={`${p}-${source.key}`}
                  className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
                >
                  <input
                    id={`${p}-${source.key}`}
                    type="checkbox"
                    className={`${CHECKBOX_CLASS} mt-0.5`}
                    checked={values[source.key] !== false}
                    onChange={e => setValue(source.key, e.target.checked)}
                  />
                  <span>
                    {t(source.labelKey, source.labelDefault)}
                    {source.helpKey && (
                      <span className={`${HELP_CLASS} block`}>
                        {t(source.helpKey, source.helpDefault)}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
            {spec.sources.every(source => values[source.key] === false) && (
              <output className={`${CALLOUT_CLASS.warning} block`}>
                {t(`${K}.noSource`, 'No source is checked: users can connect but browse nothing.')}
              </output>
            )}
            {spec.advanced.length > 0 && (
              <div>
                <button
                  type="button"
                  className="text-sm text-indigo-700 dark:text-indigo-300 hover:underline inline-flex items-center gap-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                  onClick={() => setShowAdvanced(on => !on)}
                  aria-expanded={showAdvanced}
                  aria-controls={`${p}-advanced-fields`}
                >
                  <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size="sm" />
                  {t('admin.integrationCatalog.wizard.advanced', 'Advanced settings')}
                </button>
                {showAdvanced && (
                  <div
                    id={`${p}-advanced-fields`}
                    className="mt-3 pl-3 border-l-2 border-gray-200 dark:border-gray-700 grid grid-cols-1 sm:grid-cols-2 gap-4"
                  >
                    {field('siteUrl', t(`${K}.siteUrl`, 'SharePoint site URL'), {
                      mono: true,
                      type: 'url',
                      placeholder: 'https://yourcompany.sharepoint.com/sites/team',
                      help: t(`${K}.siteUrlHelp`, 'Restrict access to one SharePoint site.')
                    })}
                    {field('driveId', t(`${K}.driveId`, 'Drive ID'), {
                      mono: true,
                      help: t(`${K}.driveIdHelp`, 'Restrict access to one drive.')
                    })}
                  </div>
                )}
              </div>
            )}
          </EditorSection>
        )}

        <ConnectionsSection instance={instance} idPrefix={p} />
        <AccessSection editor={editor} idPrefix={p} />
        <ActionsSection editor={editor} definition={definition} instance={instance} idPrefix={p} />
      </form>

      <EditorFooter
        editor={editor}
        formId={formId}
        onTest={() => editor.runTest(storageValuesToSave(spec, values))}
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'Storage provider test')}
        testHelp={t(
          `${K}.testHelp`,
          'Checks the values above (unsaved): client and secret, the provider settings, the redirect URI, whether the provider answers, and how many users are connected. Signing in needs a browser: connect under Settings → Integrations.'
        )}
      />
    </div>
  );
}

export default StorageProviderEditor;
