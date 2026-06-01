import { useEffect } from 'react';
import Icon from '../../../shared/components/Icon';

/**
 * Validation error summary banner for admin forms.
 *
 * Lists all current validation errors at the top of a form with click-to-focus
 * links that scroll the corresponding field into view. Pass `errors` as either:
 *  - An object: `{ fieldId: 'error message' }`
 *  - An array of `{ field?, fieldId?, message, label? }`
 *
 * Field IDs can be dot-paths (e.g. `description.en`). The component walks the
 * path until it finds a matching element by `id`, `name`, or `data-field`, so
 * a parent wrapper with `data-field="description"` will still match
 * `description.en` if the leaf input isn't tagged.
 *
 * The banner auto-hides when there are no errors.
 *
 * @param {Object} props
 * @param {Object<string,string>|Array<{field?: string, fieldId?: string, message: string, label?: string}>} [props.errors]
 * @param {string} [props.title='Please fix the following errors']
 * @param {Object<string,string>} [props.labels] Optional `{ fieldId: 'Human label' }` map
 *   used when `errors` is an object; falls back to the fieldId when missing.
 */
const PERSISTENT_CLASSES = ['admin-form-error-field'];

function AdminFormErrorSummary({ errors, title = 'Please fix the following errors', labels = {} }) {
  const entries = normalizeErrors(errors);
  const fieldIdsKey = entries
    .map(e => e.fieldId)
    .filter(Boolean)
    .join('|');

  // Persistent highlight: mark every errored field so users can see them at a
  // glance, not just after clicking the banner. Re-applies whenever errors change.
  useEffect(() => {
    const fieldIds = fieldIdsKey ? fieldIdsKey.split('|') : [];
    const marked = [];
    fieldIds.forEach(fieldId => {
      const el = findFieldElement(fieldId);
      if (!el) return;
      const focusable = el.matches?.('input, textarea, select')
        ? el
        : el.querySelector?.('input, textarea, select');
      const target = focusable || el;
      PERSISTENT_CLASSES.forEach(c => target.classList.add(c));
      marked.push(target);
    });
    return () => {
      marked.forEach(el => {
        PERSISTENT_CLASSES.forEach(c => el.classList.remove(c));
      });
    };
  }, [fieldIdsKey]);

  if (entries.length === 0) return null;

  const focusField = fieldId => {
    if (!fieldId) return;
    const el = findFieldElement(fieldId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Find a focusable descendant (or the element itself).
    const focusable = el.matches?.('input, textarea, select, button, [tabindex]')
      ? el
      : el.querySelector?.('input, textarea, select, button, [tabindex]');
    if (focusable && typeof focusable.focus === 'function') {
      setTimeout(() => focusable.focus({ preventScroll: true }), 250);
    }
    // Brief red-ring flash so the user sees what was targeted.
    flashHighlight(focusable || el);
  };

  return (
    <div
      className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <Icon
          name="warning"
          className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
            {title}
            <span className="ml-1 font-normal">
              ({entries.length} {entries.length === 1 ? 'error' : 'errors'})
            </span>
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-300 list-disc list-inside">
            {entries.map((e, i) => {
              const label = e.label ?? buildLabel(e.fieldId, labels);
              return (
                <li key={`${e.fieldId ?? 'err'}-${i}`}>
                  {e.fieldId ? (
                    <button
                      type="button"
                      onClick={() => focusField(e.fieldId)}
                      className="underline hover:text-red-900 dark:hover:text-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
                    >
                      {label}
                    </button>
                  ) : (
                    <span className="font-medium">{label}</span>
                  )}
                  {label ? ': ' : ''}
                  <span>{e.message}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Walk dot-path looking for a matching element. For `description.en` tries:
 *   1. id="description.en", [name="description.en"], [data-field="description.en"]
 *   2. id="description",    [name="description"],    [data-field="description"]
 */
function findFieldElement(fieldId) {
  const parts = String(fieldId).split('.');
  while (parts.length > 0) {
    const candidate = parts.join('.');
    const el =
      document.getElementById(candidate) ||
      // Escape dots for querySelector — IDs with dots need it.
      safeQuery(`[name="${cssEscape(candidate)}"]`) ||
      safeQuery(`[data-field="${cssEscape(candidate)}"]`);
    if (el) return el;
    parts.pop();
  }
  return null;
}

function safeQuery(selector) {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/(["'\\.])/g, '\\$1');
}

const FLASH_CLASSES = [
  'ring-2',
  'ring-red-500',
  'ring-offset-2',
  'ring-offset-white',
  'dark:ring-offset-gray-900',
  'rounded-md',
  'transition-shadow',
  'duration-300'
];

function flashHighlight(el) {
  if (!el || !el.classList) return;
  FLASH_CLASSES.forEach(c => el.classList.add(c));
  setTimeout(() => {
    FLASH_CLASSES.forEach(c => el.classList.remove(c));
  }, 1800);
}

/**
 * Build a human label from a dot-path field id using the provided labels map.
 * `description.en` → "Description (en)" when `labels.description` is "Description".
 * `description.en` → "description.en" when no parent label exists.
 */
function buildLabel(fieldId, labels) {
  if (!fieldId) return '';
  if (labels[fieldId]) return labels[fieldId];
  const dot = fieldId.indexOf('.');
  if (dot === -1) return humanize(fieldId);
  const head = fieldId.slice(0, dot);
  const tail = fieldId.slice(dot + 1);
  const headLabel = labels[head] || humanize(head);
  return `${headLabel} (${tail})`;
}

function humanize(name) {
  // camelCase / snake_case → "Camel Case" / "Snake Case"
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

function normalizeErrors(errors) {
  if (!errors) return [];
  if (Array.isArray(errors)) {
    return errors
      .filter(e => e && e.message)
      .map(e => ({ fieldId: e.fieldId ?? e.field, message: e.message, label: e.label }));
  }
  if (typeof errors === 'object') {
    return Object.entries(errors)
      .filter(([, message]) => Boolean(message))
      .map(([fieldId, message]) => ({ fieldId, message: String(message) }));
  }
  return [];
}

export default AdminFormErrorSummary;
