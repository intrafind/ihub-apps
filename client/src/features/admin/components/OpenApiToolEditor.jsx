// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { getAdminApiErrorMessage, listCredentials } from '../../../api/adminApi';
import { importBuilderActions } from '../../../api/integrationsAdminApi';
import {
  actionsFromOperations,
  openApiSourceOf,
  resolveServerUrl
} from './integrations/builder/builderModel';
import KeyValueRowsEditor from './integrations/builder/KeyValueRowsEditor';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';

/*
 * This file holds the credential picker every integration editor uses and the
 * OpenAPI source of the integration builder (the default export). It keeps
 * its name from the OpenAPI tool editor of the removed Tools page, which the
 * builder's OpenAPI source replaced.
 */

/**
 * Shared input styling. The project does not use @tailwindcss/forms, so a bare
 * border class would render no border width. These classes set an explicit
 * border, padding, colour, and focus ring for legibility in light/dark mode.
 */
const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-xs px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500';
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;

/**
 * Reusable credential-reference selector.
 *
 * Replaces raw secret <input> fields across the integration UIs. Fetches the
 * credential profiles from the central store and renders a dropdown of profile
 * ids, plus a link to create a new credential. The selected id is bound to a
 * `*Ref` field on the parent config (e.g. `clientSecretRef`).
 *
 * @param {object} props
 * @param {string} props.value - Currently selected credential id (or '')
 * @param {(id: string) => void} props.onChange - Called with the selected id
 * @param {string[]} [props.types] - Restrict the dropdown to these credential
 *   types. Omit to allow all types.
 * @param {string} [props.label] - Field label
 * @param {string} [props.help] - Help text shown beneath the select
 * @param {boolean} [props.required] - Mark the field as required
 * @returns {JSX.Element}
 */
export function CredentialRefSelect({ id, value, onChange, types, label, help, required }) {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listCredentials();
      setCredentials(list);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered =
    Array.isArray(types) && types.length > 0
      ? credentials.filter(c => types.includes(c.type))
      : credentials;

  const profileLabel = profile => {
    const name = typeof profile.name === 'string' ? profile.name : profile.name?.en;
    return name ? `${profile.id} — ${name} (${profile.type})` : `${profile.id} (${profile.type})`;
  };

  return (
    <div>
      {label && (
        <label
          htmlFor={id}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="flex items-center gap-2">
        <select
          id={id}
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          disabled={loading}
          className={INPUT_CLASS}
          required={required}
        >
          <option value="">
            {loading
              ? t('admin.credentials.select.loading', 'Loading credentials…')
              : t('admin.credentials.select.placeholder', 'Select a credential…')}
          </option>
          {filtered.map(c => (
            <option key={c.id} value={c.id}>
              {profileLabel(c)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          title={t('admin.credentials.select.refresh', 'Refresh list')}
          className="inline-flex items-center px-2 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
        >
          <Icon name="refresh" size="sm" />
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-1">
          {t('admin.credentials.select.loadError', 'Failed to load credentials: {{error}}', {
            error
          })}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between">
        {help && <p className="text-xs text-gray-500 dark:text-gray-400">{help}</p>}
        <Link
          to="/admin/credentials"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
        >
          {t('admin.credentials.select.createNew', '+ Create new credential')}
        </Link>
      </div>
    </div>
  );
}

/**
 * The OpenAPI source of the integration builder (**Admin → Integrations →
 * Add manually → OpenAPI**): read a document from a URL, a file or pasted
 * text (fetched through the server's SSRF guard), pick the operations that
 * become actions (side effect from the method), and set the base URL and
 * static headers. The parsed document is stored with the integration.
 *
 * @param {Object} props
 * @param {Object} props.value - the draft's `openapi` block (`document`, `baseUrl`, `headers`)
 * @param {Array<Object>} props.actions - the draft's actions
 * @param {(block: Object) => void} props.onChange - new `openapi` block
 * @param {(actions: Array<Object>) => void} props.onActionsChange - new actions
 * @param {Object<string, {key: string, defaultValue: string}>} [props.errors]
 * @returns {JSX.Element}
 */
function OpenApiSourceEditor({ value, actions, onChange, onActionsChange, errors = {} }) {
  const { t } = useTranslation();
  const sourceId = useId();
  const fileId = useId();
  const baseUrlId = useId();
  const [sourceText, setSourceText] = useState(
    typeof value?.document === 'string' ? value.document : ''
  );
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(null);
  const [parsed, setParsed] = useState(null);

  const update = patch => onChange({ ...value, ...patch });
  const picked = (actions || []).map(action => action.operationId);

  const read = async () => {
    if (!sourceText.trim()) return;
    setReading(true);
    setReadError(null);
    try {
      const result = await importBuilderActions({
        kind: 'openapi',
        source: openApiSourceOf(sourceText)
      });
      setParsed(result);
      const patch = { document: result.document };
      if (!value?.baseUrl && result.servers?.[0]?.url) {
        const resolved = resolveServerUrl(result.servers[0].url, sourceText);
        if (resolved) patch.baseUrl = resolved;
      }
      update(patch);
    } catch (err) {
      setReadError(getAdminApiErrorMessage(err));
    } finally {
      setReading(false);
    }
  };

  const readFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSourceText(await file.text());
  };

  const toggle = operationId => {
    const next = picked.includes(operationId)
      ? picked.filter(id => id !== operationId)
      : [...picked, operationId];
    onActionsChange(actionsFromOperations(parsed?.operations || [], next, actions || []));
  };

  const info =
    parsed?.info ||
    (value?.document && typeof value.document === 'object' ? value.document.info : null);

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor={sourceId} className={LABEL_CLASS}>
          {t(
            'admin.integrationBuilder.openapi.source',
            'OpenAPI document: URL or pasted JSON/YAML'
          )}
        </label>
        <textarea
          id={sourceId}
          rows={4}
          value={sourceText}
          onChange={e => setSourceText(e.target.value)}
          className={MONO_INPUT_CLASS}
          placeholder="https://api.example.com/openapi.json"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label htmlFor={fileId} className={`${SECONDARY_BUTTON_CLASS} cursor-pointer`}>
            <Icon name="upload" size="sm" />
            {t('admin.integrationBuilder.openapi.file', 'Load a file')}
          </label>
          <input
            id={fileId}
            type="file"
            accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
            className="sr-only"
            onChange={readFile}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={read}
            disabled={reading || !sourceText.trim()}
          >
            {reading ? <LoadingSpinner size="sm" /> : <Icon name="refresh" size="sm" />}
            {t('admin.integrationBuilder.openapi.read', 'Read document')}
          </button>
        </div>
        {readError && (
          <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
            {t(
              'admin.integrationBuilder.openapi.readError',
              'The document could not be read: {{error}}',
              { error: readError }
            )}
          </p>
        )}
        {errors.document && !value?.document && (
          <p className="mt-2 text-sm text-red-700 dark:text-red-300">
            {t(errors.document.key, errors.document.defaultValue)}
          </p>
        )}
        {info && (
          <p className={HELP_CLASS}>
            {t('admin.integrationBuilder.openapi.parsed', 'Read: {{title}} {{version}}', {
              title: info.title || 'API',
              version: info.version || ''
            })}
          </p>
        )}
      </div>

      {parsed?.operations?.length > 0 && (
        <fieldset className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
          <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.integrationBuilder.openapi.operations', 'Operations that become actions')}
          </legend>
          <ul className="space-y-2 max-h-80 overflow-y-auto">
            {parsed.operations
              .filter(op => op.operationId)
              .map(op => {
                const checkboxId = `${sourceId}-op-${op.operationId}`;
                return (
                  <li key={op.operationId} className="flex items-start gap-2">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      className={`mt-1 ${CHECKBOX_CLASS}`}
                      checked={picked.includes(op.operationId)}
                      onChange={() => toggle(op.operationId)}
                    />
                    <label
                      htmlFor={checkboxId}
                      className="text-sm text-gray-800 dark:text-gray-200"
                    >
                      <span className="font-mono">
                        {String(op.method).toUpperCase()} {op.path}
                      </span>{' '}
                      <span className="text-gray-600 dark:text-gray-400">
                        {op.operationId}
                        {op.summary ? ` · ${op.summary}` : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
          </ul>
          {parsed.operations.some(op => !op.operationId) && (
            <p className={HELP_CLASS}>
              {t(
                'admin.integrationBuilder.openapi.noOperationId',
                'Operations without an operationId cannot become actions.'
              )}
            </p>
          )}
        </fieldset>
      )}
      {!parsed && (actions || []).length > 0 && (
        <p className={CALLOUT_CLASS.info}>
          {t(
            'admin.integrationBuilder.openapi.reread',
            '{{count}} operation(s) picked. Read the document again to change the selection.',
            { count: actions.length }
          )}
        </p>
      )}

      <div>
        <label htmlFor={baseUrlId} className={LABEL_CLASS}>
          {t('admin.integrationBuilder.openapi.baseUrl', 'Base URL')}
        </label>
        <input
          id={baseUrlId}
          type="url"
          value={value?.baseUrl || ''}
          onChange={e => update({ baseUrl: e.target.value })}
          className={MONO_INPUT_CLASS}
          placeholder="https://api.example.com"
          aria-invalid={Boolean(errors.baseUrl)}
        />
        <p className={HELP_CLASS}>
          {errors.baseUrl
            ? t(errors.baseUrl.key, errors.baseUrl.defaultValue)
            : t(
                'admin.integrationBuilder.openapi.baseUrlHelp',
                'The operation paths are appended to it. Empty: the first server of the document.'
              )}
        </p>
      </div>

      <KeyValueRowsEditor
        legend={t('admin.integrationBuilder.headers', 'Static headers')}
        value={value?.headers || {}}
        onChange={headers => update({ headers })}
      />
    </div>
  );
}

export default OpenApiSourceEditor;
