// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import { testIntegrationAction } from '../../../../api/integrationsAdminApi';
import { getAdminApiErrorMessage } from '../../../../api/adminApi';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  RADIO_CLASS
} from '../formStyles';
import { argsFromFormValues, formFieldsFromSchema, initialFormValues } from './actionTestForm';

const PRE_CLASS =
  'mt-2 max-h-80 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-xs text-gray-800 whitespace-pre-wrap break-all dark:bg-gray-950 dark:text-gray-200';
const SUMMARY_CLASS =
  'cursor-pointer rounded-sm text-sm font-medium text-gray-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-200';

/** Badge tone of a test status. */
const STATUS_TONE = { ok: 'success', error: 'danger', timeout: 'warning' };

/**
 * The label of a connection a test can run with.
 * @param {Function} t
 * @param {{id: string, kind: string, credentialRef?: string}} connection
 * @param {string} userName - the acting admin
 * @returns {string}
 */
function connectionLabel(t, connection, userName) {
  if (connection.id === 'shared') {
    return connection.credentialRef
      ? t(
          'admin.integrations.actionDetail.test.connectionShared',
          'Shared credential of the installation ({{ref}})',
          { ref: connection.credentialRef }
        )
      : t(
          'admin.integrations.actionDetail.test.connectionSharedNoRef',
          'Shared credential of the installation'
        );
  }
  if (connection.kind === 'personal') {
    return t(
      'admin.integrations.actionDetail.test.connectionPersonal',
      'My own connection ({{user}})',
      { user: userName }
    );
  }
  return t('admin.integrations.actionDetail.test.connectionMe', 'As me ({{user}})', {
    user: userName
  });
}

/**
 * One input of the generated test form.
 * @param {Object} props
 * @param {Object} props.field - from `formFieldsFromSchema`
 * @param {string|boolean} props.value
 * @param {string|undefined} props.error - `required`, `number`, `integer` or `json`
 * @param {(value: string|boolean) => void} props.onChange
 * @param {boolean} props.disabled
 */
function SchemaField({ field, value, error, onChange, disabled }) {
  const { t } = useTranslation();
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy =
    [field.description ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  const errorText = {
    required: t('admin.integrations.actionDetail.test.errorRequired', 'Required'),
    number: t('admin.integrations.actionDetail.test.errorNumber', 'Enter a number'),
    integer: t('admin.integrations.actionDetail.test.errorInteger', 'Enter a whole number'),
    json: t('admin.integrations.actionDetail.test.errorJson', 'Enter valid JSON')
  }[error];

  if (field.kind === 'boolean') {
    return (
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          className={`${CHECKBOX_CLASS} mt-0.5`}
          checked={value === true}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.checked)}
        />
        <div>
          <label htmlFor={id} className="text-sm font-mono text-gray-800 dark:text-gray-200">
            {field.name}
          </label>
          {field.description && (
            <p id={helpId} className={HELP_CLASS}>
              {field.description}
            </p>
          )}
        </div>
      </div>
    );
  }

  const common = {
    id,
    value: typeof value === 'string' ? value : '',
    disabled,
    'aria-required': field.required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    onChange: e => onChange(e.target.value)
  };
  let input;
  if (field.kind === 'enum') {
    input = (
      <select {...common} className={INPUT_CLASS}>
        <option value="">
          {field.required
            ? t('admin.integrations.actionDetail.test.choose', 'Choose…')
            : t('admin.integrations.actionDetail.test.notSet', '(not set)')}
        </option>
        {field.options.map(option => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  } else if (field.kind === 'json' || field.multiline) {
    input = (
      <textarea
        {...common}
        rows={field.kind === 'json' ? 4 : 3}
        className={field.kind === 'json' ? MONO_INPUT_CLASS : INPUT_CLASS}
      />
    );
  } else {
    input = (
      <input
        {...common}
        type={field.kind === 'integer' || field.kind === 'number' ? 'number' : 'text'}
        step={field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined}
        className={INPUT_CLASS}
      />
    );
  }
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        <span className="font-mono">{field.name}</span>
        {field.required && (
          <span className="ml-1 text-red-700 dark:text-red-400">
            *
            <span className="sr-only">
              {t('admin.integrations.actionDetail.test.requiredSr', '(required)')}
            </span>
          </span>
        )}
        {field.kind === 'json' && (
          <span className="ml-2 text-xs font-normal text-gray-600 dark:text-gray-400">JSON</span>
        )}
      </label>
      {input}
      {field.description && (
        <p id={helpId} className={HELP_CLASS}>
          {field.description}
        </p>
      )}
      {errorText && (
        <p id={errorId} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}
    </div>
  );
}

/**
 * The result of a test run: status, duration, the request as sent (secrets
 * redacted by the server), the raw response and the Answer Sources.
 * @param {Object} props
 * @param {Object} props.result - the server's test result
 */
export function ActionTestResult({ result }) {
  const { t } = useTranslation();
  const sources = result.sources?.items || [];
  const statusText = {
    ok: t('admin.integrations.actionDetail.test.statusOk', 'Succeeded'),
    error: t('admin.integrations.actionDetail.test.statusError', 'Failed'),
    timeout: t('admin.integrations.actionDetail.test.statusTimeout', 'Timed out')
  }[result.status];
  return (
    <div
      className="mt-4 rounded-md border border-gray-200 p-3 dark:border-gray-700"
      data-testid="action-test-result"
    >
      <h4 className="sr-only">{t('admin.integrations.actionDetail.test.result', 'Result')}</h4>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <Badge tone={STATUS_TONE[result.status] || 'neutral'}>{statusText || result.status}</Badge>
        {Number.isInteger(result.httpStatus) && (
          <span>
            {t('admin.integrations.actionDetail.test.httpStatus', 'HTTP {{status}}', {
              status: result.httpStatus
            })}
          </span>
        )}
        <span>
          {t('admin.integrations.actionDetail.test.duration', '{{ms}} ms', {
            ms: result.durationMs
          })}
        </span>
        <span>
          {t('admin.integrations.actionDetail.test.sourceCount', 'Answer Sources: {{count}}', {
            count: sources.length
          })}
        </span>
      </div>
      {result.error && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-400" data-testid="action-test-error">
          {result.error}
        </p>
      )}
      <details className="mt-3">
        <summary className={SUMMARY_CLASS}>
          {t('admin.integrations.actionDetail.test.request', 'Request as sent')}
        </summary>
        <pre className={PRE_CLASS} data-testid="action-test-request">
          {JSON.stringify(
            { action: result.request?.action, arguments: result.request?.args },
            null,
            2
          )}
        </pre>
        {(result.request?.http || []).length === 0 ? (
          <p className={HELP_CLASS}>
            {t(
              'admin.integrations.actionDetail.test.noHttp',
              'No HTTP request was recorded (the action ran in iHub, or its system is reached another way).'
            )}
          </p>
        ) : (
          result.request.http.map(request => (
            <pre key={request.seq} className={PRE_CLASS}>
              {`${request.method} ${request.url}${
                Number.isInteger(request.status) ? `  → ${request.status}` : ''
              }\n${Object.entries(request.headers || {})
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n')}${request.body ? `\n\n${request.body}` : ''}`}
            </pre>
          ))
        )}
      </details>
      <details className="mt-2">
        <summary className={SUMMARY_CLASS}>
          {t('admin.integrations.actionDetail.test.response', 'Raw response')}
          {result.response?.truncated && (
            <span className="ml-2 text-xs font-normal">
              {t('admin.integrations.actionDetail.test.truncated', '(shortened)')}
            </span>
          )}
        </summary>
        <pre className={PRE_CLASS} data-testid="action-test-response">
          {result.response?.text ?? '—'}
        </pre>
      </details>
      <details className="mt-2" open={sources.length > 0}>
        <summary className={SUMMARY_CLASS}>
          {t('admin.integrations.actionDetail.test.sources', 'Answer Sources')}
        </summary>
        {sources.length === 0 ? (
          <p className={HELP_CLASS}>
            {t(
              'admin.integrations.actionDetail.test.noSources',
              'The result produced no Answer Sources.'
            )}
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm" data-testid="action-test-sources">
            {sources.map(source => (
              <li
                key={source.id || source.url || source.title}
                className="text-gray-800 dark:text-gray-200"
              >
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm text-indigo-700 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                  >
                    {source.title || source.url}
                    <span className="sr-only">
                      {t('admin.integrations.page.opensInNewTab', '(opens in a new tab)')}
                    </span>
                  </a>
                ) : (
                  source.title || source.fileName || source.id
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

/**
 * Test one action without a model (#2974): a form generated from the action's
 * parameter schema, the connection to run with, and — for anything that is not
 * a trusted read — an explicit confirmation. The server enforces the
 * confirmation too (409 `CONFIRMATION_REQUIRED`); the checkbox only sends it.
 *
 * @param {Object} props
 * @param {string} props.instanceId
 * @param {Object} props.detail - the action detail (`GET …/actions/:action`)
 * @param {string} [props.userName] - the acting admin, for the connection label
 * @returns {JSX.Element}
 */
function ActionTestPanel({ instanceId, detail, userName = '' }) {
  const { t } = useTranslation();
  const formId = useId();
  const fields = useMemo(
    () => formFieldsFromSchema(detail.action.parameters),
    [detail.action.parameters]
  );
  const [values, setValues] = useState(() => initialFormValues(fields));
  const [errors, setErrors] = useState({});
  const connections = detail.test.connections || [];
  const [connection, setConnection] = useState(connections[0]?.id || 'me');
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState(null);
  const [result, setResult] = useState(null);
  const needsConfirmation = detail.test.needsConfirmation;

  const run = async event => {
    event.preventDefault();
    const { args, errors: problems } = argsFromFormValues(fields, values);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setRunning(true);
    setFailure(null);
    setResult(null);
    try {
      setResult(
        await testIntegrationAction(instanceId, detail.action.name, {
          args,
          connection,
          confirm: needsConfirmation && confirmed
        })
      );
    } catch (err) {
      setFailure(getAdminApiErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  if (!detail.test.runnable) {
    return (
      <p className={CALLOUT_CLASS.warning}>
        {t(
          'admin.integrations.actionDetail.test.notRunnable',
          'This action cannot run with the current settings: {{reason}}',
          { reason: detail.action.error || '—' }
        )}
      </p>
    );
  }

  return (
    <form
      noValidate
      onSubmit={run}
      aria-describedby={`${formId}-help`}
      data-testid="action-test-panel"
    >
      <p id={`${formId}-help`} className="mb-3 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.integrations.actionDetail.test.help',
          'Runs the action directly, without the model. Every run is written to the audit log.'
        )}
      </p>
      <div className="space-y-3">
        {fields.length === 0 ? (
          <p className={HELP_CLASS}>
            {t('admin.integrations.actionDetail.test.noParameters', 'This action takes no input.')}
          </p>
        ) : (
          fields.map(field => (
            <SchemaField
              key={field.name}
              field={field}
              value={values[field.name]}
              error={errors[field.name]}
              disabled={running}
              onChange={value => setValues(current => ({ ...current, [field.name]: value }))}
            />
          ))
        )}
      </div>

      <fieldset className="mt-4">
        <legend className={LABEL_CLASS}>
          {t('admin.integrations.actionDetail.test.runAs', 'Run as')}
        </legend>
        <div className="space-y-1">
          {connections.map(option => (
            <label
              key={option.id}
              className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
            >
              <input
                type="radio"
                name={`${formId}-connection`}
                value={option.id}
                checked={connection === option.id}
                disabled={running}
                onChange={() => setConnection(option.id)}
                className={RADIO_CLASS}
              />
              {connectionLabel(t, option, userName)}
            </label>
          ))}
        </div>
      </fieldset>

      {needsConfirmation && (
        <label
          className="mt-4 flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
          data-testid="action-test-confirm"
        >
          <input
            type="checkbox"
            className={`${CHECKBOX_CLASS} mt-0.5`}
            checked={confirmed}
            disabled={running}
            onChange={e => setConfirmed(e.target.checked)}
          />
          <span>
            {t(
              'admin.integrations.actionDetail.test.confirm',
              'I understand that this test can change data in {{integration}} (side effect: {{effect}}).',
              {
                integration: detail.installation.label,
                effect: t(
                  `admin.integrationCatalog.sideEffect.${detail.effect.sideEffect}`,
                  detail.effect.sideEffect
                )
              }
            )}
          </span>
        </label>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          className={PRIMARY_BUTTON_CLASS}
          disabled={running || (needsConfirmation && !confirmed)}
        >
          <Icon name="play" size="sm" />
          {running
            ? t('admin.integrations.actionDetail.test.running', 'Running…')
            : t('admin.integrations.actionDetail.test.run', 'Run test')}
        </button>
      </div>

      <div aria-live="polite">
        {failure && (
          <p className={`mt-3 ${CALLOUT_CLASS.danger}`} role="alert">
            {failure}
          </p>
        )}
        {result && <ActionTestResult result={result} />}
      </div>
    </form>
  );
}

export default ActionTestPanel;
