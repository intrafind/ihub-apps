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

const pad = number => String(number).padStart(2, '0');

/**
 * An RFC 3339 date-time as the value of a `datetime-local` input (local time,
 * to the minute), or '' when it is not one.
 */
export function toLocalDateTimeInput(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** The starting values of the form: the defaults the server sent. */
export function initialValues(schema) {
  const values = {};
  for (const [name, field] of Object.entries(schema?.properties || {})) {
    if (field.default !== undefined && field.format === 'date-time') {
      values[name] = toLocalDateTimeInput(field.default);
    } else if (field.default !== undefined) values[name] = field.default;
    else if (field.type === 'boolean') values[name] = false;
    else if (field.type === 'array') values[name] = [];
  }
  return values;
}

function isEmpty(value) {
  return (
    value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
  );
}

function outOfRange(number, field) {
  return (
    (field.minimum !== undefined && number < field.minimum) ||
    (field.maximum !== undefined && number > field.maximum)
  );
}

function outOfLength(text, field) {
  return (
    (field.minLength !== undefined && text.length < field.minLength) ||
    (field.maxLength !== undefined && text.length > field.maxLength)
  );
}

/** A filled-in value as its schema type, or `undefined` when it does not fit. */
function typedValue(field, value) {
  if (field.type === 'number' || field.type === 'integer') {
    const number = Number(value);
    if (!Number.isFinite(number) || outOfRange(number, field)) return undefined;
    if (field.type === 'integer' && !Number.isInteger(number)) return undefined;
    return number;
  }
  if (field.type === 'boolean') return value === true;
  if (field.type === 'array') return value;
  if (field.format === 'date-time') {
    // A `datetime-local` value has no offset: send the person's local time
    // as RFC 3339 (UTC), as the schema's `date-time` asks.
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = String(value);
  return outOfLength(text, field) ? undefined : text;
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
    if (field.type === 'boolean') {
      // An unticked box is an answer: false.
      data[name] = value === true;
    } else if (isEmpty(value)) {
      if (required.has(name)) missing.push(name);
    } else {
      const typed = typedValue(field, value);
      if (typed === undefined) invalid.push(name);
      else data[name] = typed;
    }
  }
  return { data, missing, invalid };
}

const CHECKBOX_CLASS =
  'h-4 w-4 rounded-sm border-gray-300 text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500';

function BooleanField({ id, hintId, label, field, value, onChange, disabled, describedBy }) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={e => onChange(e.target.checked)}
        className={`mt-0.5 ${CHECKBOX_CLASS}`}
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

function MultipleChoiceField({
  hintId,
  label,
  field,
  value,
  onChange,
  disabled,
  required,
  problem,
  describedBy
}) {
  const chosen = Array.isArray(value) ? value : [];
  const toggle = (choice, checked) =>
    onChange(checked ? [...chosen, choice] : chosen.filter(v => v !== choice));
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
              onChange={e => toggle(choice.const, e.target.checked)}
              className={CHECKBOX_CLASS}
            />
            {choice.title || choice.const}
          </label>
        ))}
      </div>
      <FieldHint id={hintId} description={field.description} problem={problem} />
    </fieldset>
  );
}

/** The input attributes that bound a value: step, min, max, or maxLength. */
function inputLimits(field, isNumber) {
  if (!isNumber) return field.maxLength === undefined ? {} : { maxLength: field.maxLength };
  return {
    step: field.type === 'integer' ? 1 : 'any',
    ...(field.minimum === undefined ? {} : { min: field.minimum }),
    ...(field.maximum === undefined ? {} : { max: field.maximum })
  };
}

function SingleValueControl({
  id,
  field,
  value,
  onChange,
  disabled,
  required,
  problem,
  describedBy
}) {
  const { t } = useTranslation();
  const common = {
    id,
    value: value ?? '',
    disabled,
    required,
    'aria-describedby': describedBy,
    'aria-invalid': problem ? true : undefined,
    onChange: e => onChange(e.target.value),
    className: INPUT_CLASS
  };
  if (field.type === 'string' && Array.isArray(field.oneOf)) {
    return (
      <select {...common}>
        <option value="">{t('mcpElicitation.choose', 'Choose…')}</option>
        {field.oneOf.map(choice => (
          <option key={choice.const} value={choice.const}>
            {choice.title || choice.const}
          </option>
        ))}
      </select>
    );
  }
  const isNumber = field.type === 'number' || field.type === 'integer';
  const type = isNumber ? 'number' : STRING_INPUT_TYPES[field.format] || 'text';
  return <input type={type} {...common} {...inputLimits(field, isNumber)} />;
}

/** One form field, as its schema type asks. */
function Field({ name, field, ...rest }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const props = {
    ...rest,
    id,
    hintId,
    field,
    label: field.title || name,
    describedBy: field.description || rest.problem ? hintId : undefined
  };
  if (field.type === 'boolean') return <BooleanField {...props} />;
  if (field.type === 'array') return <MultipleChoiceField {...props} />;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {props.label}
        {props.required && <span aria-hidden="true"> *</span>}
      </label>
      <SingleValueControl {...props} />
      <FieldHint id={hintId} description={field.description} problem={props.problem} />
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

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800';
const SECONDARY_BUTTON_CLASS =
  'inline-flex items-center rounded-md border border-blue-700 dark:border-blue-400 px-3 py-1.5 text-sm font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-gray-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-800';

/**
 * The page of a URL-mode question, when the card may link to it: an `https`
 * address without credentials (the server checks the same).
 *
 * @param {string} [url]
 * @returns {{href: string, host: string}|null}
 */
export function pageOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return { href: parsed.href, host: parsed.host };
  } catch {
    return null;
  }
}

/**
 * A URL-mode question: the server sends the person to a page of its own (a
 * sign-in, a payment). The card shows where the link goes; the person opens
 * it in a new tab, finishes there and comes back to answer Done.
 */
function PageQuestion({ page, submitting, onDone, onDecline }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  if (!page) {
    return (
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-xs text-gray-600 dark:text-gray-400">
          {t('mcpElicitation.pageUnsafe', 'iHub does not open this address.')}
        </p>
        <div>
          <button
            type="button"
            disabled={submitting}
            onClick={onDecline}
            className={SECONDARY_BUTTON_CLASS}
          >
            {t('mcpElicitation.decline', 'Decline')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-3">
        <p className="font-medium">
          {t('mcpElicitation.pageHost', 'Opens {{host}}', { host: page.host })}
        </p>
        <p className="mt-1 break-all font-mono text-xs text-gray-700 dark:text-gray-300">
          {page.href}
        </p>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {opened
          ? t(
              'mcpElicitation.pageOpened',
              'Finish on {{host}}, then come back here and click Done.',
              { host: page.host }
            )
          : t(
              'mcpElicitation.pageNotice',
              'Check the address before you open it. iHub opens nothing by itself and sends nothing to the page.'
            )}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={page.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpened(true)}
          className={opened ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}
        >
          {opened
            ? t('mcpElicitation.pageOpenAgain', 'Open again')
            : t('mcpElicitation.pageOpen', 'Open {{host}}', { host: page.host })}
        </a>
        {opened && (
          <button
            type="button"
            disabled={submitting}
            onClick={onDone}
            className={PRIMARY_BUTTON_CLASS}
          >
            {t('mcpElicitation.pageDone', 'Done')}
          </button>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={onDecline}
          className={SECONDARY_BUTTON_CLASS}
        >
          {t('mcpElicitation.decline', 'Decline')}
        </button>
      </div>
    </div>
  );
}

/** The form of a form-mode question, with its Submit and Decline. */
function FormQuestion({
  schema,
  values,
  setValues,
  required,
  problemOf,
  submitting,
  serverName,
  onSubmit,
  onDecline
}) {
  const { t } = useTranslation();
  return (
    <>
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
          onSubmit();
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
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={submitting} className={PRIMARY_BUTTON_CLASS}>
            {t('mcpElicitation.submit', 'Submit')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onDecline}
            className={SECONDARY_BUTTON_CLASS}
          >
            {t('mcpElicitation.decline', 'Decline')}
          </button>
        </div>
      </form>
    </>
  );
}

/** What is sent for Submit / Done (accept) or Decline. */
function answerBody(accept, isPage, data) {
  if (!accept) return { skipped: true };
  return isPage ? { value: 'accept' } : { value: 'accept', data };
}

/** The line left in place of the card once it is answered. */
function answeredNotice(t, answered, isPage, serverName) {
  if (answered !== 'accept') {
    return t('mcpElicitation.declined', 'You declined. {{server}} was told no.', {
      server: serverName
    });
  }
  return isPage
    ? t('mcpElicitation.pageSent', '{{server}} was told you are done.', { server: serverName })
    : t('mcpElicitation.sent', 'Answer sent to {{server}}.', { server: serverName });
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
  const isPage = interaction?.source?.mcpElicitation?.mode === 'url';
  const page = isPage ? pageOf(interaction?.source?.mcpElicitation?.url) : null;

  if (!interaction || answered) {
    return answered ? (
      <output className="mt-2 block text-sm text-gray-600 dark:text-gray-400">
        {answeredNotice(t, answered, isPage, serverName)}
      </output>
    ) : null;
  }

  const send = async accept => {
    if (accept && !isPage && (missing.length || invalid.length)) {
      setShowProblems(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await answerInteraction(runId, interaction.id, answerBody(accept, isPage, data), {
        channel: 'chat'
      });
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
      {isPage ? (
        <PageQuestion
          page={page}
          submitting={submitting}
          onDone={() => void send(true)}
          onDecline={() => void send(false)}
        />
      ) : (
        <FormQuestion
          schema={schema}
          values={values}
          setValues={setValues}
          required={required}
          problemOf={problemOf}
          submitting={submitting}
          serverName={serverName}
          onSubmit={() => void send(true)}
          onDecline={() => void send(false)}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
