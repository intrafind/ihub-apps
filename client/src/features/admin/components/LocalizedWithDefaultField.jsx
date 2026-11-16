// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { PRODUCT_NAME_REF, isTranslationRefTo } from '../../../../../shared/translationRefs.js';
import { resolveTranslationRefs } from '../../../utils/translationRefs';
import { CALLOUT_CLASS, HELP_CLASS, INPUT_CLASS, LABEL_CLASS, RADIO_CLASS } from './formStyles';

/** Whether a stored value follows the product name: nothing, or only references to it. */
export function followsProductName(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') return isTranslationRefTo(value, 'product.name');
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const texts = Object.values(value);
  return (
    texts.length === 0 || texts.every(text => !text || isTranslationRefTo(text, 'product.name'))
  );
}

/**
 * A ui.json text that follows the product name (`$t(product.name)`) unless the
 * admin writes their own. Two modes, one choice:
 * - "Use the product name": the text is a reference; the field shows what it
 *   resolves to and where to change the product name.
 * - "Custom text": the admin writes the text (per language, or one string).
 *
 * The custom text survives a switch to "product name" and back until the page is
 * saved, so a mis-click loses nothing. The stored value is never empty: an empty
 * custom text saves as the reference.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {string} [props.hint]
 * @param {Object|string} props.value - `{ lang: text }` when `localized`, else a string
 * @param {(value: Object|string) => void} props.onChange
 * @param {boolean} [props.localized=true]
 * @param {number} [props.maxLength]
 * @param {string} [props.placeholder] - Placeholder of the single text of a non-localized field
 */
export default function LocalizedWithDefaultField({
  label,
  hint,
  value,
  onChange,
  localized = true,
  maxLength,
  placeholder
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const following = followsProductName(value);
  const customDraftRef = useRef(null);
  const [announce, setAnnounce] = useState('');
  const productName = resolveTranslationRefs(PRODUCT_NAME_REF, t);

  const referenceValue = () => {
    if (!localized) return PRODUCT_NAME_REF;
    const languages = value && typeof value === 'object' ? Object.keys(value) : [];
    return Object.fromEntries(
      (languages.length ? languages : ['en']).map(l => [l, PRODUCT_NAME_REF])
    );
  };

  const chooseFollow = () => {
    if (following) return;
    customDraftRef.current = value;
    onChange(referenceValue());
    setAnnounce(t('admin.ui.nameField.followAnnounce', 'Using the product name'));
  };

  const chooseCustom = () => {
    if (!following) return;
    const seed = localized ? { en: productName } : productName;
    onChange(customDraftRef.current ?? seed);
    setAnnounce(t('admin.ui.nameField.customAnnounce', 'Using custom text'));
  };

  const customIsEmpty = localized
    ? !value || Object.values(value).every(text => !String(text || '').trim())
    : !String(value || '').trim();

  return (
    <fieldset className="space-y-3" aria-describedby={hint ? `${baseId}-hint` : undefined}>
      <legend className={LABEL_CLASS}>{label}</legend>
      {hint && (
        <p id={`${baseId}-hint`} className={HELP_CLASS}>
          {hint}
        </p>
      )}

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="radio"
          name={baseId}
          checked={following}
          onChange={chooseFollow}
          className={`${RADIO_CLASS} mt-0.5`}
        />
        <span className="text-sm text-gray-900 dark:text-gray-100">
          {t('admin.ui.nameField.follow', 'Use the product name (default)')}
        </span>
      </label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="radio"
          name={baseId}
          checked={!following}
          onChange={chooseCustom}
          className={`${RADIO_CLASS} mt-0.5`}
        />
        <span className="text-sm text-gray-900 dark:text-gray-100">
          {localized
            ? t('admin.ui.nameField.custom', 'Custom text per language')
            : t('admin.ui.nameField.customSingle', 'Custom text')}
        </span>
      </label>

      {following ? (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {t('admin.ui.nameField.resolvesTo', 'Resolves to')}
          </p>
          <p
            data-testid="resolved-product-name"
            className="text-sm font-medium text-gray-900 dark:text-gray-100"
          >
            {productName || t('admin.ui.nameField.noName', '(no product name defined)')}
          </p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            {t('admin.ui.nameField.changeName', 'Rename the product once, for every language, in')}{' '}
            <Link
              to="/admin/localization"
              className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('admin.nav.localization', 'Localization')}
            </Link>{' '}
            (<code>product.name</code>).
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {localized ? (
            <DynamicLanguageEditor
              label={t('admin.ui.nameField.customLabel', 'Text')}
              value={value || {}}
              onChange={onChange}
              type="text"
              maxLength={maxLength}
              placeholder={{ en: productName, de: productName }}
            />
          ) : (
            <input
              type="text"
              aria-label={label}
              value={typeof value === 'string' ? value : ''}
              maxLength={maxLength}
              placeholder={placeholder || productName}
              onChange={e => onChange(e.target.value)}
              className={INPUT_CLASS}
            />
          )}
          {customIsEmpty && (
            <p className={CALLOUT_CLASS.warning}>
              {t(
                'admin.ui.nameField.emptyFallback',
                'Empty text falls back to the product name when you save.'
              )}
            </p>
          )}
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </fieldset>
  );
}
