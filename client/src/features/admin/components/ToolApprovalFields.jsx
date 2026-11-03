// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { APPROVAL_MODES, DATA_FLOWS, SIDE_EFFECTS } from '../../../../../shared/toolApproval.js';

const SELECT_CLASS =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:outline-hidden focus:ring-indigo-500 focus:border-indigo-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm';

/**
 * The label of an approval mode, translated.
 *
 * @param {Function} t - translation function
 * @param {string} mode - `never` | `writes` | `always`
 * @returns {string}
 */
export function approvalModeLabel(t, mode) {
  switch (mode) {
    case 'never':
      return t('admin.toolApproval.mode.never', 'Never ask');
    case 'writes':
      return t('admin.toolApproval.mode.writes', 'Ask unless it only reads');
    case 'always':
      return t('admin.toolApproval.mode.always', 'Always ask');
    default:
      return mode;
  }
}

/**
 * A select for a tool approval mode (#2945). The empty value means "not set
 * here": the setting is inherited (its label says from where).
 *
 * @param {Object} props
 * @param {string} props.label - visible label
 * @param {string} [props.value] - the mode, or '' / undefined for not set
 * @param {(mode: string|undefined) => void} props.onChange - `undefined` for not set
 * @param {string} [props.inheritLabel] - label of the empty option; omit to require a mode
 * @param {string[]} [props.modes] - the modes to offer (default: all)
 * @param {string} [props.help] - help text under the select
 * @param {boolean} [props.compact] - small inline select without label text (label stays for screen readers)
 * @param {boolean} [props.disabled]
 * @returns {JSX.Element}
 */
export function ApprovalModeSelect({
  label,
  value,
  onChange,
  inheritLabel,
  modes = APPROVAL_MODES,
  help,
  compact = false,
  disabled = false
}) {
  const { t } = useTranslation();
  const id = useId();
  const helpId = useId();
  return (
    <div className={compact ? 'inline-block' : ''}>
      <label
        htmlFor={id}
        className={
          compact ? 'sr-only' : 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'
        }
      >
        {label}
      </label>
      <select
        id={id}
        value={value || ''}
        disabled={disabled}
        aria-describedby={help ? helpId : undefined}
        onChange={e => onChange(e.target.value || undefined)}
        className={compact ? `${SELECT_CLASS} w-auto py-1 text-xs` : SELECT_CLASS}
      >
        {inheritLabel !== undefined && <option value="">{inheritLabel}</option>}
        {modes.map(mode => (
          <option key={mode} value={mode}>
            {approvalModeLabel(t, mode)}
          </option>
        ))}
      </select>
      {help && (
        <p id={helpId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * A select for a tool's declared side effect or data flow (empty: not declared).
 *
 * @param {Object} props
 * @param {'sideEffect'|'dataFlow'} props.kind
 * @param {string} props.label
 * @param {string} [props.value]
 * @param {(value: string|undefined) => void} props.onChange
 * @param {string} [props.help]
 * @returns {JSX.Element}
 */
export function ToolEffectSelect({ kind, label, value, onChange, help }) {
  const { t } = useTranslation();
  const id = useId();
  const helpId = useId();
  const values = kind === 'dataFlow' ? DATA_FLOWS : SIDE_EFFECTS.filter(v => v !== 'unknown');
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      <select
        id={id}
        value={value || ''}
        aria-describedby={help ? helpId : undefined}
        onChange={e => onChange(e.target.value || undefined)}
        className={SELECT_CLASS}
      >
        <option value="">{t('admin.toolApproval.notDeclared', 'Not declared')}</option>
        {values.map(v => (
          <option key={v} value={v}>
            {kind === 'dataFlow'
              ? t(`admin.toolApproval.dataFlow.${v}`, v)
              : t(`admin.integrationCatalog.sideEffect.${v}`, v)}
          </option>
        ))}
      </select>
      {help && (
        <p id={helpId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {help}
        </p>
      )}
    </div>
  );
}
