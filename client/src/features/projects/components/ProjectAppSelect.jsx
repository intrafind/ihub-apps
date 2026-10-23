// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import useApps from '../../../shared/hooks/useApps';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { appsForProjectChats } from '../utils/projectView';

/**
 * Hook: the apps a chat inside a project can start in, with their display
 * names, sorted by name.
 *
 * @returns {{choices: Array<{app: Object, name: string}>, loading: boolean}}
 */
export function useProjectChatApps() {
  const { i18n } = useTranslation();
  const { apps, loading } = useApps();
  const language = i18n.language;
  const choices = useMemo(
    () =>
      appsForProjectChats(apps)
        .map(app => ({ app, name: getLocalizedContent(app.name, language) || app.id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [apps, language]
  );
  return { choices, loading };
}

/**
 * A select of the apps that can chat inside projects.
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} props.value - The selected app id; empty for none.
 * @param {(appId: string) => void} props.onChange
 * @param {string} [props.noneLabel] - Adds an empty choice with this label.
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]
 * @param {string} [props.ariaLabel]
 * @returns {JSX.Element}
 */
function ProjectAppSelect({
  id,
  value,
  onChange,
  noneLabel,
  disabled = false,
  className = '',
  ariaLabel
}) {
  const { t } = useTranslation();
  const { choices, loading } = useProjectChatApps();
  // A default app the viewer cannot use (removed, or not shared with them)
  // stays selected rather than silently turning into "none"; saving the
  // form then keeps it for the people who can.
  const missing = value && !choices.some(({ app }) => app.id === value);
  return (
    <select
      id={id}
      value={value || ''}
      disabled={disabled || (loading && choices.length === 0)}
      aria-label={ariaLabel}
      onChange={e => onChange(e.target.value)}
      className={className}
    >
      {noneLabel !== undefined && <option value="">{noneLabel}</option>}
      {missing && (
        <option value={value}>
          {t('projects.appSelect.unavailable', '{{id}} (not available)', { id: value })}
        </option>
      )}
      {choices.map(({ app, name }) => (
        <option key={app.id} value={app.id}>
          {name}
        </option>
      ))}
    </select>
  );
}

export default ProjectAppSelect;
