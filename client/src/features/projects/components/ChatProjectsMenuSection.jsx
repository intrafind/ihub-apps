// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useChatAttachedProjects, MAX_ATTACHED_PROJECTS } from '../hooks/useChatAttachedProjects';
import { useMyProjects, useProjectsAvailability } from '../hooks/useProjects';
import { projectDisplayName } from '../utils/projectView';

/**
 * Hook: the projects the chat input's "+" menu offers for this chat — the
 * viewer's own and shared user projects, except the one the chat runs in.
 * Empty while user projects are off or when the chat takes no projects
 * (`projectContext` is not given).
 *
 * @param {{containerProjectId?: string|null}|null|undefined} projectContext
 * @returns {Array<Object>}
 */
export function useOfferedProjects(projectContext) {
  const { userProjectsEnabled } = useProjectsAvailability();
  const { projects } = useMyProjects();
  if (!projectContext || !userProjectsEnabled) return [];
  const containerId = projectContext.containerProjectId ?? null;
  return projects.filter(project => project.ownership === 'user' && project.id !== containerId);
}

/** The navigation key of a project row in the menu (see `ChatInputActionsMenu`). */
export const projectNavKey = id => `project-${id}`;

/**
 * The "Projects" section of the chat input's "+" menu: a checkbox per
 * project. The answers can then use those projects' documents (loaded or
 * searched, as for the project a chat runs in) without the chat having been
 * started in them; their instructions do not apply. A chat that belongs to a
 * project from its first message is started from that project's page.
 *
 * @param {Object} props
 * @param {Object} props.projectContext - `{ chatId, stored, containerProjectId, value, onChange, disabled }`.
 * @param {Array<Object>} props.offered - From {@link useOfferedProjects}.
 * @param {(key: string) => 0|-1} props.navTabIndex - The menu's roving tab index.
 * @param {boolean} [props.divider=false] - A rule below, when another section follows.
 * @returns {JSX.Element|null}
 */
function ChatProjectsMenuSection({ projectContext, offered, navTabIndex, divider = false }) {
  const { t, i18n } = useTranslation();
  const { chatId, stored, value = [], onChange, disabled = false } = projectContext;
  const { toggle, saving, error, full } = useChatAttachedProjects({
    chatId,
    stored,
    value,
    onChange
  });
  if (offered.length === 0) return null;

  return (
    <div
      className={`p-3 ${divider ? 'border-b border-gray-200 dark:border-gray-700' : ''}`}
      data-testid="chat-projects-menu"
    >
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('projects.attach.title', 'Projects for this chat')}
      </h3>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {t(
          'projects.attach.hint',
          'The answers can use the documents of the projects you tick. Their instructions do not apply.'
        )}
      </p>
      <div className="max-h-40 overflow-y-auto">
        {offered.map(project => {
          const checked = value.includes(project.id);
          const blocked = disabled || saving || (!checked && full);
          const flip = () => {
            if (!blocked) void toggle(project.id);
          };
          return (
            <div
              key={project.id}
              role="menuitemcheckbox"
              aria-checked={checked}
              aria-disabled={blocked || undefined}
              tabIndex={navTabIndex(projectNavKey(project.id))}
              onClick={flip}
              onKeyDown={event => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  flip();
                }
              }}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset ${
                blocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                  checked
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-gray-300 dark:border-gray-500'
                }`}
              >
                {checked && <Icon name="check" size="xs" className="text-white" />}
              </span>
              <span className="truncate text-gray-800 dark:text-gray-100">
                {projectDisplayName(project, i18n.language)}
              </span>
            </div>
          );
        })}
      </div>
      {full && (
        <p className="pt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projects.attach.full', 'A chat can use at most {{max}} projects.', {
            max: MAX_ATTACHED_PROJECTS
          })}
        </p>
      )}
      {error && (
        <p role="alert" className="pt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export default ChatProjectsMenuSection;
