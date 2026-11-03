// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import OpenApiSourceEditor from '../../OpenApiToolEditor';
import KeyValueRowsEditor from './KeyValueRowsEditor';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  RADIO_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../../formStyles';
import Icon from '../../../../../shared/components/Icon';
import { BUILDER_SOURCES, MCP_TRANSPORTS, scriptSkeleton } from './builderModel';

/** The label and one-line description of a source. */
export function sourceText(t, source) {
  switch (source) {
    case 'openapi':
      return [
        t('admin.integrationBuilder.source.openapi', 'OpenAPI'),
        t(
          'admin.integrationBuilder.source.openapiHelp',
          'Pick operations of an OpenAPI document (URL, file or paste).'
        )
      ];
    case 'http':
      return [
        t('admin.integrationBuilder.source.http', 'HTTP request'),
        t(
          'admin.integrationBuilder.source.httpHelp',
          'Wrap REST endpoints without code: method, URL template, body, response mapping.'
        )
      ];
    case 'script':
      return [
        t('admin.integrationBuilder.source.script', 'Script'),
        t(
          'admin.integrationBuilder.source.scriptHelp',
          'Actions backed by a JavaScript module that runs in iHub.'
        )
      ];
    case 'mcp':
      return [
        t('admin.integrationBuilder.source.mcp', 'MCP server'),
        t(
          'admin.integrationBuilder.source.mcpHelp',
          'A Model Context Protocol endpoint or a local command; its tools become actions.'
        )
      ];
    case 'a2a':
      return [
        t('admin.integrationBuilder.source.a2a', 'A2A agent'),
        t(
          'admin.integrationBuilder.source.a2aHelp',
          'A remote agent; the skills of its agent card become actions.'
        )
      ];
    default:
      return [source, ''];
  }
}

function FieldError({ error }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p className="mt-1 text-xs text-red-700 dark:text-red-300">
      {t(error.key, error.defaultValue)}
    </p>
  );
}

/**
 * Step 3 of the integration builder: where the actions come from, and the
 * settings of that source. Switching the source drops the actions of the
 * previous one (the page asks first).
 *
 * @param {Object} props
 * @param {Object} props.draft
 * @param {(patch: Object) => void} props.onChange - patch the draft
 * @param {(source: string) => void} props.onSourceChange
 * @param {Object<string, {key: string, defaultValue: string}>} props.errors
 * @returns {JSX.Element}
 */
function BuilderSourceStep({ draft, onChange, onSourceChange, errors }) {
  const { t } = useTranslation();
  const groupId = useId();
  const fieldId = useId();
  const block = draft[draft.source] || {};
  const setBlock = patch => onChange({ [draft.source]: { ...block, ...patch } });

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className={LABEL_CLASS}>
          {t('admin.integrationBuilder.source.label', 'Where the actions come from')}
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {BUILDER_SOURCES.map(source => {
            const [label, help] = sourceText(t, source);
            const id = `${groupId}-${source}`;
            return (
              <div
                key={source}
                className={`flex items-start gap-2 rounded-md border p-3 ${
                  draft.source === source
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <input
                  id={id}
                  type="radio"
                  name={`${groupId}-source`}
                  value={source}
                  checked={draft.source === source}
                  onChange={() => onSourceChange(source)}
                  className={`mt-1 ${RADIO_CLASS}`}
                  aria-describedby={`${id}-help`}
                />
                <label htmlFor={id} className="text-sm">
                  <span className="block font-medium text-gray-900 dark:text-gray-100">
                    {label}
                  </span>
                  <span id={`${id}-help`} className="block text-gray-600 dark:text-gray-400">
                    {help}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      {draft.source === 'openapi' && (
        <OpenApiSourceEditor
          value={block}
          actions={draft.actions}
          onChange={openapi => onChange({ openapi })}
          onActionsChange={actions => onChange({ actions })}
          errors={errors}
        />
      )}

      {draft.source === 'http' && (
        <div className="space-y-5">
          <div>
            <label htmlFor={`${fieldId}-base`} className={LABEL_CLASS}>
              {t('admin.integrationBuilder.http.baseUrl', 'Base URL (optional)')}
            </label>
            <input
              id={`${fieldId}-base`}
              type="url"
              value={block.baseUrl || ''}
              onChange={e => setBlock({ baseUrl: e.target.value })}
              className={MONO_INPUT_CLASS}
              placeholder="https://erp.example.com/api"
              aria-invalid={Boolean(errors.baseUrl)}
            />
            <FieldError error={errors.baseUrl} />
            <p className={HELP_CLASS}>
              {t(
                'admin.integrationBuilder.http.baseUrlHelp',
                'Relative action URLs are appended to it. Calls go through the SSRF guard: a private address must be allowed under the integrations’ allowed hosts.'
              )}
            </p>
          </div>
          <KeyValueRowsEditor
            legend={t('admin.integrationBuilder.headers', 'Static headers')}
            help={t(
              'admin.integrationBuilder.http.headersHelp',
              'Sent with every request; no secrets here, they belong to the sign-in.'
            )}
            value={block.headers || {}}
            onChange={headers => setBlock({ headers })}
          />
        </div>
      )}

      {draft.source === 'script' && (
        <div className="space-y-3">
          <div className={CALLOUT_CLASS.warning}>
            {t(
              'admin.integrationBuilder.script.warning',
              'The module runs inside the iHub server with its permissions. Only use code you trust.'
            )}
          </div>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <label htmlFor={`${fieldId}-module`} className={LABEL_CLASS}>
              {t(
                'admin.integrationBuilder.script.module',
                'Connector module (actions/connector.js)'
              )}
            </label>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => setBlock({ module: scriptSkeleton(draft.actions) })}
            >
              <Icon name="code" size="sm" />
              {t('admin.integrationBuilder.script.skeleton', 'Insert a stub for every action')}
            </button>
          </div>
          <textarea
            id={`${fieldId}-module`}
            rows={22}
            spellCheck={false}
            value={block.module || ''}
            onChange={e => setBlock({ module: e.target.value })}
            className={`${MONO_INPUT_CLASS} bg-white dark:bg-gray-900`}
            aria-invalid={Boolean(errors.module)}
            aria-describedby={`${fieldId}-module-help`}
          />
          <FieldError error={errors.module} />
          <p id={`${fieldId}-module-help`} className={HELP_CLASS}>
            {t(
              'admin.integrationBuilder.script.help',
              'One ES module, no imports from its folder. export default { actions: { <name>: { run: async (args, ctx) => … } } }. ctx.values holds the install values, ctx.user the caller, ctx.runToolScript(script, { method }) runs one of iHub’s tool scripts. Declare the actions (description, parameters) on the next step.'
            )}
          </p>
        </div>
      )}

      {draft.source === 'mcp' && (
        <div className="space-y-5">
          <div>
            <label htmlFor={`${fieldId}-transport`} className={LABEL_CLASS}>
              {t('admin.integrationBuilder.mcp.transport', 'Transport')}
            </label>
            <select
              id={`${fieldId}-transport`}
              value={block.transport || 'streamableHttp'}
              onChange={e => setBlock({ transport: e.target.value })}
              className={INPUT_CLASS}
            >
              {MCP_TRANSPORTS.map(transport => (
                <option key={transport} value={transport}>
                  {t(`admin.integrationBuilder.mcp.transports.${transport}`, transport)}
                </option>
              ))}
            </select>
          </div>
          {block.transport === 'stdio' ? (
            <>
              <div className={CALLOUT_CLASS.warning}>
                {t(
                  'admin.integrationBuilder.mcp.stdioWarning',
                  'iHub starts this command on its server. A local process cannot be exported to a registry.'
                )}
              </div>
              <div>
                <label htmlFor={`${fieldId}-command`} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.mcp.command', 'Command')}
                </label>
                <input
                  id={`${fieldId}-command`}
                  type="text"
                  value={block.command || ''}
                  onChange={e => setBlock({ command: e.target.value })}
                  className={MONO_INPUT_CLASS}
                  placeholder="npx"
                  aria-invalid={Boolean(errors.command)}
                />
                <FieldError error={errors.command} />
              </div>
              <div>
                <label htmlFor={`${fieldId}-args`} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.mcp.args', 'Arguments (one per line)')}
                </label>
                <textarea
                  id={`${fieldId}-args`}
                  rows={3}
                  value={(block.args || []).join('\n')}
                  onChange={e => setBlock({ args: e.target.value.split('\n').filter(Boolean) })}
                  className={MONO_INPUT_CLASS}
                />
              </div>
              <KeyValueRowsEditor
                legend={t('admin.integrationBuilder.mcp.env', 'Environment variables')}
                value={block.env || {}}
                onChange={env => setBlock({ env })}
              />
            </>
          ) : (
            <>
              <div>
                <label htmlFor={`${fieldId}-url`} className={LABEL_CLASS}>
                  {t('admin.integrationBuilder.mcp.url', 'Server URL')}
                </label>
                <input
                  id={`${fieldId}-url`}
                  type="url"
                  value={block.url || ''}
                  onChange={e => setBlock({ url: e.target.value })}
                  className={MONO_INPUT_CLASS}
                  placeholder="https://mcp.example.com/mcp"
                  aria-invalid={Boolean(errors.url)}
                />
                <FieldError error={errors.url} />
              </div>
              {block.transport !== 'websocket' && (
                <KeyValueRowsEditor
                  legend={t('admin.integrationBuilder.headers', 'Static headers')}
                  value={block.headers || {}}
                  onChange={headers => setBlock({ headers })}
                />
              )}
            </>
          )}
        </div>
      )}

      {draft.source === 'a2a' && (
        <div>
          <label htmlFor={`${fieldId}-card`} className={LABEL_CLASS}>
            {t('admin.integrationBuilder.a2a.cardUrl', 'Agent card URL')}
          </label>
          <input
            id={`${fieldId}-card`}
            type="url"
            value={block.cardUrl || ''}
            onChange={e => setBlock({ cardUrl: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder="https://agent.example.com/.well-known/agent-card.json"
            aria-invalid={Boolean(errors.cardUrl)}
          />
          <FieldError error={errors.cardUrl} />
        </div>
      )}
    </div>
  );
}

export default BuilderSourceStep;
