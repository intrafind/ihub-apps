// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../../../shared/components/DynamicLanguageEditor';
import { ApprovalModeSelect, ToolEffectSelect } from '../../ToolApprovalFields';
import KeyValueRowsEditor from './KeyValueRowsEditor';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../../formStyles';
import {
  HTTP_BODY_TYPES,
  HTTP_METHODS,
  parametersFromPlaceholders,
  parseJsonObject,
  sideEffectOfMethod,
  undeclaredPlaceholders
} from './builderModel';

/**
 * One action of the integration builder: what the model calls it and reads
 * about it, its parameters, side effect, data flow and approval (#2945), and
 * for an HTTP request action the request template and the response mapping.
 *
 * What the source decides is shown read-only: an OpenAPI operation's
 * parameters, an MCP tool's or A2A skill's name and schema.
 *
 * @param {Object} props
 * @param {Object} props.action
 * @param {number} props.index
 * @param {string} props.source - the draft's source
 * @param {(action: Object) => void} props.onChange
 * @param {() => void} [props.onRemove] - when the action can be removed
 * @param {Object<string, {key: string, defaultValue: string}>} props.errors - the draft's action errors
 * @returns {JSX.Element}
 */
function BuilderActionCard({ action, index, source, onChange, onRemove, errors }) {
  const { t } = useTranslation();
  const id = useId();
  const editableName = source === 'http' || source === 'script';
  const editableSchema = source === 'http' || source === 'script';
  const [schemaText, setSchemaText] = useState(() =>
    JSON.stringify(action.parameters || { type: 'object', properties: {} }, null, 2)
  );
  const [schemaError, setSchemaError] = useState(null);

  // Keep the text in step with a schema changed elsewhere (placeholders added).
  useEffect(() => {
    setSchemaText(current => {
      const parsed = parseJsonObject(current).value;
      return JSON.stringify(parsed) === JSON.stringify(action.parameters)
        ? current
        : JSON.stringify(action.parameters || { type: 'object', properties: {} }, null, 2);
    });
  }, [action.parameters]);

  const update = patch => onChange({ ...action, ...patch });
  const request = action.request || {};
  const setRequest = patch => {
    const next = { ...request, ...patch };
    const result = { request: next };
    // A new method suggests its side effect while the admin kept the previous suggestion.
    if (patch.method && action.sideEffect === sideEffectOfMethod(request.method)) {
      result.sideEffect = sideEffectOfMethod(patch.method);
    }
    update(result);
  };
  const missing = source === 'http' ? undeclaredPlaceholders(request, action.parameters) : [];
  const err = key => errors[`actions.${index}.${key}`];
  const title = action.title && typeof action.title === 'string' ? action.title : action.name;

  return (
    <li className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <input
            id={`${id}-enabled`}
            type="checkbox"
            className={CHECKBOX_CLASS}
            checked={action.enabled !== false}
            onChange={e => update({ enabled: e.target.checked })}
          />
          <label
            htmlFor={`${id}-enabled`}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate"
          >
            {t('admin.integrationBuilder.action.enabled', 'Offer "{{name}}" to the model', {
              name: title
            })}
          </label>
        </div>
        {onRemove && (
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={onRemove}
            aria-label={t('admin.integrationBuilder.action.remove', 'Remove action {{name}}', {
              name: action.name
            })}
          >
            <Icon name="trash" size="sm" />
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${id}-name`} className={LABEL_CLASS}>
            {t('admin.integrationBuilder.action.name', 'Action name')}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            value={action.name}
            readOnly={!editableName}
            onChange={e => update({ name: e.target.value })}
            className={MONO_INPUT_CLASS}
            aria-invalid={Boolean(err('name'))}
            aria-describedby={`${id}-name-help`}
          />
          <p id={`${id}-name-help`} className={HELP_CLASS}>
            {err('name')
              ? t(err('name').key, err('name').defaultValue)
              : action.toolId
                ? t(
                    'admin.integrationBuilder.action.toolId',
                    'Tool id {{toolId}} (kept from the tool this integration was migrated from).',
                    { toolId: action.toolId }
                  )
                : action.operationId
                  ? t('admin.integrationBuilder.action.operation', 'Operation {{operationId}}', {
                      operationId: action.operationId
                    })
                  : t(
                      'admin.integrationBuilder.action.nameHelp',
                      'The model calls the action by this name.'
                    )}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ToolEffectSelect
            kind="sideEffect"
            label={t('admin.toolApproval.sideEffect', 'Side effect')}
            value={action.sideEffect === 'unknown' ? undefined : action.sideEffect}
            onChange={value => update({ sideEffect: value || 'unknown' })}
          />
          <ToolEffectSelect
            kind="dataFlow"
            label={t('admin.toolApproval.dataFlowLabel', 'Data flow')}
            value={action.dataFlow}
            onChange={value => update({ dataFlow: value || 'external' })}
          />
          <ApprovalModeSelect
            label={t('admin.integrationBuilder.action.approval', 'Approval')}
            value={action.approval}
            onChange={approval => update({ approval })}
            inheritLabel={t(
              'admin.integrationBuilder.action.approvalInherit',
              'As the integration'
            )}
          />
        </div>
      </div>

      <div className="mt-4">
        <DynamicLanguageEditor
          label={t('admin.integrationBuilder.action.description', 'Description for the model')}
          value={
            typeof action.description === 'string'
              ? { en: action.description }
              : action.description || {}
          }
          onChange={description => update({ description })}
          type="textarea"
          rows={2}
        />
        {action.remoteDescription && (
          <p className={HELP_CLASS}>
            {t(
              'admin.integrationBuilder.action.remoteDescription',
              'The server describes it as: {{text}} — a description here replaces that.',
              { text: action.remoteDescription }
            )}
          </p>
        )}
      </div>

      {source === 'http' && (
        <fieldset className="mt-4 rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-4">
          <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.integrationBuilder.http.request', 'Request')}
          </legend>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label htmlFor={`${id}-method`} className={LABEL_CLASS}>
                {t('admin.integrationBuilder.http.method', 'Method')}
              </label>
              <select
                id={`${id}-method`}
                value={request.method || 'GET'}
                onChange={e => setRequest({ method: e.target.value })}
                className={INPUT_CLASS}
              >
                {HTTP_METHODS.map(method => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-3">
              <label htmlFor={`${id}-url`} className={LABEL_CLASS}>
                {t('admin.integrationBuilder.http.url', 'URL template')}
              </label>
              <input
                id={`${id}-url`}
                type="text"
                value={request.url || ''}
                onChange={e => setRequest({ url: e.target.value })}
                className={MONO_INPUT_CLASS}
                placeholder="/orders/{orderId}"
                aria-invalid={Boolean(err('url'))}
                aria-describedby={`${id}-url-help`}
              />
              <p id={`${id}-url-help`} className={HELP_CLASS}>
                {err('url')
                  ? t(err('url').key, err('url').defaultValue)
                  : t(
                      'admin.integrationBuilder.http.urlHelp',
                      '{name} is replaced by the argument of that name (URL-encoded), else by the install value.'
                    )}
              </p>
            </div>
          </div>
          <KeyValueRowsEditor
            legend={t('admin.integrationBuilder.http.query', 'Query parameters')}
            help={t(
              'admin.integrationBuilder.http.queryHelp',
              'A parameter whose placeholders have no value is left out.'
            )}
            value={request.query || {}}
            onChange={query => setRequest({ query })}
          />
          <KeyValueRowsEditor
            legend={t('admin.integrationBuilder.http.requestHeaders', 'Headers')}
            value={request.headers || {}}
            onChange={headers => setRequest({ headers })}
          />
          {!['GET', 'HEAD'].includes(request.method || 'GET') && (
            <div className="space-y-2">
              <div>
                <label htmlFor={`${id}-ctype`} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.http.contentType', 'Body format')}
                </label>
                <select
                  id={`${id}-ctype`}
                  value={request.contentType || 'application/json'}
                  onChange={e => setRequest({ contentType: e.target.value })}
                  className={INPUT_CLASS}
                >
                  {HTTP_BODY_TYPES.map(type => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-body`} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.http.body', 'Body template')}
                </label>
                <textarea
                  id={`${id}-body`}
                  rows={5}
                  spellCheck={false}
                  value={request.body || ''}
                  onChange={e => setRequest({ body: e.target.value })}
                  className={MONO_INPUT_CLASS}
                  placeholder={'{"note": {note}, "priority": {priority}}'}
                  aria-describedby={`${id}-body-help`}
                />
                <p id={`${id}-body-help`} className={HELP_CLASS}>
                  {err('body')
                    ? t(err('body').key, err('body').defaultValue)
                    : t(
                        'admin.integrationBuilder.http.bodyHelp',
                        'In a JSON body a placeholder becomes the JSON of the value: write {note}, not "{note}".'
                      )}
                </p>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-result`} className={LABEL_CLASS}>
                {t('admin.integrationBuilder.http.result', 'Response: path to the result')}
              </label>
              <input
                id={`${id}-result`}
                type="text"
                value={action.response?.result || ''}
                onChange={e =>
                  update({ response: { ...(action.response || {}), result: e.target.value } })
                }
                className={MONO_INPUT_CLASS}
                placeholder="$.data.items"
              />
              <p className={HELP_CLASS}>
                {t(
                  'admin.integrationBuilder.http.resultHelp',
                  'Dotted keys, [] for every element of a list. Empty: the whole response.'
                )}
              </p>
            </div>
            <KeyValueRowsEditor
              legend={t('admin.integrationBuilder.http.fields', 'Response fields (optional)')}
              keyLabel={t('admin.integrationBuilder.http.fieldName', 'Field')}
              valueLabel={t('admin.integrationBuilder.http.fieldPath', 'Path')}
              value={action.response?.fields || {}}
              onChange={fields => update({ response: { ...(action.response || {}), fields } })}
            />
          </div>
        </fieldset>
      )}

      <div className="mt-4">
        <label htmlFor={`${id}-schema`} className={LABEL_CLASS}>
          {t('admin.integrationBuilder.action.parameters', 'Parameters (JSON schema)')}
        </label>
        {editableSchema ? (
          <>
            <textarea
              id={`${id}-schema`}
              rows={6}
              spellCheck={false}
              value={schemaText}
              onChange={e => {
                setSchemaText(e.target.value);
                const { value, error } = parseJsonObject(e.target.value);
                setSchemaError(error);
                if (value) update({ parameters: { ...value, type: 'object' } });
              }}
              className={MONO_INPUT_CLASS}
              aria-invalid={Boolean(schemaError)}
            />
            {schemaError && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                {t('admin.integrationBuilder.action.schemaError', 'Not a JSON object: {{error}}', {
                  error: schemaError
                })}
              </p>
            )}
          </>
        ) : (
          <pre
            id={`${id}-schema`}
            className="max-h-48 overflow-auto rounded-md bg-gray-50 dark:bg-gray-900 p-3 text-xs text-gray-800 dark:text-gray-200"
          >
            {action.parameters
              ? JSON.stringify(action.parameters, null, 2)
              : t(
                  'admin.integrationBuilder.action.parametersFromSource',
                  'Taken from the source when the action is called.'
                )}
          </pre>
        )}
        {missing.length > 0 && (
          <div className={`mt-2 ${CALLOUT_CLASS.warning}`}>
            <p>
              {t(
                'admin.integrationBuilder.http.undeclared',
                'The request uses placeholders no parameter declares: {{names}}. Install values of that name fill them; otherwise they stay empty.',
                { names: missing.join(', ') }
              )}
            </p>
            <button
              type="button"
              className={`${SECONDARY_BUTTON_CLASS} mt-2`}
              onClick={() =>
                update({ parameters: parametersFromPlaceholders(request, action.parameters) })
              }
            >
              <Icon name="plus" size="sm" />
              {t('admin.integrationBuilder.http.addParameters', 'Add them as parameters')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export default BuilderActionCard;
