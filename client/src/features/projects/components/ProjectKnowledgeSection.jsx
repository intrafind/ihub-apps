// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import SubmenuRow from '../../integrations/picker/SubmenuRow';
import { knowledgeModeLabel, knowledgeModeShortDescription } from '../utils/knowledgeModes';

/**
 * Whether the search text of the "+" menu finds the knowledge row: the row's
 * title, "knowledge", and the name of the chosen mode.
 *
 * @param {Function} t - i18next `t`.
 * @param {string} query
 * @param {string} [value] - The chat's own mode, '' for none.
 * @returns {boolean}
 */
export function projectKnowledgeMatches(t, query, value = '') {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  if (!needle) return true;
  return [
    t('projects.knowledgeMode.menu.title', 'Project knowledge'),
    t('projects.knowledgeMode.label', 'Knowledge mode'),
    value ? knowledgeModeLabel(t, value) : ''
  ].some(text => text.toLowerCase().includes(needle));
}

/**
 * How a chat reaches the knowledge of its projects, as a row of the "+" menu
 * (#3538): "Project knowledge", the current choice under it, the options in a
 * list that opens in place. The empty choice leaves the decision to the
 * project (and the link of the app); the others override it for this chat.
 *
 * @param {Object} props
 * @param {{value: string, modes: string[], onChange: (mode: string) => void,
 *   disabled: boolean, projectCount: number}} props.menu - `useProjectKnowledgeMenu()`
 * @param {() => void} [props.onPicked] - Called after a pick (the menu closes).
 * @returns {JSX.Element}
 */
export default function ProjectKnowledgeSection({ menu, onPicked }) {
  const { t } = useTranslation();
  const inheritLabel = t('projects.knowledgeMode.projectDefault', 'Project default');
  const options = [
    {
      id: '',
      label: inheritLabel,
      description: t(
        'projects.knowledgeMode.menu.inheritDescription',
        'Each project decides for itself.'
      )
    },
    ...menu.modes.map(mode => ({
      id: mode,
      group: t('projects.knowledgeMode.menu.override', 'Override for this chat'),
      label: knowledgeModeLabel(t, mode),
      description: knowledgeModeShortDescription(t, mode)
    }))
  ];
  return (
    <SubmenuRow
      id="project-knowledge"
      icon="folder"
      title={t('projects.knowledgeMode.menu.title', 'Project knowledge')}
      valueLabel={menu.value ? knowledgeModeLabel(t, menu.value) : inheritLabel}
      options={options}
      selectedId={menu.value}
      onSelect={menu.onChange}
      onPicked={onPicked}
      disabled={menu.disabled}
      footnote={
        menu.projectCount > 1
          ? t('projects.knowledgeMode.menu.allProjects', 'Applies to all projects in this chat.')
          : undefined
      }
    />
  );
}
