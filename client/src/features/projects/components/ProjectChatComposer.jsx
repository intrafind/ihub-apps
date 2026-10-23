// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { clearConversationId, resetChatId } from '../../../utils/chatId';
import { projectChatStartPath, resolveProjectChatApp } from '../utils/projectView';
import ProjectAppSelect, { useProjectChatApps } from './ProjectAppSelect';
import { INPUT_CLASS } from './item-dialog/dialogStyles';

/**
 * Longest first message: it travels to the chat page in the URL
 * (`?prefill=`), so it stays well inside what a server accepts for one.
 */
export const MAX_FIRST_MESSAGE_LENGTH = 2000;

/**
 * Starts a chat inside a project from the project page (spec 1 §6.3): type
 * the first message and send, and the chat opens in the project's default
 * app with that message already sent. The app select beside the send button
 * picks another app for this chat; without a message the button opens an
 * empty chat of the app.
 *
 * @param {Object} props
 * @param {{id: string, name: string, defaultAppId?: string|null}} props.project
 * @param {string} props.projectName - The name to show.
 * @returns {JSX.Element}
 */
function ProjectChatComposer({ project, projectName }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { choices, loading } = useProjectChatApps();
  const [message, setMessage] = useState('');
  // The user's pick for this visit; until then the project's default applies.
  const [picked, setPicked] = useState('');
  const apps = choices.map(({ app }) => app);
  const appId =
    picked && apps.some(app => app.id === picked)
      ? picked
      : resolveProjectChatApp(apps, project.defaultAppId);

  const start = () => {
    if (!appId) return;
    // A new chat, every time: the chat page opens the chat id this tab holds
    // for the app, and without stored chats that is the previous
    // conversation, whose browser transcript would come back and be
    // continued under this project. Minted here, once per start, the same
    // way the sidebar leaves a chat; a reload of the chat page keeps
    // finding it. With stored chats the page mints a fresh id for the bare
    // app route anyway.
    resetChatId(appId);
    // An iAssistant app resumes the conversation id it keeps in localStorage
    // into an empty chat; drop it too, as the chat page's own "new chat" does.
    clearConversationId(appId);
    navigate(projectChatStartPath(appId, project.id, message));
  };

  const handleKeyDown = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    start();
  };

  const noApps = !loading && !appId;
  const placeholder = t('projects.composer.placeholder', 'New chat in {{name}}', {
    name: projectName
  });

  return (
    <section
      className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4"
      aria-label={t('projects.composer.title', 'Start a chat in this project')}
      data-testid="project-chat-composer"
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          start();
        }}
      >
        <textarea
          rows={3}
          value={message}
          maxLength={MAX_FIRST_MESSAGE_LENGTH}
          onChange={event => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={noApps}
          className={`${INPUT_CLASS} resize-none`}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {noApps
              ? t('projects.chats.noApps', 'No app can chat inside projects.')
              : t(
                  'projects.composer.hint',
                  'The app gets the project’s instructions and documents.'
                )}
          </p>
          <div className="flex items-center gap-2 ml-auto">
            <label htmlFor="project-composer-app" className="sr-only">
              {t('projects.composer.app', 'App')}
            </label>
            <ProjectAppSelect
              id="project-composer-app"
              value={appId || ''}
              onChange={setPicked}
              disabled={noApps}
              className={`${INPUT_CLASS} !w-auto max-w-[14rem] text-sm !py-1.5`}
            />
            <button
              type="submit"
              disabled={!appId}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              <Icon name="chat" size="sm" />
              {message.trim()
                ? t('projects.composer.send', 'Send')
                : t('projects.chats.newChat', 'New chat')}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

export default ProjectChatComposer;
