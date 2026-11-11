// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ChipOverflow, { HOVER_LABEL } from '../../../shared/components/ChipOverflow';
import Icon from '../../../shared/components/Icon';
import { useMyProjects, useProjectsAvailability } from '../hooks/useProjects';
import { projectDisplayName } from '../utils/projectView';

const CHIP =
  'group inline-flex shrink-0 items-center rounded-full border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs';

// More than this many project chips fold into a "+N" chip.
const MAX_VISIBLE_CHIPS = 2;

/**
 * The projects of the open chat, as chips beside the chat input: the one it
 * runs in (a link to the project; it cannot be taken away — the chat was
 * started there), and the ones it draws on (each removable). Also shows a failed change (it stays visible after the project picker has closed). Renders
 * nothing when the chat has no project and nothing went wrong.
 *
 * @param {Object} props
 * @param {Object} props.projectContext - `{ containerProjectId, value, disabled, attached, … }`;
 *   `attached` is the chat page's one {@link useChatAttachedProjects}.
 * @returns {JSX.Element|null}
 */
function ChatProjectChips({ projectContext }) {
  const { t, i18n } = useTranslation();
  const { userProjectsEnabled } = useProjectsAvailability();
  const { projects } = useMyProjects();
  const {
    containerProjectId = null,
    value = [],
    disabled = false,
    attached
  } = projectContext || {};
  const { toggle, saving, error } = attached || {};
  if (!userProjectsEnabled || (!containerProjectId && value.length === 0 && !error)) {
    return null;
  }

  const nameOf = id => {
    const project = projects.find(entry => entry.id === id);
    return project
      ? projectDisplayName(project, i18n.language)
      : t('projects.chatBar.unnamed', 'Project');
  };
  const linkTo = id => `/projects/${encodeURIComponent(id)}`;

  const items = [];
  if (containerProjectId) {
    const label = t('projects.chatBar.inProject', 'In project: {{name}}', {
      name: nameOf(containerProjectId)
    });
    items.push({
      key: containerProjectId,
      label: nameOf(containerProjectId),
      node: (
        <Link
          key={`container-${containerProjectId}`}
          to={linkTo(containerProjectId)}
          className={`${CHIP} px-2 py-1 hover:underline`}
          title={label}
        >
          <Icon name="folder" size="xs" />
          <span className={`${HOVER_LABEL} truncate`}>{label}</span>
        </Link>
      )
    });
  }
  for (const id of value) {
    items.push({
      key: id,
      label: nameOf(id),
      node: (
        <span key={id} className={`${CHIP} px-2 py-1`} title={nameOf(id)}>
          <Link to={linkTo(id)} className="inline-flex items-center hover:underline">
            <Icon name="folder" size="xs" />
            <span className={`${HOVER_LABEL} truncate`}>{nameOf(id)}</span>
          </Link>
          <button
            type="button"
            onClick={() => toggle(id)}
            disabled={disabled || saving}
            aria-label={t('projects.attach.remove', 'Remove {{name}} from this chat', {
              name: nameOf(id)
            })}
            className={`${HOVER_LABEL} rounded-full hover:bg-purple-100 disabled:opacity-50 dark:hover:bg-purple-800/60`}
          >
            <Icon name="x" size="xs" />
          </button>
        </span>
      )
    });
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="chat-project-chips">
      <ChipOverflow
        items={items}
        max={MAX_VISIBLE_CHIPS}
        className="border border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300"
      />
      {error && (
        <p
          role="alert"
          title={error}
          className="max-w-[12rem] truncate text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export default ChatProjectChips;
