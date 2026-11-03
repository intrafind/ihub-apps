// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../shared/components/Icon';
import { MONO_INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../../formStyles';
import { recordToRows, rowsToRecord } from './builderModel';

/**
 * Name/value rows for a `{ name: value }` record: static headers, query
 * parameters, the fields of a response mapping, environment variables. Rows
 * with an empty name are kept while editing and dropped from the record.
 *
 * @param {Object} props
 * @param {string} props.legend - what the rows are
 * @param {Object<string,string>} props.value
 * @param {(record: Object<string,string>) => void} props.onChange
 * @param {string} [props.keyLabel] - label of the name column
 * @param {string} [props.valueLabel] - label of the value column
 * @param {string} [props.help]
 * @returns {JSX.Element}
 */
function KeyValueRowsEditor({ legend, value, onChange, keyLabel, valueLabel, help }) {
  const { t } = useTranslation();
  const baseId = useId();
  const [rows, setRows] = useState(() => recordToRows(value));

  // A record that changes from outside (a loaded draft) replaces the rows,
  // unless it is what the rows already say.
  useEffect(() => {
    setRows(current =>
      JSON.stringify(rowsToRecord(current)) === JSON.stringify(value || {})
        ? current
        : recordToRows(value)
    );
  }, [value]);

  const commit = next => {
    setRows(next);
    onChange(rowsToRecord(next));
  };

  const nameLabel = keyLabel || t('admin.integrationBuilder.rows.name', 'Name');
  const valLabel = valueLabel || t('admin.integrationBuilder.rows.value', 'Value');

  return (
    <fieldset className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
      <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-300">
        {legend}
      </legend>
      {help && <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">{help}</p>}
      <ul className="space-y-2">
        {rows.map((row, i) => (
          <li key={i} className="flex items-center gap-2">
            <label htmlFor={`${baseId}-k-${i}`} className="sr-only">
              {`${nameLabel} ${i + 1}`}
            </label>
            <input
              id={`${baseId}-k-${i}`}
              type="text"
              value={row.key}
              placeholder={nameLabel}
              onChange={e =>
                commit(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
              className={MONO_INPUT_CLASS}
            />
            <label htmlFor={`${baseId}-v-${i}`} className="sr-only">
              {`${valLabel} ${i + 1}`}
            </label>
            <input
              id={`${baseId}-v-${i}`}
              type="text"
              value={row.value}
              placeholder={valLabel}
              onChange={e =>
                commit(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              className={MONO_INPUT_CLASS}
            />
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
              aria-label={t('admin.integrationBuilder.rows.remove', 'Remove row {{n}}', {
                n: i + 1
              })}
            >
              <Icon name="trash" size="sm" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={`${SECONDARY_BUTTON_CLASS} mt-2`}
        onClick={() => setRows([...rows, { key: '', value: '' }])}
      >
        <Icon name="plus" size="sm" />
        {t('admin.integrationBuilder.rows.add', 'Add row')}
      </button>
    </fieldset>
  );
}

export default KeyValueRowsEditor;
