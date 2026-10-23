// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useMyProjects, useProjectsAvailability } from '../hooks/useProjects';
import { projectDisplayName } from '../utils/projectView';

const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-xs max-w-[12rem]';

/**
 * The projects of the open chat, as chips beside the chat input: the one it
 * runs in (a link to the project; it cannot be taken away — the chat was
 * started there), and the ones it draws on (each removable). Also shows a
 * failed change (it stays visible after the "+" menu has closed). Renders
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
  if (!userProjectsEnabled || (!containerProjectId && value.length === 0 && !error)) return null;

  const nameOf = id => {
    const project = projects.find(entry => entry.id === id);
    return project
      ? projectDisplayName(project, i18n.language)
      : t('projects.chatBar.unnamed', 'Project');
  };
  const linkTo = id => `/projects/${encodeURIComponent(id)}`;

  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="chat-project-chips">
      {containerProjectId && (
        <Link
          to={linkTo(containerProjectId)}
          className={`${CHIP} px-2 py-1 hover:underline`}
          title={t('projects.chatBar.open', 'Open the project')}
        >
          <Icon name="folder" size="xs" />
          <span className="truncate">
            {t('projects.chatBar.inProject', 'In project: {{name}}', {
              name: nameOf(containerProjectId)
            })}
          </span>
        </Link>
      )}
      {value.map(id => (
        <span key={id} className={`${CHIP} pl-2 pr-1 py-1`}>
          <Link
            to={linkTo(id)}
            className="inline-flex items-center gap-1 truncate hover:underline"
            title={t('projects.chatBar.open', 'Open the project')}
          >
            <Icon name="folder" size="xs" />
            <span className="truncate">{nameOf(id)}</span>
          </Link>
          <button
            type="button"
            onClick={() => toggle(id)}
            disabled={disabled || saving}
            aria-label={t('projects.attach.remove', 'Remove {{name}} from this chat', {
              name: nameOf(id)
            })}
            className="rounded-full p-0.5 hover:bg-purple-100 dark:hover:bg-purple-800/60 disabled:opacity-50"
          >
            <Icon name="x" size="xs" />
          </button>
        </span>
      ))}
      {error && (
        <p role="alert" className="basis-full text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export default ChatProjectChips;
