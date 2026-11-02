// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AdminFormErrorSummary from '../../AdminFormErrorSummary';
import { CALLOUT_CLASS, HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../../formStyles';
import { fetchPeopleDirectoryEditorContext } from '../../../../../api/integrationsAdminApi';
import useInstallationEditor from './useInstallationEditor';
import { ActionsSection, EditorFooter } from './InstallationEditorParts';
import SourceSection from './peopleDirectory/SourceSection';
import DirectoryAccessSection from './peopleDirectory/DirectoryAccessSection';
import NetworkSection from './peopleDirectory/NetworkSection';
import VisibilitySection from './peopleDirectory/VisibilitySection';
import ModelFacingSection from './peopleDirectory/ModelFacingSection';
import LimitsSection from './peopleDirectory/LimitsSection';
import MappingSection from './peopleDirectory/MappingSection';
import {
  DEFAULT_PERSON_FIELDS,
  directoryFormToValues,
  directoryValuesToForm,
  effectivePresetId,
  inputIdForField,
  transportOf,
  validateDirectoryForm
} from './peopleDirectoryEditorModel';

const K = 'admin.integrations.editors.peopleDirectory';
const FORM_ID = 'people-directory-editor-form';

/**
 * The dedicated editor of a **People directory (LDAP)** installation
 * (`com.intrafind/ldap-directory`, one installation per directory).
 *
 * Restored from the directory editor that existed before directories became
 * installations (`AdminPeopleDirectoryEditPage` and
 * `components/people-directories/*` before commit e53c041), adapted to the
 * installation values (see `peopleDirectoryEditorModel.js`) and to the
 * integration model:
 *
 * - **Kept:** Source (reuse a sign-in provider with overrides, or connect
 *   directly), Access (provider account, anonymous, service account with a
 *   credential), Network (transport, plain text, allowed hosts, trusted
 *   certificates; new: TLS versions and ciphers), Visibility (data flow),
 *   Model-facing name and description in English and German with the tool
 *   preview, Limits (with units), Search and mapping, the connection test
 *   with a sample search, client-side checks with an error summary.
 * - **Changed:** who may use the directory is no longer a list of groups on
 *   the directory: Visibility shows the groups that grant the installation
 *   (`permissions.integrations`) with a link to the group page. Enabling is
 *   the page header's Enable/Disable; the id is fixed.
 * - **Moved:** the LDAP browser is its own integration
 *   (`com.intrafind/ldap-browser`, `LdapBrowserEditor`).
 * - **New:** the actions the model may call.
 *
 * Registered in `editors/index.js`; the props are the editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values` and `liveActions`
 * @param {Object} props.definition - the definition detail (install fields, actions)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function PeopleDirectoryEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const [form, setForm] = useState(() =>
    directoryValuesToForm(instance.values || {}, {
      label: instance.labelLocalized,
      description: instance.description
    })
  );
  const [context, setContext] = useState(null);
  const [problems, setProblems] = useState([]);
  const [query, setQuery] = useState('');
  const problemsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetchPeopleDirectoryEditorContext()
      .then(result => {
        if (!cancelled) setContext(result);
      })
      .catch(() => {
        // Not fatal: the editor falls back to the built-in defaults and
        // lists no sign-in provider to pick.
        if (!cancelled) setContext({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Save is at the bottom of a long page: bring the list of problems into
  // view and move focus there, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (problems.length > 0) problemsRef.current?.focus();
  }, [problems]);

  const update = useCallback(patch => setForm(prev => ({ ...prev, ...patch })), []);

  const providers = useMemo(
    () => (Array.isArray(context?.ldapProviders) ? context.ldapProviders : []),
    [context]
  );
  const provider =
    form.sourceMode === 'provider' ? providers.find(p => p.name === form.authProvider) : undefined;
  const transport = transportOf(form, provider);
  const presets = Array.isArray(context?.presets) ? context.presets : [];
  const presetId = effectivePresetId(form, provider);
  const preset = presets.find(p => p.id === presetId);
  const presetLabel = t(`${K}.presets.${presetId}`, preset?.label || presetId);
  const fields = Array.isArray(context?.fields) ? context.fields : DEFAULT_PERSON_FIELDS;
  const baseDnHint = form.baseDn || provider?.userSearchBase || provider?.baseDn || '';

  /** Errors next to the fields: the editor's own checks, then the server's. */
  const fieldErrors = useMemo(() => {
    const out = { ...editor.fieldErrors };
    for (const entry of problems) if (entry.field) out[entry.field] = entry.message;
    return out;
  }, [editor.fieldErrors, problems]);

  const texts = () => ({ labelMap: form.name, descriptionMap: form.description });

  const submit = event => {
    event.preventDefault();
    const found = validateDirectoryForm(form, { limits: context?.limits });
    if (found.length > 0) {
      setProblems(
        found.map(entry => ({
          field: entry.field,
          fieldId: inputIdForField(entry.field),
          message: t(entry.message.key, entry.message.defaultValue, entry.message.values)
        }))
      );
      return;
    }
    setProblems([]);
    void editor.save(directoryFormToValues(form), texts());
  };

  const runTest = () => {
    const sample = query.trim();
    void editor.runTest(directoryFormToValues(form), {
      ...texts(),
      testInput: sample ? { query: sample } : undefined
    });
  };

  const status = instance.status;
  const statusIssues = [...(status?.problems || []), ...(status?.warnings || [])];

  return (
    <div className="space-y-5" data-testid="people-directory-editor">
      {statusIssues.length > 0 && (
        <div
          className={status?.problems?.length ? CALLOUT_CLASS.danger : CALLOUT_CLASS.warning}
          role="note"
        >
          <p className="font-medium">
            {t(`${K}.statusTitle`, 'As saved, this directory has issues:')}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {statusIssues.map(text => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      )}

      <form id={FORM_ID} onSubmit={submit} className="space-y-5" noValidate>
        <div ref={problemsRef} tabIndex={-1} className="focus:outline-hidden">
          <AdminFormErrorSummary
            errors={problems}
            title={t(`${K}.errorsTitle`, 'Please check these fields')}
          />
        </div>

        <ModelFacingSection instanceId={instance.id} form={form} update={update} />
        <SourceSection
          form={form}
          update={update}
          ldapProviders={providers}
          provider={provider}
          presets={presets}
          errors={fieldErrors}
        />
        <DirectoryAccessSection
          form={form}
          update={update}
          provider={provider}
          transport={transport}
          errors={fieldErrors}
        />
        <NetworkSection form={form} update={update} transport={transport} errors={fieldErrors} />
        <VisibilitySection form={form} update={update} grantedTo={editor.grantedTo} />
        <LimitsSection
          form={form}
          update={update}
          defaults={context?.defaults}
          limits={context?.limits}
          errors={fieldErrors}
        />
        <MappingSection
          form={form}
          update={update}
          preset={preset}
          presetLabel={presetLabel}
          fields={fields}
          baseDnHint={baseDnHint}
          errors={fieldErrors}
        />
        <ActionsSection
          editor={editor}
          definition={definition}
          instance={instance}
          idPrefix="people-directory"
        />
      </form>

      <EditorFooter
        editor={editor}
        formId={FORM_ID}
        onTest={runTest}
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'Directory connection test')}
        testHelp={t(
          `${K}.testHelp`,
          'Checks the configuration, the address, the connection, StartTLS and the bind with the values above (unsaved). With a name, it also runs a search and shows the mapped people next to the attributes they came from. Nothing is saved.'
        )}
        testInput={
          <>
            <label htmlFor="pd-test-query" className={LABEL_CLASS}>
              {t(`${K}.testQuery`, 'Sample search (a surname)')}
            </label>
            <input
              id="pd-test-query"
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Mustermann"
              aria-describedby="pd-test-query-help"
              className={INPUT_CLASS}
            />
            <p id="pd-test-query-help" className={HELP_CLASS}>
              {t(`${K}.testQueryHelp`, 'Optional: a name to search for, to check the mapping.')}
            </p>
          </>
        }
      />
    </div>
  );
}

export default PeopleDirectoryEditor;
