// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/**
 * The eight colours an app can take with one click, each with the name a
 * screen reader announces. The first one is the default colour of a new app.
 */
export const APP_COLOR_SWATCHES = Object.freeze([
  { value: '#4F46E5', labelKey: 'admin.apps.create.essentials.colors.indigo' },
  { value: '#2563EB', labelKey: 'admin.apps.create.essentials.colors.blue' },
  { value: '#0D9488', labelKey: 'admin.apps.create.essentials.colors.teal' },
  { value: '#059669', labelKey: 'admin.apps.create.essentials.colors.green' },
  { value: '#D97706', labelKey: 'admin.apps.create.essentials.colors.orange' },
  { value: '#DC2626', labelKey: 'admin.apps.create.essentials.colors.red' },
  { value: '#DB2777', labelKey: 'admin.apps.create.essentials.colors.pink' },
  { value: '#4B5563', labelKey: 'admin.apps.create.essentials.colors.gray' }
]);

const SWATCH_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-full text-white border border-black/10 dark:border-white/20 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800';

const sameColor = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * The colour of an app: eight swatches, and "Custom color" for any other.
 *
 * @param {object} props
 * @param {string} props.value - `#RRGGBB`.
 * @param {(color: string) => void} props.onChange
 * @param {string} props.label - The name of the group ("Color").
 * @returns {JSX.Element}
 */
function ColorSwatchPicker({ value, onChange, label }) {
  const { t } = useTranslation();
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const customId = `${baseId}-custom`;
  const isSwatch = APP_COLOR_SWATCHES.some(swatch => sameColor(swatch.value, value));

  return (
    <div role="group" aria-labelledby={labelId}>
      <span id={labelId} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </span>
      <div className="mt-1 grid w-max grid-cols-4 gap-2">
        {APP_COLOR_SWATCHES.map(swatch => {
          const selected = sameColor(swatch.value, value);
          return (
            <button
              key={swatch.value}
              type="button"
              className={SWATCH_CLASS}
              style={{ backgroundColor: swatch.value }}
              aria-label={t(swatch.labelKey)}
              aria-pressed={selected}
              onClick={() => onChange(swatch.value)}
            >
              {selected && <Icon name="check" size="sm" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          id={customId}
          type="color"
          className="h-8 w-10 shrink-0 cursor-pointer rounded-sm border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 p-0.5"
          value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : APP_COLOR_SWATCHES[0].value}
          onChange={event => onChange(event.target.value.toUpperCase())}
        />
        <label htmlFor={customId} className="text-sm text-gray-700 dark:text-gray-300">
          {t('admin.apps.create.essentials.colorCustom')}
          {!isSwatch && value ? ` (${value})` : ''}
        </label>
      </div>
    </div>
  );
}

export default ColorSwatchPicker;
