import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { getAdminApiErrorMessage, listCredentials, parseOpenApiSpec } from '../../../api/adminApi';
/**
 * Shared input styling. The project does not use @tailwindcss/forms, so a bare
 * border class would render no border width. These classes set an explicit
 * border, padding, colour, and focus ring for legibility in light/dark mode.
 */
const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500';
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
export function CredentialRefSelect({ value, onChange, types, label, help, required }) {
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
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="flex items-center gap-2">
        <select
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
 * The schema stores `openapi.source` as a structured object
 * (`{ type: 'url'|'inline'|'file', url|spec|path }`), but the editor exposes it
 * as a single textarea. These helpers convert between the two representations.
 */
function sourceToString(source) {
  if (!source) return '';
  if (typeof source === 'string') return source; // legacy / hand-edited
  if (source.type === 'url') return source.url || '';
  if (source.type === 'file') return source.path || '';
  if (source.type === 'inline') {
    return typeof source.spec === 'string' ? source.spec : JSON.stringify(source.spec, null, 2);
  }
  return '';
}

function stringToSource(str) {
  const trimmed = (str || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return { type: 'url', url: trimmed };
  // Anything else is treated as an inline spec document (JSON/YAML string).
  return { type: 'inline', spec: str };
}

/**
 * Build a default OpenAPI tool definition skeleton.
 * @param {object} [tool] - Existing tool to seed the form from
 * @returns {object}
 */
/**
 * Normalize a localized field to `{ [lang]: string }`. Accepts the legacy
 * plain-string shape that older OpenAPI tool saves produced and lifts it into
 * the canonical map keyed by language code.
 */
function toLocalized(value) {
  if (!value) return { en: '' };
  if (typeof value === 'string') return { en: value };
  if (typeof value === 'object') return value;
  return { en: '' };
}

function toFormState(tool) {
  const openapi = tool?.openapi || {};
  const credentialRef = openapi.auth?.credentialRef || '';
  return {
    id: tool?.id || '',
    // Preserve the full localized object so multilingual values entered via
    // the JSON editor (or by the generic ToolFormEditor) round-trip cleanly.
    name: toLocalized(tool?.name),
    description: toLocalized(tool?.description),
    source: sourceToString(openapi.source),
    operationId: openapi.operationId || '',
    baseUrl: openapi.baseUrl || '',
    // Existing tools with no credentialRef are treated as public.
    authMode: credentialRef ? 'credential' : 'none',
    credentialRef,
    headers: openapi.headers
      ? Object.entries(openapi.headers).map(([key, val]) => ({ key, value: val }))
      : [],
    hideFields: (openapi.xDisplay?.hideFields || []).join(', '),
    maxResponseBytes: openapi.maxResponseBytes ?? '',
    timeoutMs: openapi.timeoutMs ?? ''
  };
}

/**
 * True when a localized map contains at least one non-empty string. Empty
 * objects and `{ en: '' }` both count as missing.
 */
function hasLocalizedContent(map) {
  if (!map || typeof map !== 'object') return false;
  return Object.values(map).some(v => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Resolve a `servers[].url` entry against the URL the OpenAPI spec was fetched
 * from. OpenAPI 3 allows server URLs to be relative — the convention is to
 * resolve them against the document's URL. For inline / file sources we can't
 * derive an origin, so a relative server URL stays unresolved and the admin
 * must enter the absolute Base URL by hand.
 *
 * @param {string} serverUrl - The `servers[0].url` value from the parsed spec
 * @param {string} sourceText - The raw source field (spec URL when type='url')
 * @returns {string|null} An absolute URL, or null when one can't be derived
 */
function resolveServerUrl(serverUrl, sourceText) {
  if (!serverUrl) return null;
  if (/^https?:\/\//i.test(serverUrl)) return serverUrl;
  const specUrl = (sourceText || '').trim();
  if (!/^https?:\/\//i.test(specUrl)) return null;
  try {
    return new URL(serverUrl, specUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Editor pane for OpenAPI-backed tools.
 *
 * Lets the admin parse an OpenAPI spec (URL/inline), pick an operation, choose a
 * credential reference for auth, and configure optional overrides. Calls the
 * provided `onSave` with a complete `type:'openapi'` tool definition.
 *
 * @param {object} props
 * @param {object} [props.tool] - Existing tool being edited (undefined for new)
 * @param {(toolDef: object) => Promise<void>|void} props.onSave - Persist handler
 * @param {boolean} [props.saving] - Whether a save is in progress
 * @returns {JSX.Element}
 */
function OpenApiToolEditor({ tool, onSave, saving }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(() => toFormState(tool));
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState(null);
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    setForm(toFormState(tool));
  }, [tool]);

  const isNew = !tool?.id;

  const update = patch => setForm(prev => ({ ...prev, ...patch }));

  /** Parse the OpenAPI source and populate the operation dropdown. */
  const handleParse = async () => {
    if (!form.source) return;
    setParsing(true);
    setParseError(null);
    setParseResult(null);
    try {
      const result = await parseOpenApiSpec(stringToSource(form.source));
      setParseResult(result);
      // Default baseUrl from the first server entry. The spec is allowed to
      // declare a relative server URL (e.g. `/administration-api`), which
      // we resolve against the spec URL's origin per OpenAPI convention.
      // When that's impossible (inline spec, no http source), leave baseUrl
      // empty so the admin enters it explicitly.
      if (!form.baseUrl && Array.isArray(result.servers) && result.servers[0]?.url) {
        const resolved = resolveServerUrl(result.servers[0].url, form.source);
        if (resolved) update({ baseUrl: resolved });
      }
    } catch (err) {
      setParseError(err.response?.data?.error || err.message);
    } finally {
      setParsing(false);
    }
  };

  const selectedOperation = parseResult?.operations?.find(
    op => op.operationId === form.operationId
  );

  /** Build the tool definition and delegate persistence to the parent. */
  const handleSave = () => {
    const headers = {};
    for (const row of form.headers) {
      if (row.key) headers[row.key] = row.value;
    }
    const hideFields = form.hideFields
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const openapi = {
      source: stringToSource(form.source),
      operationId: form.operationId
    };
    if (form.authMode === 'credential' && form.credentialRef) {
      openapi.auth = { credentialRef: form.credentialRef };
    }
    if (form.baseUrl) openapi.baseUrl = form.baseUrl;
    if (Object.keys(headers).length > 0) openapi.headers = headers;
    if (hideFields.length > 0) openapi.xDisplay = { hideFields };
    if (form.maxResponseBytes !== '' && form.maxResponseBytes != null) {
      openapi.maxResponseBytes = Number(form.maxResponseBytes);
    }
    if (form.timeoutMs !== '' && form.timeoutMs != null) {
      openapi.timeoutMs = Number(form.timeoutMs);
    }

    const toolDef = {
      id: form.id,
      // Persist the full localized map. Fall back to `{ en: form.id }` when
      // the admin hasn't typed anything yet so the server's `name` requirement
      // is satisfied. Description is optional — omit when empty.
      name: hasLocalizedContent(form.name) ? form.name : { en: form.id },
      description: hasLocalizedContent(form.description) ? form.description : undefined,
      type: 'openapi',
      enabled: tool?.enabled ?? true,
      openapi
    };

    onSave(toolDef);
  };

  const addHeaderRow = () => update({ headers: [...form.headers, { key: '', value: '' }] });
  const updateHeaderRow = (idx, patch) =>
    update({ headers: form.headers.map((row, i) => (i === idx ? { ...row, ...patch } : row)) });
  const removeHeaderRow = idx => update({ headers: form.headers.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-6">
      {/* Identity — stacked because DynamicLanguageEditor adds a language tab
          row above its input, which made the side-by-side layout look misaligned
          against the single-row ID field. */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('admin.tools.openapi.form.id', 'Tool ID')}
          <span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          type="text"
          value={form.id}
          disabled={!isNew}
          onChange={e => update({ id: e.target.value })}
          className={MONO_INPUT_CLASS}
          placeholder="my-openapi-tool"
        />
      </div>
      <div>
        {/* Multilingual name editor — same component as the generic tool form,
            so values entered here round-trip cleanly with the JSON editor and
            other tool types. */}
        <DynamicLanguageEditor
          label={
            <>
              {t('admin.tools.openapi.form.name', 'Name')}
              <span className="text-red-500 ml-0.5">*</span>
            </>
          }
          value={form.name}
          onChange={val => update({ name: val })}
          required
          placeholder={{ en: 'My OpenAPI tool', de: 'Mein OpenAPI-Tool' }}
        />
      </div>
      <div>
        <DynamicLanguageEditor
          label={t('admin.tools.openapi.form.description', 'Description')}
          value={form.description}
          onChange={val => update({ description: val })}
          type="textarea"
          placeholder={{
            en: 'What the operation does, shown to the LLM for tool selection',
            de: 'Was die Operation tut, dem LLM zur Tool-Auswahl gezeigt'
          }}
        />
      </div>

      {/* Spec source + parse */}
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
          {t('admin.tools.openapi.form.spec', 'OpenAPI specification')}
        </legend>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.tools.openapi.form.source', 'Source (URL or inline JSON/YAML)')}
          </label>
          <textarea
            rows={3}
            value={form.source}
            onChange={e => update({ source: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder="https://api.example.com/openapi.json"
          />
        </div>
        <button
          type="button"
          onClick={handleParse}
          disabled={parsing || !form.source}
          className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
        >
          {parsing ? (
            <>
              <LoadingSpinner size="sm" />
              <span className="ml-2">{t('admin.tools.openapi.form.parsing', 'Parsing…')}</span>
            </>
          ) : (
            <>
              <Icon name="refresh" size="sm" className="mr-1.5" />
              {t('admin.tools.openapi.form.parse', 'Fetch & parse')}
            </>
          )}
        </button>
        {parseError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('admin.tools.openapi.form.parseError', 'Parse failed: {{error}}', {
              error: parseError
            })}
          </p>
        )}
        {parseResult?.info && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.tools.openapi.form.parsedInfo', 'Parsed: {{title}} v{{version}}', {
              title: parseResult.info.title || 'API',
              version: parseResult.info.version || '?'
            })}
          </p>
        )}
      </fieldset>

      {/* Operation selection */}
      {parseResult?.operations?.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.tools.openapi.form.operation', 'Operation')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <select
            value={form.operationId}
            onChange={e => update({ operationId: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value="">
              {t('admin.tools.openapi.form.operationPlaceholder', 'Select an operation…')}
            </option>
            {parseResult.operations.map(op => (
              <option key={op.operationId} value={op.operationId}>
                {`${op.operationId} — ${(op.method || '').toUpperCase()} ${op.path}${
                  op.summary ? ` — ${op.summary}` : ''
                }`}
              </option>
            ))}
          </select>
          {selectedOperation?.parameters?.length > 0 && (
            <div className="mt-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('admin.tools.openapi.form.parameters', 'Parameters')}
              </p>
              <ul className="space-y-1">
                {selectedOperation.parameters.map(param => (
                  <li
                    key={`${param.in}-${param.name}`}
                    className="text-xs text-gray-600 dark:text-gray-400 font-mono"
                  >
                    {param.name}
                    <span className="text-gray-400 dark:text-gray-500">
                      {' '}
                      ({param.in}
                      {param.required ? ', required' : ''})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Base URL — required when the spec declares no absolute server, and
          surfaced as a primary field (not buried under Advanced) so admins
          don't miss it for specs whose servers[0].url is relative. */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('admin.tools.openapi.form.baseUrl', 'Base URL')}
          <span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          type="url"
          value={form.baseUrl}
          onChange={e => update({ baseUrl: e.target.value })}
          className={MONO_INPUT_CLASS}
          placeholder="https://api.example.com"
          required
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.tools.openapi.form.baseUrlHelp',
            'Absolute URL the operation paths are appended to. Defaults to servers[0] from the spec; resolved against the spec URL when relative.'
          )}
        </p>
      </div>

      {/* Auth — supports public (no-auth) APIs as well as credential profiles. */}
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
          {t('admin.tools.openapi.form.auth', 'Authentication')}
        </legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="radio"
              name="openapi-auth-mode"
              value="credential"
              checked={form.authMode === 'credential'}
              onChange={() => update({ authMode: 'credential' })}
            />
            {t('admin.tools.openapi.form.authMode.credential', 'Use credential profile')}
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="radio"
              name="openapi-auth-mode"
              value="none"
              checked={form.authMode === 'none'}
              onChange={() => update({ authMode: 'none', credentialRef: '' })}
            />
            {t('admin.tools.openapi.form.authMode.none', 'No authentication (public API)')}
          </label>
        </div>
        {form.authMode === 'credential' && (
          <CredentialRefSelect
            value={form.credentialRef}
            onChange={id => update({ credentialRef: id })}
            label={t('admin.tools.openapi.form.credentialRef', 'Credential')}
            required
            help={t(
              'admin.tools.openapi.form.credentialRefHelp',
              'Auth profile applied to requests. OpenAPI supports bearer, basic, API key, and OAuth2 credentials.'
            )}
          />
        )}
      </fieldset>

      {/* Optional overrides */}
      <fieldset className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
          {t('admin.tools.openapi.form.advanced', 'Advanced (optional)')}
        </legend>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('admin.tools.openapi.form.headers', 'Static headers')}
            </label>
            <button
              type="button"
              onClick={addHeaderRow}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              {t('admin.tools.openapi.form.addHeader', '+ Add header')}
            </button>
          </div>
          {form.headers.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={row.key}
                onChange={e => updateHeaderRow(idx, { key: e.target.value })}
                className={MONO_INPUT_CLASS}
                placeholder={t('admin.tools.openapi.form.headerKey', 'Header name')}
              />
              <input
                type="text"
                value={row.value}
                onChange={e => updateHeaderRow(idx, { value: e.target.value })}
                className={MONO_INPUT_CLASS}
                placeholder={t('admin.tools.openapi.form.headerValue', 'Value')}
              />
              <button
                type="button"
                onClick={() => removeHeaderRow(idx)}
                className="inline-flex items-center px-2 py-2 border border-red-300 dark:border-red-700 rounded text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50"
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          ))}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.tools.openapi.form.hideFields', 'Hidden fields (comma-separated)')}
          </label>
          <input
            type="text"
            value={form.hideFields}
            onChange={e => update({ hideFields: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder="apiKey, internalId"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.tools.openapi.form.maxResponseBytes', 'Max response bytes')}
            </label>
            <input
              type="number"
              min="0"
              value={form.maxResponseBytes}
              onChange={e => update({ maxResponseBytes: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.tools.openapi.form.timeoutMs', 'Timeout (ms)')}
            </label>
            <input
              type="number"
              min="0"
              value={form.timeoutMs}
              onChange={e => update({ timeoutMs: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      </fieldset>

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={
            saving ||
            !form.id ||
            !hasLocalizedContent(form.name) ||
            !form.operationId ||
            !/^https?:\/\//i.test(form.baseUrl) ||
            (form.authMode === 'credential' && !form.credentialRef)
          }
          className="px-4 py-2 rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
        >
          {saving
            ? t('common.saving', 'Saving…')
            : t('admin.tools.openapi.form.save', 'Save OpenAPI tool')}
        </button>
      </div>
    </div>
  );
}

export default OpenApiToolEditor;
