// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import useApps from '../../../shared/hooks/useApps';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { resetChatId } from '../../../utils/chatId';
import { appsForProjectChats, projectChatStartPath } from '../utils/projectView';
import { INPUT_CLASS } from './item-dialog/dialogStyles';

/**
 * Starts a chat inside a project (spec 1 §6.3): the user picks the app, and
 * the chat opens with the project attached — its instructions and documents
 * reach the model from the first message on.
 *
 * Mount it only while open.
 *
 * @param {Object} props
 * @param {string} props.projectId
 * @param {() => void} props.onClose
 * @returns {JSX.Element}
 */
function StartProjectChatDialog({ projectId, onClose }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { apps, loading } = useApps();
  const [search, setSearch] = useState('');
  const searchRef = useRef(null);
  const language = i18n.language;

  const choices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return appsForProjectChats(apps)
      .map(app => ({ app, name: getLocalizedContent(app.name, language) || app.id }))
      .filter(({ name }) => !query || name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [apps, search, language]);

  // A new chat, every time: the chat page opens the chat id this tab holds for
  // the app, and without stored chats that is the previous conversation, whose
  // browser transcript would come back and be continued under this project.
  // Minted here, once per start, the same way the sidebar leaves a chat; a
  // reload of the chat page keeps finding it. With stored chats the page mints
  // a fresh id for the bare app route anyway.
  const startChat = appId => {
    resetChatId(appId);
    navigate(projectChatStartPath(appId, projectId));
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      labelledBy="start-project-chat-title"
      initialFocusRef={searchRef}
    >
      <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
        <h2
          id="start-project-chat-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('projects.chats.startTitle', 'Start a chat in this project')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            'projects.chats.startHint',
            'Choose the app to chat with. It gets the project’s instructions and documents.'
          )}
        </p>
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('projects.chats.searchApps', 'Search apps')}
          aria-label={t('projects.chats.searchApps', 'Search apps')}
          className={`${INPUT_CLASS} mt-3`}
        />
      </div>
      <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
        {loading && choices.length === 0 && (
          <li className="px-6 py-3 text-sm text-gray-500">{t('common.loading', 'Loading…')}</li>
        )}
        {!loading && choices.length === 0 && (
          <li className="px-6 py-3 text-sm text-gray-500">
            {t('projects.chats.noApps', 'No app can chat inside projects.')}
          </li>
        )}
        {choices.map(({ app, name }) => (
          <li key={app.id}>
            <button
              type="button"
              onClick={() => startChat(app.id)}
              className="w-full flex items-center gap-3 px-6 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <span
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white flex-none"
                style={{ backgroundColor: app.color || '#4f46e5' }}
              >
                <Icon name={app.icon || 'chat'} size="sm" />
              </span>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {name}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"
        >
          {t('common.cancel', 'Cancel')}
        </button>
      </div>
    </Modal>
  );
}

export default StartProjectChatDialog;
