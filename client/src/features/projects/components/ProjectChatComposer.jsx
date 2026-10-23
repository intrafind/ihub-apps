// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { clearConversationId, resetChatId } from '../../../utils/chatId';
import AppChatStarter, { MAX_START_PATH_LENGTH } from '../../chat/components/AppChatStarter';
import {
  ATTACH_PROJECT_QUERY_PARAM,
  PROJECT_QUERY_PARAM,
  projectChatStartPath,
  resolveProjectChatApp
} from '../utils/projectView';
import ProjectAppSelect, { useProjectChatApps } from './ProjectAppSelect';
import { INPUT_CLASS } from './item-dialog/dialogStyles';

/**
 * Starts a chat inside a project from the project page (spec 1 §6.3): the
 * same chat input as the start page (uploads, model selector, tools, web
 * search, magic prompt, dictation) for the project's default app; send, and
 * the chat opens in that app inside the project with the message already
 * sent. The app select above the input picks another app for this chat;
 * "New chat" opens an empty chat of the app.
 *
 * @param {Object} props
 * @param {{id: string, name: string, defaultAppId?: string|null}} props.project
 * @param {string} props.projectName - The name to show.
 * @param {boolean} [props.attach=false] - Start the chat outside the project with the
 *   project attached (someone who took it from the catalog holds no chats in it).
 * @returns {JSX.Element}
 */
function ProjectChatComposer({ project, projectName, attach = false }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { choices, loading } = useProjectChatApps();
  // The user's pick for this visit; until then the project's default applies.
  const [picked, setPicked] = useState('');
  const apps = choices.map(({ app }) => app);
  const appId =
    picked && apps.some(app => app.id === picked)
      ? picked
      : resolveProjectChatApp(apps, project.defaultAppId);
  const app = apps.find(entry => entry.id === appId) || null;

  // A new chat, every time: the chat page opens the chat id this tab holds
  // for the app, and without stored chats that is the previous conversation,
  // whose browser transcript would come back and be continued under this
  // project. Minted here, once per start, the same way the sidebar leaves a
  // chat; a reload of the chat page keeps finding it. With stored chats the
  // page mints a fresh id for the bare app route anyway. An iAssistant app
  // resumes the conversation id it keeps in localStorage into an empty chat;
  // drop it too, as the chat page's own "new chat" does.
  const freshChat = useCallback(id => {
    resetChatId(id);
    clearConversationId(id);
  }, []);

  const startParams = useMemo(
    () => ({ [attach ? ATTACH_PROJECT_QUERY_PARAM : PROJECT_QUERY_PARAM]: project.id }),
    [attach, project.id]
  );

  const openEmptyChat = () => {
    if (!appId) return;
    freshChat(appId);
    navigate(projectChatStartPath(appId, project.id, { attach }));
  };

  const noApps = !loading && !appId;

  return (
    <section
      className="bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl p-4"
      aria-label={t('projects.composer.placeholder', 'New chat in {{name}}', {
        name: projectName
      })}
      data-testid="project-chat-composer"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {app && (
            <span
              className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs flex-none"
              style={{ backgroundColor: app.color || '#4f46e5' }}
            >
              <Icon name={app.icon || 'chat'} size="sm" className="w-3.5 h-3.5" />
            </span>
          )}
          <label htmlFor="project-composer-app" className="sr-only">
            {t('projects.composer.app', 'App')}
          </label>
          <ProjectAppSelect
            id="project-composer-app"
            value={appId || ''}
            onChange={setPicked}
            disabled={noApps}
            className={`${INPUT_CLASS} !w-auto max-w-[14rem] text-sm !py-1`}
          />
        </div>
        <button
          type="button"
          onClick={openEmptyChat}
          disabled={!appId}
          className="text-sm text-indigo-600 dark:text-indigo-400 font-medium hover:underline disabled:opacity-50 disabled:no-underline flex-none"
        >
          {t('projects.chats.newChat', 'New chat')} <span aria-hidden="true">→</span>
        </button>
      </div>

      {noApps ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('projects.chats.noApps', 'No app can chat inside projects.')}
        </p>
      ) : (
        <AppChatStarter
          app={app}
          startParams={startParams}
          onBeforeStart={freshChat}
          maxPathLength={MAX_START_PATH_LENGTH}
        />
      )}

      {!noApps && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('projects.composer.hint', 'The app gets the project’s instructions and documents.')}
        </p>
      )}
    </section>
  );
}

export default ProjectChatComposer;
