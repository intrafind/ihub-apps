// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CredentialRefSelect } from '../../OpenApiToolEditor';
import { CALLOUT_CLASS, HELP_CLASS, LABEL_CLASS, MONO_INPUT_CLASS } from '../../formStyles';
import { fetchPeopleDirectoryEditorContext } from '../../../../../api/integrationsAdminApi';
import useInstallationEditor from './useInstallationEditor';
import {
  AccessSection,
  ActionsSection,
  EditorFooter,
  EditorSection,
  FieldError,
  NameSection
} from './InstallationEditorParts';

const K = 'admin.integrations.editors.entra';
const FORM_ID = 'entra-directory-editor-form';

/** The environment variable each field falls back to when it is empty. */
export const ENTRA_ENVIRONMENT = Object.freeze({
  tenantId: 'AZURE_TENANT_ID',
  clientId: 'AZURE_CLIENT_ID',
  clientSecret: 'AZURE_CLIENT_SECRET'
});

/** A GUID as Entra ID shows tenant and application ids. */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The editor's values from the installation's (effective) values.
 * @param {Object} values
 * @returns {{ tenantId: string, clientId: string, clientSecretRef: string }}
 */
export function entraValuesToForm(values = {}) {
  return {
    tenantId: values.tenantId ?? '',
    clientId: values.clientId ?? '',
    clientSecretRef: values.clientSecretRef ?? ''
  };
}

/**
 * What the fallback of one field says: the value is set, or the variable is
 * used (and whether the server has it), or nothing is there at all.
 *
 * @param {string} value - the field's value
 * @param {{ variable: string, set: boolean }|undefined} environment - from the editor context
 * @returns {'value'|'env'|'missing'|'unknown'}
 */
export function fallbackState(value, environment) {
  if (typeof value === 'string' && value.trim()) return 'value';
  if (!environment) return 'unknown';
  return environment.set ? 'env' : 'missing';
}

/**
 * The dedicated editor of the **Microsoft Entra ID directory** installation
 * (`com.intrafind/entra-directory`, installation `entra`): the app
 * registration it runs with — tenant id, application (client) id and the
 * client secret as a credential — each falling back to its `AZURE_*`
 * environment variable when empty, which the editor says per field (whether
 * the server has the variable, never its value). **Test connection** fetches
 * a client-credentials token with the unsaved values and makes one Graph
 * call that needs `User.Read.All`.
 *
 * Presented in the People directories group (type `people-directory`), next
 * to the People directory (LDAP) installations.
 *
 * Registered in `editors/index.js`; the props are the editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values` and `liveActions`
 * @param {Object} props.definition - the definition detail (install fields, actions)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function EntraDirectoryEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const [values, setValues] = useState(() => entraValuesToForm(instance.values || {}));
  const [environment, setEnvironment] = useState(null);
  const errors = editor.fieldErrors;

  useEffect(() => {
    let cancelled = false;
    fetchPeopleDirectoryEditorContext()
      .then(result => {
        if (!cancelled) setEnvironment(result?.entraEnvironment || {});
      })
      .catch(() => {
        if (!cancelled) setEnvironment({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setValue = (key, value) => setValues(prev => ({ ...prev, [key]: value }));

  const fallbackNote = (field, value) => {
    const variable = ENTRA_ENVIRONMENT[field];
    const state = fallbackState(value, environment?.[field]);
    if (state === 'env') {
      return (
        <p className="mt-1 text-xs text-green-800 dark:text-green-300" data-testid={`env-${field}`}>
          {t(`${K}.envUsed`, 'Empty: {{variable}} is used (set on the server).', { variable })}
        </p>
      );
    }
    if (state === 'missing') {
      return (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300" data-testid={`env-${field}`}>
          {t(`${K}.envMissing`, 'Empty, and {{variable}} is not set on the server.', {
            variable
          })}
        </p>
      );
    }
    if (state === 'unknown') {
      return (
        <p className={HELP_CLASS}>
          {t(`${K}.envFallback`, 'Empty: the environment variable {{variable}} is used.', {
            variable
          })}
        </p>
      );
    }
    return null;
  };

  const idField = (key, inputId, label, help, placeholder) => {
    const value = values[key];
    const malformed = value.trim() && !GUID_PATTERN.test(value.trim());
    return (
      <div>
        <label htmlFor={inputId} className={LABEL_CLASS}>
          {label}
        </label>
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={e => setValue(key, e.target.value)}
          placeholder={placeholder}
          aria-describedby={`${inputId}-help`}
          aria-invalid={errors[key] ? 'true' : undefined}
          className={MONO_INPUT_CLASS}
        />
        <p id={`${inputId}-help`} className={HELP_CLASS}>
          {help}
        </p>
        {fallbackNote(key, value)}
        {malformed && (
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            {t(`${K}.notGuid`, 'This does not look like an id from Entra ID (a GUID).')}
          </p>
        )}
        <FieldError message={errors[key]} />
      </div>
    );
  };

  const submit = event => {
    event.preventDefault();
    void editor.save({
      tenantId: values.tenantId.trim(),
      clientId: values.clientId.trim(),
      clientSecretRef: values.clientSecretRef
    });
  };

  const missing = ['tenantId', 'clientId'].filter(
    key => fallbackState(values[key], environment?.[key]) === 'missing'
  );
  if (fallbackState(values.clientSecretRef, environment?.clientSecret) === 'missing') {
    missing.push('clientSecret');
  }

  return (
    <div className="space-y-5" data-testid="entra-directory-editor">
      <form id={FORM_ID} onSubmit={submit} className="space-y-5" noValidate>
        <NameSection editor={editor} definition={definition} idPrefix="entra" />

        <EditorSection
          id="entra-registration"
          title={t(`${K}.registrationSection`, 'App registration')}
          description={t(
            `${K}.registrationSectionHelp`,
            'iHub looks people up through Microsoft Graph with the client credentials of an app registration, not as the signed-in user. Grant the registration the application permissions User.Read.All and GroupMember.Read.All, with admin consent.'
          )}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {idField(
              'tenantId',
              'entra-tenant-id',
              t(`${K}.tenantId`, 'Tenant ID'),
              t(`${K}.tenantIdHelp`, 'The directory (tenant) id of your Entra ID tenant.'),
              '00000000-0000-0000-0000-000000000000'
            )}
            {idField(
              'clientId',
              'entra-client-id',
              t(`${K}.clientId`, 'Application (client) ID'),
              t(
                `${K}.clientIdHelp`,
                'The app registration that holds the Graph application permissions.'
              ),
              '00000000-0000-0000-0000-000000000000'
            )}
          </div>
          <div>
            <CredentialRefSelect
              id="entra-client-secret-ref"
              value={values.clientSecretRef}
              onChange={id => setValue('clientSecretRef', id)}
              types={['secret']}
              label={t(`${K}.clientSecret`, 'Client secret')}
              help={t(
                `${K}.clientSecretHelp`,
                "A credential of type secret holding the app registration's client secret (Admin → Credentials). The secret is never stored in the installation."
              )}
            />
            {fallbackNote('clientSecret', values.clientSecretRef)}
            <FieldError message={errors.clientSecretRef} />
          </div>
          {missing.length > 0 && (
            <div className={CALLOUT_CLASS.warning} role="note" data-testid="entra-missing">
              {t(
                `${K}.incomplete`,
                'Without {{fields}} the directory cannot sign in: fill the fields, or set the environment variables on the server.',
                { fields: missing.map(field => ENTRA_ENVIRONMENT[field]).join(', ') }
              )}
            </div>
          )}
        </EditorSection>

        <AccessSection editor={editor} idPrefix="entra" />
        <ActionsSection
          editor={editor}
          definition={definition}
          instance={instance}
          idPrefix="entra"
        />
      </form>

      <EditorFooter
        editor={editor}
        formId={FORM_ID}
        onTest={() =>
          editor.runTest({
            tenantId: values.tenantId.trim(),
            clientId: values.clientId.trim(),
            clientSecretRef: values.clientSecretRef
          })
        }
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'Entra ID connection test')}
        testHelp={t(
          `${K}.testHelp`,
          'Fetches a token with the values above (unsaved), falling back to the AZURE_* variables, and reads one user through Microsoft Graph.'
        )}
      />
    </div>
  );
}

export default EntraDirectoryEditor;
