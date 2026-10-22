// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { moveChatToProject } from '../../../api';
import { invalidateProjectsList, useMyProjects } from '../hooks/useProjects';
import { projectErrorMessage } from '../utils/projectErrors';
import { chatMoveTargets, projectDisplayName } from '../utils/projectView';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './item-dialog/dialogStyles';

/**
 * Moves a stored chat into one of the caller's user projects, or out of its
 * project (`PATCH /api/chats/:chatId { projectId }`, spec 1 §6.4). From then
 * on the chat runs with that project's instructions and documents.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {string} props.chatId
 * @param {string|null} props.currentProjectId
 * @param {() => void} props.onClose
 * @param {(projectId: string|null) => void} props.onMoved
 * @returns {JSX.Element}
 */
function MoveChatToProjectDialog({ chatId, currentProjectId, onClose, onMoved }) {
  const { t, i18n } = useTranslation();
  const { projects, loading } = useMyProjects();
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const targets = chatMoveTargets(projects, currentProjectId);

  const move = async projectId => {
    setSaving(true);
    setError(null);
    try {
      await moveChatToProject(chatId, projectId);
      invalidateProjectsList();
      onMoved(projectId);
    } catch (err) {
      setError(projectErrorMessage(err, t));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} labelledBy="move-chat-title">
      <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
        <h2 id="move-chat-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('projects.moveChat.title', 'Move chat to a project')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            'projects.moveChat.hint',
            'The chat then uses the project’s instructions and documents, and its members can read it.'
          )}
        </p>
      </div>
      <ul
        className="max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700"
        aria-label={t('projects.moveChat.list', 'Projects')}
      >
        {loading && targets.length === 0 && (
          <li className="px-6 py-3 text-sm text-gray-500">{t('common.loading', 'Loading…')}</li>
        )}
        {!loading && targets.length === 0 && (
          <li className="px-6 py-3 text-sm text-gray-500">
            {t('projects.moveChat.none', 'You have no other project to move this chat to.')}
          </li>
        )}
        {targets.map(project => (
          <li key={project.id}>
            <button
              type="button"
              aria-pressed={selected === project.id}
              onClick={() => setSelected(project.id)}
              className={`w-full flex items-center gap-3 px-6 py-3 text-left text-sm ${
                selected === project.id
                  ? 'bg-indigo-50 dark:bg-indigo-900/30'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <Icon name="folder" size="sm" className="text-indigo-500 flex-none" />
              <span className="truncate text-gray-900 dark:text-gray-100">
                {projectDisplayName(project, i18n.language)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-6 pt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex flex-wrap justify-end gap-2">
        {currentProjectId && (
          <button
            type="button"
            onClick={() => move(null)}
            disabled={saving}
            className={`${SECONDARY_BUTTON} mr-auto`}
          >
            {t('projects.moveChat.remove', 'Remove from project')}
          </button>
        )}
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={() => move(selected)}
          disabled={!selected || saving}
          className={PRIMARY_BUTTON}
        >
          {t('projects.moveChat.submit', 'Move')}
        </button>
      </div>
    </Modal>
  );
}

export default MoveChatToProjectDialog;
