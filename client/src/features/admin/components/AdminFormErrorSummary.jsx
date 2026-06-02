import { useEffect, useRef } from 'react';
import Icon from '../../../shared/components/Icon';

/**
 * Validation error summary banner for admin forms.
 *
 * Renders a red banner at the top of a form listing every validation error.
 * Each entry is a click-to-focus link. Errored inputs also get a persistent
 * red border via the `.admin-form-error-field` CSS class — applied
 * declaratively by `DynamicLanguageEditor` for localized fields (through
 * `FormValidationProvider` context) and imperatively for plain inputs
 * (id / name / data-field attribute lookup).
 *
 * Field IDs can be dot-paths (e.g. `description.en`). The component walks the
 * path until it finds a matching element. DOM queries are scoped to the
 * surrounding form when possible (closest `<form>` to the banner).
 *
 * @param {Object} props
 * @param {Object<string,string>|Array<{field?: string, fieldId?: string, message: string, label?: string}>} [props.errors]
 * @param {string} [props.title='Please fix the following errors']
 * @param {Object<string,string>} [props.labels] Optional `{ fieldId: 'Human label' }` map
 * @param {Object<string,string>} [props.languageDisplayNames] Optional override of language code → name
 */
function AdminFormErrorSummary({
  errors,
  title = 'Please fix the following errors',
  labels = {},
  languageDisplayNames = DEFAULT_LANGUAGE_NAMES
}) {
  const containerRef = useRef(null);
  const entries = normalizeErrors(errors);
  const fieldIdsKey = entries
    .map(e => e.fieldId)
    .filter(Boolean)
    .join('|');

  // Always render the live-region wrapper so screen readers pick up additions.
  // Persistent highlight + aria-invalid for plain inputs that don't go through
  // DynamicLanguageEditor (which handles its own per-language inputs).
  useEffect(() => {
    const fieldIds = fieldIdsKey ? fieldIdsKey.split('|') : [];
    const scope = containerRef.current?.closest('form') || document;
    const marked = [];
    fieldIds.forEach(fieldId => {
      const el = findFieldElement(fieldId, scope);
      if (!el) return;
      const focusable = el.matches?.('input, textarea, select')
        ? el
        : el.querySelector?.('input, textarea, select');
      const target = focusable || el;
      // Skip targets that already render the class declaratively (e.g. via
      // DynamicLanguageEditor) — recognised by the data-field attribute being
      // present. This avoids React stripping the class on the next render.
      if (target.classList.contains('admin-form-error-field')) {
        marked.push({ el: target, added: false });
        return;
      }
      target.classList.add('admin-form-error-field');
      target.setAttribute('aria-invalid', 'true');
      marked.push({ el: target, added: true });
    });
    return () => {
      marked.forEach(({ el, added }) => {
        if (added) {
          el.classList.remove('admin-form-error-field');
          if (el.getAttribute('aria-invalid') === 'true') el.removeAttribute('aria-invalid');
        }
      });
    };
  }, [fieldIdsKey]);

  const focusField = fieldId => {
    if (!fieldId) return;
    const scope = containerRef.current?.closest('form') || document;
    const el = findFieldElement(fieldId, scope);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = el.matches?.('input, textarea, select, button, [tabindex]')
      ? el
      : el.querySelector?.('input, textarea, select, button, [tabindex]');
    if (focusable && typeof focusable.focus === 'function') {
      setTimeout(() => focusable.focus({ preventScroll: true }), 250);
    }
    flashHighlight(focusable || el);
  };

  return (
    <div ref={containerRef} aria-live="polite" aria-atomic="false">
      {entries.length > 0 && (
        <div
          className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4"
          role="alert"
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
                {entries.map(e => {
                  const label = e.label ?? buildLabel(e.fieldId, labels, languageDisplayNames);
                  const key = e.fieldId ?? `m-${e.message}`;
                  return (
                    <li key={key}>
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
      )}
    </div>
  );
}

/**
 * Walk dot-path looking for a matching element. For `description.en` tries:
 *   1. id="description.en", [name="description.en"], [data-field="description.en"]
 *   2. id="description",    [name="description"],    [data-field="description"]
 */
function findFieldElement(fieldId, scope = document) {
  const parts = String(fieldId).split('.');
  while (parts.length > 0) {
    const candidate = parts.join('.');
    const el =
      document.getElementById(candidate) ||
      safeQuery(scope, `[name="${cssEscape(candidate)}"]`) ||
      safeQuery(scope, `[data-field="${cssEscape(candidate)}"]`);
    if (el && (scope === document || scope.contains(el))) return el;
    parts.pop();
  }
  return null;
}

function safeQuery(scope, selector) {
  try {
    return scope.querySelector(selector);
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
  'ring-indigo-500',
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
  }, 1500);
}

const DEFAULT_LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pt: 'Portuguese',
  pl: 'Polish',
  cs: 'Czech',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  ru: 'Russian',
  ar: 'Arabic',
  tr: 'Turkish',
  uk: 'Ukrainian'
};

/**
 * `description.en` → "Description — English" when `labels.description` is "Description".
 */
function buildLabel(fieldId, labels, languageDisplayNames) {
  if (!fieldId) return '';
  if (labels[fieldId]) return labels[fieldId];
  const dot = fieldId.indexOf('.');
  if (dot === -1) return humanize(fieldId);
  const head = fieldId.slice(0, dot);
  const tail = fieldId.slice(dot + 1);
  const headLabel = labels[head] || humanize(head);
  const tailLabel = languageDisplayNames[tail] || tail;
  return `${headLabel} — ${tailLabel}`;
}

function humanize(name) {
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
