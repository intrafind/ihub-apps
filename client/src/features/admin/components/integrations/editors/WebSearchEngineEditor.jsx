// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CredentialRefSelect } from '../../OpenApiToolEditor';
import ConfigFieldInput, { pickText } from '../ConfigFieldInput';
import { CALLOUT_CLASS } from '../../formStyles';
import useInstallationEditor from './useInstallationEditor';
import {
  AccessSection,
  ActionsSection,
  EditorFooter,
  EditorSection,
  FieldError,
  NameSection
} from './InstallationEditorParts';

const K = 'admin.integrations.editors.webSearch';
const FORM_ID = 'web-search-engine-editor-form';

/** The install field of a keyed engine that references its API key credential. */
export const API_KEY_FIELD = 'apiKeyRef';

/**
 * The environment variable a shipped engine falls back to when no credential
 * is picked (mirrors `server/services/search/webSearchEngines.js`).
 */
export const ENGINE_KEY_ENV = Object.freeze({
  'com.intrafind/brave-search': 'BRAVE_SEARCH_API_KEY',
  'com.intrafind/staan-search': 'STAAN_API_KEY'
});

/** Shipped engines whose search is known to be blocked from many data-centre IP addresses. */
const EGRESS_SENSITIVE = new Set(['com.intrafind/qwant-search']);

/**
 * The dedicated editor of a web search engine (`type: "web-search"`): Brave
 * Search, Staan and Qwant, and any engine definition registered for it.
 *
 * - **API key** (engines with an `apiKeyRef` field): a credential of the
 *   credential store, with the environment variable the server falls back to
 *   when none is picked (`BRAVE_SEARCH_API_KEY`, `STAAN_API_KEY`).
 * - An engine without a key (Qwant) says so, with the hint that its egress IP
 *   decides whether it answers.
 * - Every other install field of the definition is rendered by the generic
 *   field input, so a third-party engine registered here keeps its settings.
 *
 * **Test connection** checks the key of the unsaved values and runs one live
 * search from this server (`POST /api/admin/integrations/installed/:id/_test`).
 *
 * Registered in `editors/index.js` per engine definition; the props are the
 * editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values` and `liveActions`
 * @param {Object} props.definition - the definition detail (install fields, actions, `name`)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function WebSearchEngineEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const lang = editor.lang;
  const [values, setValues] = useState(() =>
    Object.fromEntries(Object.entries(instance.values || {}).filter(([, value]) => value !== null))
  );
  const errors = editor.fieldErrors;
  const setValue = (key, value) => setValues(prev => ({ ...prev, [key]: value }));

  const fields = Array.isArray(definition?.install) ? definition.install : [];
  const keyField = fields.find(field => field.key === API_KEY_FIELD && field.type === 'credential');
  const otherFields = fields.filter(field => field !== keyField);
  const keyEnv = ENGINE_KEY_ENV[instance.definition] || null;
  const engineName = pickText(definition?.name, lang) || instance.id;

  const submit = event => {
    event.preventDefault();
    void editor.save(values);
  };

  return (
    <div className="space-y-5" data-testid="web-search-engine-editor">
      <form id={FORM_ID} onSubmit={submit} className="space-y-5" noValidate>
        <NameSection editor={editor} definition={definition} idPrefix="web-search-engine" />

        <EditorSection
          id="web-search-engine-settings"
          title={t(`${K}.engineSection`, 'Search engine')}
          description={t(
            `${K}.engineSectionHelp`,
            'Apps with web search on use this engine when they name it, or on Auto when it is the first engine a user may use (Brave, Staan, Qwant, then any other engine). Models with native search do not need an engine.'
          )}
        >
          {keyField ? (
            <div>
              <CredentialRefSelect
                id="web-search-engine-api-key"
                value={values[API_KEY_FIELD] || ''}
                onChange={id => setValue(API_KEY_FIELD, id)}
                types={keyField.credentialTypes || ['secret']}
                label={t(`${K}.apiKey`, 'API key')}
                help={t(
                  `${K}.apiKeyHelp`,
                  'A credential of type secret holding the {{engine}} API key. Add one under Admin → Integrations → Credentials.',
                  { engine: engineName }
                )}
              />
              <FieldError message={errors[API_KEY_FIELD]} />
              {keyEnv && (
                <p
                  className={`mt-2 ${CALLOUT_CLASS.info}`}
                  data-testid="web-search-engine-env-hint"
                >
                  {t(
                    `${K}.envFallback`,
                    'Without a credential, the server uses the environment variable {{env}} when it is set. A picked credential always wins.',
                    { env: keyEnv }
                  )}
                </p>
              )}
            </div>
          ) : (
            <p
              className="text-sm text-gray-700 dark:text-gray-300"
              data-testid="web-search-engine-no-key"
            >
              {t(`${K}.noKeyNeeded`, '{{engine}} needs no API key.', { engine: engineName })}
            </p>
          )}
          {EGRESS_SENSITIVE.has(instance.definition) && (
            <p className={CALLOUT_CLASS.warning}>
              {t(
                `${K}.egressHint`,
                'Qwant blocks many data-centre IP addresses. Run Test connection to see whether it answers this server.'
              )}
            </p>
          )}
          {otherFields.map(field => (
            <ConfigFieldInput
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={value => setValue(field.key, value)}
              language={lang}
              error={errors[field.key]}
            />
          ))}
        </EditorSection>

        <AccessSection editor={editor} idPrefix="web-search-engine" />
        <ActionsSection
          editor={editor}
          definition={definition}
          instance={instance}
          idPrefix="web-search-engine"
        />
      </form>

      <EditorFooter
        editor={editor}
        formId={FORM_ID}
        onTest={() => editor.runTest(values)}
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'Search engine test')}
        testHelp={t(
          `${K}.testHelp`,
          'The test checks the API key of the values above (unsaved) and runs one live search from this server.'
        )}
      />
    </div>
  );
}

export default WebSearchEngineEditor;
