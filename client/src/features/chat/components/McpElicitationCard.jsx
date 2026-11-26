// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { answerInteraction } from '../../../api';

const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';

const STRING_INPUT_TYPES = {
  email: 'email',
  uri: 'url',
  date: 'date',
  'date-time': 'datetime-local'
};

/** The starting values of the form: the defaults the server sent. */
export function initialValues(schema) {
  const values = {};
  for (const [name, field] of Object.entries(schema?.properties || {})) {
    if (field.default !== undefined) values[name] = field.default;
    else if (field.type === 'boolean') values[name] = false;
    else if (field.type === 'array') values[name] = [];
  }
  return values;
}

/**
 * The answer's data and the fields that still need something, each value as
 * its schema type.
 *
 * @param {Object} schema - The form (`prompt.inputSchema`)
 * @param {Object} values - What the person entered
 * @returns {{data: Object, missing: string[], invalid: string[]}}
 */
export function formAnswer(schema, values) {
  const data = {};
  const missing = [];
  const invalid = [];
  const required = new Set(schema?.required || []);
  for (const [name, field] of Object.entries(schema?.properties || {})) {
    const value = values[name];
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length);
    if (empty) {
      if (required.has(name) && field.type !== 'boolean') missing.push(name);
      if (field.type === 'boolean') data[name] = false;
      continue;
    }
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(value);
      if (
        !Number.isFinite(number) ||
        (field.type === 'integer' && !Number.isInteger(number)) ||
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      ) {
        invalid.push(name);
        continue;
      }
      data[name] = number;
    } else if (field.type === 'boolean') {
      data[name] = value === true;
    } else if (field.type === 'array') {
      data[name] = value;
    } else {
      const text = String(value);
      if (
        (field.minLength !== undefined && text.length < field.minLength) ||
        (field.maxLength !== undefined && text.length > field.maxLength)
      ) {
        invalid.push(name);
        continue;
      }
      data[name] = text;
    }
  }
  return { data, missing, invalid };
}

/** One form field, as its schema type asks. */
function Field({ name, field, value, onChange, disabled, required, problem }) {
  const { t } = useTranslation();
  const id = useId();
  const hintId = `${id}-hint`;
  const label = field.title || name;
  const describedBy = field.description || problem ? hintId : undefined;

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={e => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500"
        />
        <label htmlFor={id} className="text-sm">
          {label}
          {field.description && (
            <span id={hintId} className="block text-xs text-gray-600 dark:text-gray-400">
              {field.description}
            </span>
          )}
        </label>
      </div>
    );
  }

  if (field.type === 'array') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset aria-describedby={describedBy}>
        <legend className="text-sm font-medium">
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </legend>
        <div className="mt-1 flex flex-col gap-1">
          {(field.items?.oneOf || []).map(choice => (
            <label key={choice.const} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(choice.const)}
                disabled={disabled}
                onChange={e =>
                  onChange(
                    e.target.checked
                      ? [...chosen, choice.const]
                      : chosen.filter(v => v !== choice.const)
                  )
                }
                className="h-4 w-4 rounded-sm border-gray-300 text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500"
              />
              {choice.title || choice.const}
            </label>
          ))}
        </div>
        <FieldHint id={hintId} description={field.description} problem={problem} />
      </fieldset>
    );
  }

  let control;
  if (field.type === 'string' && Array.isArray(field.oneOf)) {
    control = (
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={problem ? true : undefined}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLASS}
      >
        <option value="">{t('mcpElicitation.choose', 'Choose…')}</option>
        {field.oneOf.map(choice => (
          <option key={choice.const} value={choice.const}>
            {choice.title || choice.const}
          </option>
        ))}
      </select>
    );
  } else {
    const isNumber = field.type === 'number' || field.type === 'integer';
    control = (
      <input
        id={id}
        type={isNumber ? 'number' : STRING_INPUT_TYPES[field.format] || 'text'}
        value={value ?? ''}
        disabled={disabled}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={problem ? true : undefined}
        {...(isNumber
          ? {
              step: field.type === 'integer' ? 1 : 'any',
              ...(field.minimum !== undefined ? { min: field.minimum } : {}),
              ...(field.maximum !== undefined ? { max: field.maximum } : {})
            }
          : field.maxLength !== undefined
            ? { maxLength: field.maxLength }
            : {})}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    );
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {control}
      <FieldHint id={hintId} description={field.description} problem={problem} />
    </div>
  );
}

function FieldHint({ id, description, problem }) {
  if (!description && !problem) return null;
  return (
    <p id={id} className="mt-1 text-xs text-gray-600 dark:text-gray-400">
      {problem && (
        <span className="block font-medium text-red-700 dark:text-red-400">{problem}</span>
      )}
      {description}
    </p>
  );
}

/**
 * A question an MCP server asked in the middle of a tool call (MCP
 * elicitation). The tool call waits for the answer while the turn runs on:
 * Submit sends the form to the server, Decline tells it no. The answer goes
 * to the interaction's own endpoint, not into the conversation.
 *
 * @param {Object} props
 * @param {Object} props.interaction - The pending `question` interaction
 * @param {string} props.runId - The run it was raised on
 */
export default function McpElicitationCard({ interaction, runId }) {
  const { t } = useTranslation();
  const titleId = useId();
  const schema = useMemo(
    () => interaction?.prompt?.inputSchema || { properties: {} },
    [interaction]
  );
  const [values, setValues] = useState(() => initialValues(schema));
  const [submitting, setSubmitting] = useState(false);
  const [answered, setAnswered] = useState(null);
  const [error, setError] = useState(null);
  const [showProblems, setShowProblems] = useState(false);
  const { data, missing, invalid } = useMemo(() => formAnswer(schema, values), [schema, values]);
  const required = new Set(schema.required || []);
  const serverName =
    interaction?.source?.mcpElicitation?.serverName || interaction?.prompt?.title || '';

  if (!interaction || answered) {
    return answered ? (
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400" role="status">
        {answered === 'accept'
          ? t('mcpElicitation.sent', 'Answer sent to {{server}}.', { server: serverName })
          : t('mcpElicitation.declined', 'You declined. {{server}} was told no.', {
              server: serverName
            })}
      </p>
    ) : null;
  }

  const send = async accept => {
    if (accept && (missing.length || invalid.length)) {
      setShowProblems(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await answerInteraction(
        runId,
        interaction.id,
        accept ? { value: 'accept', data } : { skipped: true },
        { channel: 'chat' }
      );
      setAnswered(accept ? 'accept' : 'decline');
    } catch (err) {
      setError(err?.message || t('mcpElicitation.failed', 'The answer could not be sent.'));
    } finally {
      setSubmitting(false);
    }
  };

  const problemOf = name => {
    if (!showProblems) return null;
    if (missing.includes(name)) return t('mcpElicitation.required', 'Required');
    if (invalid.includes(name)) return t('mcpElicitation.invalid', 'Check this value');
    return null;
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="mcp-elicitation"
      className="mt-2 w-full max-w-2xl rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-gray-800 p-4 text-sm text-gray-900 dark:text-gray-100"
    >
      <h3 id={titleId} className="flex items-center gap-2 font-semibold">
        <Icon name="question-mark-circle" size="sm" className="text-blue-700 dark:text-blue-300" />
        {serverName
          ? t('mcpElicitation.title', '{{server}} asks', { server: serverName })
          : t('mcpElicitation.titleUnknown', 'A connected system asks')}
      </h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">
        {interaction.prompt?.message}
      </p>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        {t(
          'mcpElicitation.notice',
          'Your answer goes to {{server}}, not into the conversation. The request waits until you answer.',
          { server: serverName || t('mcpElicitation.theServer', 'the server') }
        )}
      </p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={e => {
          e.preventDefault();
          void send(true);
        }}
        noValidate
      >
        {Object.entries(schema.properties || {}).map(([name, field]) => (
          <Field
            key={name}
            name={name}
            field={field}
            value={values[name]}
            disabled={submitting}
            required={required.has(name)}
            problem={problemOf(name)}
            onChange={value => setValues(prev => ({ ...prev, [name]: value }))}
          />
        ))}
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800"
          >
            {t('mcpElicitation.submit', 'Submit')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void send(false)}
            className="inline-flex items-center rounded-md border border-blue-700 dark:border-blue-400 px-3 py-1.5 text-sm font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800"
          >
            {t('mcpElicitation.decline', 'Decline')}
          </button>
        </div>
      </form>
    </section>
  );
}
