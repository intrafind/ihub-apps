// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchAdminApps, getAdminApiErrorMessage } from '../../../api/adminApi';
import useFocusTrap from '../../../shared/hooks/useFocusTrap';
import useMediaQuery from '../../../shared/hooks/useMediaQuery';
import { localizedText } from '../../projects/utils/projectItems';
import { PanelMessage, TestChat } from './AppTestPanel';
import { CALLOUT_CLASS, INPUT_CLASS } from './formStyles';

/** The app a project test starts with, when the installation still has it. */
const DEFAULT_APP_ID = 'chat';

const ICON_BUTTON =
  'p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

/**
 * The chat apps a project can be tried with: enabled ones (a disabled app is
 * not served to the chat), the general chat first, the rest by name.
 *
 * @param {Object[]|null|undefined} apps - Every app config
 * @param {string} [language]
 * @returns {Array<{ id: string, name: string }>}
 */
export function chatAppsToTest(apps, language = 'en') {
  return (Array.isArray(apps) ? apps : [])
    .filter(app => app?.id && (app.type || 'chat') === 'chat' && app.enabled !== false)
    .map(app => ({ id: app.id, name: localizedText(app.name, language) || app.id }))
    .sort((a, b) => {
      if (a.id === DEFAULT_APP_ID) return -1;
      if (b.id === DEFAULT_APP_ID) return 1;
      return a.name.localeCompare(b.name, language);
    });
}

/**
 * How many of the project's items a chat can search now. Only a ready or an
 * outdated item is searched; one that waits, is being extracted or failed is not.
 *
 * @param {{items?: Array<{status?: string}>}|null|undefined} project
 * @returns {{ total: number, ready: number, waiting: number, failed: number }}
 */
export function projectItemReadiness(project) {
  const items = Array.isArray(project?.items) ? project.items : [];
  const count = predicate => items.filter(item => predicate(item.status)).length;
  return {
    total: items.length,
    ready: count(status => status === 'ready' || status === 'stale'),
    waiting: count(status => status === 'pending' || status === 'extracting'),
    failed: count(status => status === 'failed')
  };
}

/**
 * Try in chat for an admin project (#3309): the real chat of an app, beside the
 * project editor, with this project as the only one in scope. It answers the
 * question the editor cannot: does the project work, and if an answer is
 * wrong, is it the project or the app and the model?
 *
 * - It runs the project as saved. The editor saves every change at once, so
 *   what the admin sees is what the chat reads, from the next question on.
 * - The admin picks the app (the general chat by default) and, in the chat's
 *   own picker, the model. The app's other projects are left out.
 * - Each answer shows its sources, the knowledge searches and what they found,
 *   as in any chat.
 * - It runs as the admin: how other users reach the project (app links,
 *   publishing, groups) is not exercised, and the panel says so.
 * - The chat is temporary: not in the admin's history, nothing stored in the project.
 *
 * Beside the editor on wide screens, full screen on narrow ones. Full screen it
 * covers the editor, so it is a dialog there: focus moves in, stays in, goes
 * back to the button on close, and Escape closes it.
 *
 * @param {Object} props
 * @param {string} props.projectId - The admin project to test
 * @param {Object} [props.project] - The project as the editor shows it (its items' status)
 * @param {() => void} props.onClose
 */
function ProjectTestPanel({ projectId, project = null, onClose }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language || 'en';
  const selectId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // Below the `lg` breakpoint the panel covers the editor (`lg:static` in its classes).
  const overlay = !useMediaQuery('(min-width: 64rem)');
  useFocusTrap(panelRef, { isActive: overlay, initialFocusRef: closeRef });
  // Escape closes the dialog. Listened for on the element, as the focus trap
  // does, rather than with a handler on the JSX element: a non-interactive
  // element must not carry one (jsx-a11y/no-noninteractive-element-interactions).
  useEffect(() => {
    const panel = panelRef.current;
    if (!overlay || !panel) return undefined;
    const closeOnEscape = event => {
      if (event.key === 'Escape') onClose();
    };
    panel.addEventListener('keydown', closeOnEscape);
    return () => panel.removeEventListener('keydown', closeOnEscape);
  }, [overlay, onClose]);
  const title = t('admin.projects.tryInChat.title', 'Try in chat');
  const [apps, setApps] = useState(null);
  const [appsError, setAppsError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [restarts, setRestarts] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAdminApps().then(
      result => !cancelled && setApps(result),
      err => !cancelled && setAppsError(getAdminApiErrorMessage(err))
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = useMemo(() => chatAppsToTest(apps, language), [apps, language]);
  const current = candidates.find(entry => entry.id === selected) || candidates[0] || null;
  const readiness = projectItemReadiness(project);

  let chatBody;
  if (appsError) {
    chatBody = <PanelMessage icon="exclamation-triangle">{appsError}</PanelMessage>;
  } else if (!apps) {
    chatBody = (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  } else if (!current) {
    chatBody = (
      <PanelMessage icon="information-circle">
        {t(
          'admin.projects.tryInChat.noApps',
          'There is no enabled chat app to try the project with. Enable one under Admin → Apps.'
        )}
      </PanelMessage>
    );
  } else {
    chatBody = (
      <TestChat key={`${current.id}-${restarts}`} appId={current.id} testProjectId={projectId} />
    );
  }

  return (
    <aside
      ref={panelRef}
      aria-label={title}
      {...(overlay ? { role: 'dialog', 'aria-modal': true } : {})}
      data-testid="project-test-panel"
      className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900 lg:static lg:z-auto lg:h-full lg:w-[45%] lg:min-w-[26rem] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-gray-200 lg:dark:border-gray-700"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <Icon name="beaker" className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {title}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {t('admin.projects.tryInChat.subtitle', 'A scratch chat with this project only')}
          </p>
        </div>
        {current && (
          <button
            type="button"
            onClick={() => setRestarts(n => n + 1)}
            className={ICON_BUTTON}
            title={t('admin.apps.test.restart', 'Restart with a new chat')}
            aria-label={t('admin.apps.test.restart', 'Restart with a new chat')}
          >
            <Icon name="refresh" className="h-4 w-4" />
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className={ICON_BUTTON}
          title={t('admin.projects.tryInChat.close', 'Close chat')}
          aria-label={t('admin.projects.tryInChat.close', 'Close chat')}
        >
          <Icon name="x-mark" className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 py-2 space-y-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
        {current && (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={selectId} className="text-sm text-gray-700 dark:text-gray-300">
                {t('admin.projects.tryInChat.app', 'App')}
              </label>
              <select
                id={selectId}
                className={`${INPUT_CLASS} w-auto min-w-0 flex-1 py-1`}
                value={current.id}
                onChange={event => setSelected(event.target.value)}
                data-testid="project-test-app-select"
              >
                {candidates.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.projects.tryInChat.appHelp',
                "The app's own instructions and tools apply; the other projects it links are left out. Pick the model in the chat."
              )}
            </p>
          </div>
        )}

        <output className={`${CALLOUT_CLASS.info} block py-2 text-xs`}>
          {t(
            'admin.projects.tryInChat.adminNotice',
            'The chat runs as you, on the project as saved. How other users reach it (app links, publishing, groups) is not tested. The chat is temporary: it is not kept in your history and nothing is added to the project.'
          )}
        </output>

        {readiness.total > 0 && readiness.waiting + readiness.failed > 0 && (
          <output className={`${CALLOUT_CLASS.warning} block py-2 text-xs`}>
            {t(
              'admin.projects.tryInChat.notReady',
              '{{count}} of {{total}} items are not ready (waiting, being extracted or failed) and are not searched yet.',
              { count: readiness.waiting + readiness.failed, total: readiness.total }
            )}
          </output>
        )}
        {readiness.total === 0 && project && (
          <output className={`${CALLOUT_CLASS.warning} block py-2 text-xs`}>
            {t(
              'admin.projects.tryInChat.noItems',
              'The project has no items yet, so there is nothing to find. Add an item first.'
            )}
          </output>
        )}
      </div>

      {chatBody}
    </aside>
  );
}

export default ProjectTestPanel;
