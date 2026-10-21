// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { invalidateChatsCache } from '../../../shared/hooks/chatListStore';
import { useMyProjects, useProjectsAvailability } from '../hooks/useProjects';
import { projectDisplayName } from '../utils/projectView';
import MoveChatToProjectDialog from './MoveChatToProjectDialog';

/**
 * The project of the open chat (spec 1 §6.4): a breadcrumb chip that links
 * to the project page, and — for a stored chat — "Move to project" /
 * "Change project". Renders nothing while user projects are off, or when
 * the chat has no project and cannot be moved.
 *
 * @param {Object} props
 * @param {string|null} props.chatId
 * @param {string|null} props.projectId - The chat's container project.
 * @param {boolean} props.canMove - The chat is stored (only stored chats can move).
 * @param {(projectId: string|null) => void} props.onMoved
 * @returns {JSX.Element|null}
 */
function ChatProjectBar({ chatId, projectId, canMove, onMoved }) {
  const { t, i18n } = useTranslation();
  const { userProjectsEnabled } = useProjectsAvailability();
  const { projects } = useMyProjects();
  const [moving, setMoving] = useState(false);
  if (!userProjectsEnabled || (!projectId && !canMove)) return null;

  const project = projectId ? projects.find(entry => entry.id === projectId) : null;
  const name = project
    ? projectDisplayName(project, i18n.language)
    : t('projects.chatBar.unnamed', 'Project');

  return (
    <div
      className="shrink-0 flex flex-wrap items-center justify-end gap-2 mb-2 text-xs"
      data-testid="chat-project-bar"
    >
      {projectId && (
        <Link
          to={`/projects/${encodeURIComponent(projectId)}`}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 hover:underline max-w-xs"
          title={t('projects.chatBar.open', 'Open the project')}
        >
          <Icon name="folder" size="xs" />
          <span className="truncate">
            {t('projects.chatBar.inProject', 'In project: {{name}}', { name })}
          </span>
        </Link>
      )}
      {canMove && chatId && (
        <button
          type="button"
          onClick={() => setMoving(true)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <Icon name="folder-open" size="xs" />
          {projectId
            ? t('projects.chatBar.change', 'Change project')
            : t('projects.chatBar.move', 'Move to project')}
        </button>
      )}
      {moving && (
        <MoveChatToProjectDialog
          chatId={chatId}
          currentProjectId={projectId}
          onClose={() => setMoving(false)}
          onMoved={next => {
            setMoving(false);
            invalidateChatsCache();
            onMoved(next);
          }}
        />
      )}
    </div>
  );
}

export default ChatProjectBar;
