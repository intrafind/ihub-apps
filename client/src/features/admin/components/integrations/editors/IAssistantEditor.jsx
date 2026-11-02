// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import ConfigFieldInput from '../ConfigFieldInput';
import { HELP_CLASS, LABEL_CLASS, MONO_INPUT_CLASS } from '../../formStyles';
import useInstallationEditor from './useInstallationEditor';
import {
  AccessSection,
  ActionsSection,
  EditorFooter,
  EditorSection,
  FieldError,
  NameSection
} from './InstallationEditorParts';

const K = 'admin.integrations.editors.iassistant';
const FORM_ID = 'iassistant-editor-form';

/** The values the editor shows when the installation has none (the definition's defaults). */
export const IASSISTANT_DEFAULTS = Object.freeze({
  connection: 'ifinder',
  defaultProfileId: '',
  defaultSearchProfile: 'searchprofile-standard',
  verifySearchProfileAccess: true,
  groundedOnly: false,
  searchProfileCacheTtlMs: 300000
});

/** Fields rendered from the definition (the instance picker, the switches, the cache). */
const DEFINITION_FIELDS = Object.freeze(['verifySearchProfileAccess', 'groundedOnly']);

/**
 * The dedicated editor of the iAssistant installation
 * (`com.intrafind/iassistant`, installation `iassistant`): the iAssistant
 * section of the former iFinder editor — the default conversation profile and
 * search profile with their help texts — plus the settings the installation
 * added: the iFinder installation it runs on, the access check of the search
 * profile, "answer only from documents" and the profile cache.
 *
 * **Test connection** runs the connector's diagnostics against the unsaved
 * values (`POST /api/admin/integrations/installed/iassistant/_test`).
 *
 * Registered in `editors/index.js`; the props are the editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values` and `liveActions`
 * @param {Object} props.definition - the definition detail (install fields)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function IAssistantEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const lang = editor.lang;
  const [values, setValues] = useState(() => ({
    ...IASSISTANT_DEFAULTS,
    ...Object.fromEntries(
      Object.entries(instance.values || {}).filter(([, value]) => value !== null)
    )
  }));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const errors = editor.fieldErrors;

  const fieldByKey = useMemo(
    () => Object.fromEntries((definition?.install || []).map(field => [field.key, field])),
    [definition]
  );
  const setValue = (key, value) => setValues(prev => ({ ...prev, [key]: value }));

  const submit = event => {
    event.preventDefault();
    if (!String(values.connection || '').trim()) {
      editor.reject(
        'connection',
        t(`${K}.connectionRequired`, 'Pick the iFinder installation iAssistant runs on.')
      );
      return;
    }
    void editor.save(values);
  };

  const definitionField = key =>
    fieldByKey[key] ? (
      <ConfigFieldInput
        key={key}
        field={fieldByKey[key]}
        value={values[key]}
        onChange={value => setValue(key, value)}
        language={lang}
        error={errors[key]}
      />
    ) : null;

  return (
    <div className="space-y-5" data-testid="iassistant-editor">
      <form id={FORM_ID} onSubmit={submit} className="space-y-5" noValidate>
        <NameSection editor={editor} definition={definition} idPrefix="iassistant" />

        <EditorSection
          id="iassistant-connection"
          title={t(`${K}.connectionSection`, 'Connection')}
          description={t(
            `${K}.connectionSectionHelp`,
            'iAssistant uses the base URL and the sign-in of an iFinder installation; configure those there.'
          )}
        >
          {definitionField('connection')}
        </EditorSection>

        <EditorSection
          id="iassistant-settings"
          title={t(`${K}.settingsSection`, 'iAssistant settings')}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="iassistant-default-profile" className={LABEL_CLASS}>
                {t(`${K}.defaultProfileId`, 'Default profile ID')}
              </label>
              <input
                id="iassistant-default-profile"
                type="text"
                value={values.defaultProfileId || ''}
                onChange={e => setValue('defaultProfileId', e.target.value)}
                className={MONO_INPUT_CLASS}
                placeholder="c2VhcmNocHJvZmlsZS1zdGFuZGFyZA=="
                aria-describedby="iassistant-default-profile-help"
              />
              <p id="iassistant-default-profile-help" className={HELP_CLASS}>
                {t(
                  `${K}.defaultProfileIdHelp`,
                  'The iAssistant profile used when an app names none (plain text or base64 encoded).'
                )}
              </p>
              <FieldError message={errors.defaultProfileId} />
            </div>
            <div>
              <label htmlFor="iassistant-default-search-profile" className={LABEL_CLASS}>
                {t(`${K}.defaultSearchProfile`, 'Default search profile')}
              </label>
              <input
                id="iassistant-default-search-profile"
                type="text"
                value={values.defaultSearchProfile || ''}
                onChange={e => setValue('defaultSearchProfile', e.target.value)}
                className={MONO_INPUT_CLASS}
                placeholder="searchprofile-standard"
                aria-describedby="iassistant-default-search-profile-help"
              />
              <p id="iassistant-default-search-profile-help" className={HELP_CLASS}>
                {t(
                  `${K}.defaultSearchProfileHelp`,
                  'The search profile iAssistant conversations search when neither the app nor the model names one.'
                )}
              </p>
              <FieldError message={errors.defaultSearchProfile} />
            </div>
          </div>
          {DEFINITION_FIELDS.map(definitionField)}
          {fieldByKey.searchProfileCacheTtlMs && (
            <div>
              <button
                type="button"
                className="text-sm text-indigo-700 dark:text-indigo-300 hover:underline inline-flex items-center gap-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                onClick={() => setShowAdvanced(open => !open)}
                aria-expanded={showAdvanced}
                aria-controls="iassistant-advanced-fields"
              >
                <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size="sm" />
                {t('admin.integrationCatalog.wizard.advanced', 'Advanced settings')}
              </button>
              {showAdvanced && (
                <div
                  id="iassistant-advanced-fields"
                  className="mt-3 pl-3 border-l-2 border-gray-200 dark:border-gray-700"
                >
                  {definitionField('searchProfileCacheTtlMs')}
                </div>
              )}
            </div>
          )}
        </EditorSection>

        <AccessSection editor={editor} idPrefix="iassistant" />
        <ActionsSection
          editor={editor}
          definition={definition}
          instance={instance}
          idPrefix="iassistant"
        />
      </form>

      <EditorFooter
        editor={editor}
        formId={FORM_ID}
        onTest={() => editor.runTest(values)}
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'iAssistant connection test')}
        testHelp={t(
          `${K}.testHelp`,
          'The test reaches iAssistant through the selected iFinder installation as your own admin account, with the values above (unsaved).'
        )}
      />
    </div>
  );
}

export default IAssistantEditor;
