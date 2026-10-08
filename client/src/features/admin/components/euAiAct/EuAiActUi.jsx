/**
 * Small presentational building blocks for the EU AI Act admin tabs.
 *
 * They follow the admin UI conventions (white/gray-800 cards, indigo
 * primary, Tailwind dark-mode classes, the switch from AdminFeaturesPage)
 * and hold no user-facing text of their own: every label comes in as a prop,
 * already translated by the calling tab.
 *
 * Accessibility (WCAG 2.1 AA):
 * - every input has a `<label>` (or `aria-labelledby`) and its hint/error is
 *   linked with `aria-describedby`;
 * - status is conveyed by text and icon, never by colour alone;
 * - switches use `role="switch"` + `aria-checked`.
 *
 * @module features/admin/components/euAiAct/EuAiActUi
 */
import { useId, useState } from 'react';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  MinusCircleIcon
} from '@heroicons/react/24/outline';
import { copyText } from './fileHelpers';

/** Shared class names for data tables, matching the admin list pages. */
export const TABLE = Object.freeze({
  wrapper:
    'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-x-auto',
  table: 'min-w-full divide-y divide-gray-200 dark:divide-gray-700',
  thead: 'bg-gray-50 dark:bg-gray-900',
  th: 'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400',
  thRight:
    'px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400',
  tbody: 'bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700',
  tr: 'hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors align-top',
  td: 'px-4 py-3 text-sm text-gray-700 dark:text-gray-300',
  tdRight: 'px-4 py-3 text-sm text-right whitespace-nowrap',
  tdMono: 'px-4 py-3 text-xs font-mono text-gray-700 dark:text-gray-300 break-all',
  empty: 'px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400'
});

const INPUT_CLASS =
  'block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm disabled:opacity-60 disabled:cursor-not-allowed';
const INPUT_ERROR_CLASS = 'border-red-500 dark:border-red-500 focus:ring-red-500';

/** Tone → classes + icon for notices and pills. */
const TONES = {
  info: {
    box: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800',
    title: 'text-blue-800 dark:text-blue-200',
    text: 'text-blue-700 dark:text-blue-300',
    icon: 'text-blue-500 dark:text-blue-400',
    pill: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    Icon: InformationCircleIcon
  },
  success: {
    box: 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800',
    title: 'text-green-800 dark:text-green-200',
    text: 'text-green-700 dark:text-green-300',
    icon: 'text-green-500 dark:text-green-400',
    pill: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    Icon: CheckCircleIcon
  },
  warning: {
    box: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800',
    title: 'text-amber-800 dark:text-amber-200',
    text: 'text-amber-700 dark:text-amber-300',
    icon: 'text-amber-500 dark:text-amber-400',
    pill: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    Icon: ExclamationTriangleIcon
  },
  error: {
    box: 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800',
    title: 'text-red-800 dark:text-red-200',
    text: 'text-red-700 dark:text-red-300',
    icon: 'text-red-500 dark:text-red-400',
    pill: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    Icon: XCircleIcon
  },
  neutral: {
    box: 'bg-gray-50 dark:bg-gray-900/40 border-gray-200 dark:border-gray-700',
    title: 'text-gray-800 dark:text-gray-200',
    text: 'text-gray-700 dark:text-gray-300',
    icon: 'text-gray-500 dark:text-gray-400',
    pill: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    Icon: MinusCircleIcon
  }
};

/**
 * A titled card that groups related controls.
 *
 * @param {Object} props
 * @param {string} [props.id] - DOM id (used as scroll target)
 * @param {string} props.title - Visible heading
 * @param {React.ReactNode} [props.description] - Intro text under the heading
 * @param {React.ReactNode} [props.actions] - Buttons shown next to the heading
 * @param {2|3|4} [props.headingLevel=2] - Heading level; 2 fits under the page h1
 * @param {React.ReactNode} props.children
 */
export function SectionCard({ id, title, description, actions, headingLevel = 2, children }) {
  const autoId = useId();
  const headingId = `${id || autoId}-heading`;
  const Heading = `h${headingLevel}`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      // Focus target for in-page navigation (not in the tab order).
      tabIndex={id ? -1 : undefined}
      className="scroll-mt-4 focus:outline-hidden bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700"
    >
      <div className="px-6 pt-5 pb-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Heading
            id={headingId}
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {title}
          </Heading>
          {description && (
            <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="px-6 py-5 space-y-5">{children}</div>
    </section>
  );
}

/**
 * Coloured notice box with an icon; the tone is also conveyed by the title
 * text, so colour is never the only signal.
 *
 * @param {Object} props
 * @param {'info'|'success'|'warning'|'error'|'neutral'} [props.tone='info']
 * @param {string} [props.title]
 * @param {'status'|'alert'} [props.role] - Set for messages that appear after an action
 * @param {React.ReactNode} [props.children]
 * @param {string} [props.className]
 */
export function Notice({ tone = 'info', title, role, children, className = '' }) {
  const style = TONES[tone] || TONES.info;
  const ToneIcon = style.Icon;
  return (
    <div role={role} className={`border rounded-md p-4 ${style.box} ${className}`}>
      <div className="flex gap-3">
        <ToneIcon className={`h-5 w-5 shrink-0 mt-0.5 ${style.icon}`} aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm">
          {title && <p className={`font-medium ${style.title}`}>{title}</p>}
          {children && (
            <div className={`${title ? 'mt-1' : ''} ${style.text} space-y-1`}>{children}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline status chip: icon + text.
 *
 * @param {Object} props
 * @param {'info'|'success'|'warning'|'error'|'neutral'} [props.tone='neutral']
 * @param {React.ReactNode} props.children - The status text
 * @param {string} [props.title] - Optional tooltip
 */
export function StatusPill({ tone = 'neutral', children, title }) {
  const style = TONES[tone] || TONES.neutral;
  const ToneIcon = style.Icon;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${style.pill}`}
    >
      <ToneIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Yes / no / unknown value with icon and text (e.g. "found", "valid").
 *
 * @param {Object} props
 * @param {boolean|null|undefined} props.value
 * @param {string} props.yes - Text for `true`
 * @param {string} props.no - Text for `false`
 * @param {string} [props.unknown='—'] - Text for `null`/`undefined`
 * @param {boolean} [props.noIsBad=false] - Show `false` as an error instead of neutral
 */
export function YesNo({ value, yes, no, unknown = '—', noIsBad = false }) {
  if (value === true) return <StatusPill tone="success">{yes}</StatusPill>;
  if (value === false) return <StatusPill tone={noIsBad ? 'error' : 'neutral'}>{no}</StatusPill>;
  return <span className="text-gray-500 dark:text-gray-400">{unknown}</span>;
}

/**
 * Button in one of the admin styles.
 *
 * @param {Object} props
 * @param {'primary'|'secondary'|'danger'|'link'} [props.variant='secondary']
 * @param {'sm'|'md'} [props.size='md']
 * @param {boolean} [props.busy=false] - Shows a spinner and disables the button
 * @param {React.ComponentType} [props.icon] - Heroicon component shown before the label
 * @param {React.ReactNode} props.children
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  icon: ButtonIcon,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}) {
  const sizes = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-4 py-2 text-sm'
  };
  const variants = {
    primary:
      'bg-indigo-600 hover:bg-indigo-700 text-white border border-transparent focus:ring-indigo-500',
    secondary:
      'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 focus:ring-indigo-500',
    danger: 'bg-red-600 hover:bg-red-700 text-white border border-transparent focus:ring-red-500',
    link: 'text-indigo-600 dark:text-indigo-400 hover:underline border border-transparent focus:ring-indigo-500 !px-1'
  };
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium shadow-xs transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed ${sizes[size] || sizes.md} ${variants[variant] || variants.secondary} ${className}`}
      {...rest}
    >
      {busy ? (
        <Spinner size="sm" />
      ) : (
        ButtonIcon && <ButtonIcon className="h-4 w-4" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

/**
 * Decorative spinner. Pair it with visible text or an `aria-live` region.
 *
 * @param {Object} props
 * @param {'sm'|'md'} [props.size='md']
 */
export function Spinner({ size = 'md' }) {
  const dims = size === 'sm' ? 'h-4 w-4 border-2' : 'h-6 w-6 border-2';
  return (
    <span
      aria-hidden="true"
      className={`inline-block ${dims} rounded-full border-indigo-200 border-t-indigo-600 dark:border-gray-600 dark:border-t-indigo-400 animate-spin`}
    />
  );
}

/**
 * Loading line with a spinner and a polite live region.
 *
 * @param {Object} props
 * @param {string} props.label - e.g. "Loading settings…"
 */
export function LoadingRow({ label }) {
  return (
    <div
      className="flex items-center gap-3 py-8 text-sm text-gray-600 dark:text-gray-400"
      role="status"
      aria-live="polite"
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** Label + hint + error scaffold shared by the input fields. */
function FieldShell({ id, label, hint, error, children, labelSuffix }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {labelSuffix}
      </label>
      <div className="mt-1">{children}</div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          className="mt-1 text-xs text-red-600 dark:text-red-400 flex items-center gap-1"
        >
          <XCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id, hint, error) {
  return (
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined
  );
}

/**
 * Labelled text input or textarea.
 *
 * @param {Object} props
 * @param {string} props.id - Unique DOM id (also used to focus the field on errors)
 * @param {string} props.label
 * @param {React.ReactNode} [props.hint]
 * @param {string} [props.error] - Validation message; marks the field invalid
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {boolean} [props.multiline=false] - Render a `<textarea>`
 * @param {number} [props.rows=3]
 * @param {boolean} [props.mono=false] - Monospace font (PEM, JSON)
 * @param {React.ReactNode} [props.labelSuffix] - e.g. "(optional)"
 */
export function TextField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  multiline = false,
  rows = 3,
  mono = false,
  labelSuffix,
  type = 'text',
  ...inputProps
}) {
  const className = `${INPUT_CLASS} ${error ? INPUT_ERROR_CLASS : ''} ${mono ? 'font-mono text-xs' : ''}`;
  const common = {
    id,
    value: value ?? '',
    onChange: e => onChange(e.target.value),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, hint, error),
    className,
    ...inputProps
  };
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} labelSuffix={labelSuffix}>
      {multiline ? (
        <textarea rows={rows} spellCheck={mono ? false : undefined} {...common} />
      ) : (
        <input type={type} {...common} />
      )}
    </FieldShell>
  );
}

/**
 * Labelled number input. Emits a number, or `''` while the field is empty,
 * so validation can tell "empty" from "0".
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} props.label
 * @param {React.ReactNode} [props.hint]
 * @param {string} [props.error]
 * @param {number|''|null} [props.value] - unset until the settings load
 * @param {(value: number|'') => void} props.onChange
 * @param {number} [props.min]
 * @param {number} [props.max]
 * @param {number|string} [props.step]
 */
export function NumberField({ id, label, hint, error, value, onChange, ...inputProps }) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={value === '' || value === null || value === undefined ? '' : value}
        onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={`${INPUT_CLASS} max-w-xs ${error ? INPUT_ERROR_CLASS : ''}`}
        {...inputProps}
      />
    </FieldShell>
  );
}

/**
 * Labelled `<select>`.
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} props.label
 * @param {React.ReactNode} [props.hint]
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {Array<{ value: string, label: string }>} props.options
 * @param {React.ReactNode} [props.after] - Content under the select (e.g. a warning)
 */
export function SelectField({ id, label, hint, value, onChange, options, after }) {
  const afterId = after ? `${id}-after` : null;
  return (
    <div>
      <FieldShell id={id} label={label} hint={hint}>
        <select
          id={id}
          value={value}
          onChange={e => onChange(e.target.value)}
          aria-describedby={[describedBy(id, hint), afterId].filter(Boolean).join(' ') || undefined}
          className={`${INPUT_CLASS} max-w-md`}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FieldShell>
      {after && (
        <div id={afterId} className="mt-2">
          {after}
        </div>
      )}
    </div>
  );
}

/**
 * Labelled checkbox with an optional hint.
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {React.ReactNode} props.label
 * @param {React.ReactNode} [props.hint]
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange
 */
export function CheckboxField({ id, label, hint, checked, onChange, ...rest }) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={Boolean(checked)}
        onChange={e => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 h-4 w-4 rounded-sm border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
        {...rest}
      />
      <div className="text-sm">
        <label htmlFor={id} className="font-medium text-gray-900 dark:text-gray-100">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-gray-500 dark:text-gray-400 mt-0.5">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * On/off switch row (same visual as the Features page), with an optional
 * conformance badge and a warning that is shown while the value is in its
 * non-conforming state.
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} props.label
 * @param {React.ReactNode} [props.description]
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.badge] - e.g. "Required for conformance"
 * @param {React.ReactNode} [props.warning] - Rendered (and announced) when set
 * @param {string} [props.onLabel] - Visible state text when on
 * @param {string} [props.offLabel] - Visible state text when off
 */
export function SwitchField({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  badge,
  warning,
  onLabel,
  offLabel
}) {
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : null;
  const warnId = warning ? `${id}-warning` : null;
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span id={labelId} className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {label}
            </span>
            {badge && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
                {badge}
              </span>
            )}
          </div>
          {description && (
            <p id={descId} className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(onLabel || offLabel) && (
            <span className="text-xs text-gray-600 dark:text-gray-400" aria-hidden="true">
              {checked ? onLabel : offLabel}
            </span>
          )}
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={Boolean(checked)}
            aria-labelledby={labelId}
            aria-describedby={[descId, warnId].filter(Boolean).join(' ') || undefined}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed ${
              checked ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                checked ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
      {warning && (
        <p
          id={warnId}
          className="mt-2 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300"
        >
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Radio group rendered as selectable cards, each with a short explanation.
 *
 * @param {Object} props
 * @param {string} props.name - Radio group name (unique on the page)
 * @param {string} props.legend - Group label
 * @param {React.ReactNode} [props.hint]
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {Array<{ value: string, label: string, description?: React.ReactNode }>} props.options
 */
export function RadioCardGroup({ name, legend, hint, value, onChange, options }) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <fieldset aria-describedby={hintId}>
      <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">{legend}</legend>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      )}
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {options.map(option => {
          const optionId = `${name}-${option.value}`;
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              htmlFor={optionId}
              className={`flex gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                selected
                  ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 dark:border-indigo-400'
                  : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              <input
                id={optionId}
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                aria-describedby={option.description ? `${optionId}-desc` : undefined}
                className="mt-0.5 h-4 w-4 border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm">
                <span className="block font-medium text-gray-900 dark:text-gray-100">
                  {option.label}
                </span>
                {option.description && (
                  <span
                    id={`${optionId}-desc`}
                    className="block mt-0.5 text-gray-500 dark:text-gray-400"
                  >
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Read-only definition list (label → value) for status cards.
 *
 * @param {Object} props
 * @param {Array<{ label: string, value: React.ReactNode, mono?: boolean }>} props.items
 */
export function DefinitionList({ items }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(item => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {item.label}
          </dt>
          <dd
            className={`mt-0.5 text-sm text-gray-900 dark:text-gray-100 ${
              item.mono ? 'font-mono text-xs break-all' : 'break-words'
            }`}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Preformatted code/PEM block with a copy button and a polite confirmation.
 *
 * @param {Object} props
 * @param {string} props.code - Text to show and copy
 * @param {string} props.label - Accessible name of the block (e.g. "vLLM command line")
 * @param {string} props.copyLabel - Button text, e.g. "Copy"
 * @param {string} props.copiedLabel - Announced after copying, e.g. "Copied"
 * @param {string} props.copyFailedLabel - Announced when copying failed
 * @param {React.ReactNode} [props.extraActions] - Further buttons (e.g. download)
 */
export function CodeBlock({ code, label, copyLabel, copiedLabel, copyFailedLabel, extraActions }) {
  const [copyState, setCopyState] = useState('idle');
  const handleCopy = async () => {
    try {
      await copyText(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 3000);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" aria-live="polite" className="text-xs">
            {copyState === 'copied' && (
              <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-300">
                <CheckIcon className="h-4 w-4" aria-hidden="true" />
                {copiedLabel}
              </span>
            )}
            {copyState === 'failed' && (
              <span className="text-red-600 dark:text-red-400">{copyFailedLabel}</span>
            )}
          </span>
          <Button size="sm" icon={ClipboardDocumentIcon} onClick={handleCopy}>
            {copyLabel}
          </Button>
          {extraActions}
        </div>
      </div>
      {/* A scrollable region must be keyboard reachable (WCAG 2.1.1). */}
      <pre
        role="region"
        aria-label={label}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="max-h-72 overflow-auto rounded-md bg-gray-900 text-gray-100 dark:bg-black/60 p-3 text-xs font-mono whitespace-pre-wrap break-all focus:outline-hidden focus:ring-2 focus:ring-indigo-500"
      >
        {code}
      </pre>
    </div>
  );
}
