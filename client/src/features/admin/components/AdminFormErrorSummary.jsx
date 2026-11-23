// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { languageNamer } from '../../../shared/utils/languageName';

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
 * The entries follow the order of their fields in the form (document order of
 * the linked inputs), not the order of `errors`: a schema lists its rules in
 * its own order, which need not be the visual one. Entries whose field is not
 * on the page (a collapsed section, a message without a field) come last, in
 * the order given.
 *
 * Field IDs can be dot-paths (e.g. `description.en`). The component walks the
 * path until it finds a matching element. DOM queries are scoped to the
 * surrounding form when possible (closest `<form>` to the banner).
 *
 * @param {Object} props
 * @param {Object<string,string>|Array<{field?: string, fieldId?: string, message: string, label?: string}>} [props.errors]
 * @param {string} [props.title] The heading; by default "Please fix the following errors"
 * @param {Object<string,string>} [props.labels] Optional `{ fieldId: 'Human label' }` map
 * @param {Object<string,string>} [props.languageDisplayNames] Optional override of language
 *   code → name. Without it a language is named in the UI language (`Intl.DisplayNames`).
 * @param {number} [props.focusKey] When it changes to a value above 0, the banner takes the
 *   focus (after a failed save attempt), so keyboard and screen-reader users land on it.
 */
function AdminFormErrorSummary({ errors, title, labels = {}, languageDisplayNames, focusKey }) {
  const { t, i18n } = useTranslation();
  const uiLanguage = i18n?.language;
  const nameLanguage = useMemo(
    () => languageNamer(uiLanguage, languageDisplayNames),
    [uiLanguage, languageDisplayNames]
  );
  const containerRef = useRef(null);
  const bannerRef = useRef(null);
  const givenEntries = normalizeErrors(errors);
  const hasEntries = givenEntries.length > 0;
  // Field ids in the order of the form, measured once the fields are on the page.
  const [fieldOrder, setFieldOrder] = useState([]);
  const entries = sortByFieldOrder(givenEntries, fieldOrder);

  useEffect(() => {
    if (!focusKey || !hasEntries) return;
    bannerRef.current?.focus?.();
    bannerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    // Only a new save attempt moves the focus, not every change of the errors.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [focusKey]);
  const fieldIdsKey = givenEntries
    .map(e => e.fieldId)
    .filter(Boolean)
    .join('|');

  // Before paint, so the list never shows in the given order first.
  useLayoutEffect(() => {
    const fieldIds = fieldIdsKey ? fieldIdsKey.split('|') : [];
    const scope = containerRef.current?.closest('form') || document;
    const next = orderByDocument(fieldIds, scope);
    setFieldOrder(previous => (previous.join('|') === next.join('|') ? previous : next));
  }, [fieldIdsKey]);

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
          ref={bannerRef}
          tabIndex={-1}
          className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <Icon
              name="warning"
              className="w-5 h-5 text-red-700 dark:text-red-400 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
                {title ?? t('admin.formErrors.title')}
                <span className="ml-1 font-normal">
                  {t('admin.formErrors.count', { count: entries.length })}
                </span>
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-300 list-disc list-inside">
                {entries.map(e => {
                  const label = e.label ?? buildLabel(e.fieldId, labels, nameLanguage);
                  const key = e.fieldId ?? `m-${e.message}`;
                  return (
                    <li key={key}>
                      {e.fieldId ? (
                        <button
                          type="button"
                          onClick={() => focusField(e.fieldId)}
                          className="underline hover:text-red-900 dark:hover:text-red-100 focus:outline-hidden focus:ring-2 focus:ring-red-500 rounded-sm"
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

/**
 * The field ids whose element is on the page, in document order (the order a
 * reader meets the fields). Ids without an element are left out.
 *
 * @param {string[]} fieldIds
 * @param {ParentNode} [scope=document]
 * @returns {string[]}
 */
export function orderByDocument(fieldIds, scope = document) {
  return fieldIds
    .map(fieldId => ({ fieldId, el: findFieldElement(fieldId, scope) }))
    .filter(({ el }) => el)
    .sort((a, b) => {
      if (a.el === b.el) return 0;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    })
    .map(({ fieldId }) => fieldId);
}

/**
 * The entries in the order of `fieldOrder`; entries not in it keep their order
 * and come last.
 */
function sortByFieldOrder(entries, fieldOrder) {
  if (!fieldOrder.length) return entries;
  const rank = new Map(fieldOrder.map((fieldId, index) => [fieldId, index]));
  const rankOf = entry => rank.get(entry.fieldId) ?? Number.POSITIVE_INFINITY;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rankOf(a.entry) - rankOf(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
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
  return String(value).replace(/(["'\\.])/g, String.raw`\$1`);
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

/**
 * `description.en` → "Description — English" when `labels.description` is
 * "Description". The longest labelled start of the path names the field:
 * with `labels['iframeConfig.url']`, `iframeConfig.url` is that label.
 */
function buildLabel(fieldId, labels, nameLanguage) {
  if (!fieldId) return '';
  if (labels[fieldId]) return labels[fieldId];
  const parts = fieldId.split('.');
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const headLabel = labels[parts.slice(0, length).join('.')];
    if (headLabel) return `${headLabel} — ${nameLanguage(parts.slice(length).join('.'))}`;
  }
  if (parts.length === 1) return humanize(fieldId);
  return `${humanize(parts[0])} — ${nameLanguage(parts.slice(1).join('.'))}`;
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
