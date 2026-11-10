// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { KNOWLEDGE_MODES } from '../../../../../shared/knowledgeModes.js';
import { knowledgeModeLabel } from '../utils/knowledgeModes';
import { INPUT_CLASS } from './item-dialog/dialogStyles';

/**
 * A select for the knowledge mode of a project, a link or a chat (#3538):
 * automatic, full context, relevant sections, search, pinned only.
 *
 * Offers `modes` (every mode unless the caller narrows it, for instance to the ones
 * the installation allows, `useProjectsAvailability().knowledgeModes`), plus the
 * mode already chosen, so a value the platform has since switched off is shown,
 * not silently replaced. `emptyLabel` adds the "inherit" entry: no
 * mode of its own, the next level decides (the project's default for a link,
 * the project for a chat).
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} [props.value] - A knowledge mode, or '' for the inherited one.
 * @param {(value: string) => void} props.onChange - Gets a mode, or '' for the inherited one.
 * @param {string} [props.emptyLabel] - Label of the inherit entry; none when absent.
 * @param {string[]} [props.modes] - The modes on offer; all of them by default.
 * @param {boolean} [props.disabled=false]
 * @param {string} [props.className]
 * @param {string} [props.ariaLabel]
 * @returns {JSX.Element}
 */
function KnowledgeModeSelect({
  id,
  value = '',
  onChange,
  emptyLabel,
  modes = KNOWLEDGE_MODES,
  disabled = false,
  className = INPUT_CLASS,
  ariaLabel
}) {
  const { t } = useTranslation();
  const offered = modes.filter(mode => KNOWLEDGE_MODES.includes(mode));
  const options = value && !offered.includes(value) ? [...offered, value] : offered;
  return (
    <select
      id={id}
      value={value || ''}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={event => onChange(event.target.value)}
      className={className}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {options.map(mode => (
        <option key={mode} value={mode}>
          {knowledgeModeLabel(t, mode)}
        </option>
      ))}
    </select>
  );
}

export default KnowledgeModeSelect;
