// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { MAX_ATTACHED_PROJECTS } from '../hooks/useChatAttachedProjects';
import { useMyProjects, useProjectsAvailability } from '../hooks/useProjects';
import { isInMyProjects } from '../utils/projectView';
import ProjectPicker from './ProjectPicker';

/**
 * Hook: the projects the chat input's project picker offers for this chat —
 * the viewer's own and shared user projects and the projects they added from
 * the catalog, except the one the chat runs in. Empty while user projects
 * are off, when the chat takes no projects (`projectContext` is not given)
 * or its app opted out (`attachDisabled`). Loads the project list only for a
 * chat that has a `projectContext`.
 *
 * @param {{containerProjectId?: string|null, attachDisabled?: boolean}|null|undefined} projectContext
 * @returns {Array<Object>}
 */
export function useOfferedProjects(projectContext) {
  const { userProjectsEnabled } = useProjectsAvailability();
  const { projects } = useMyProjects({ enabled: Boolean(projectContext) });
  if (!projectContext || projectContext.attachDisabled || !userProjectsEnabled) return [];
  const containerId = projectContext.containerProjectId ?? null;
  return projects.filter(project => isInMyProjects(project) && project.id !== containerId);
}

/**
 * The project picker of the chat input: a "Project" button that opens a
 * searchable list of the offered projects to tick. The answers can then use
 * those projects' documents (loaded or searched, as for the project a chat
 * runs in) without the chat having been started in them; their instructions
 * do not apply. A chat that belongs to a project from its first message is
 * started from that project's page. The ticked projects show as chips beside
 * the button ({@link ChatProjectChips}).
 *
 * @param {Object} props
 * @param {Object} props.projectContext - `{ value, disabled, attached, … }`; `attached` is the
 *   chat page's one {@link useChatAttachedProjects}, shared with the chips so the two never
 *   race and a failure still shows after the picker has closed.
 * @param {Array<Object>} props.offered - From {@link useOfferedProjects}.
 * @returns {JSX.Element|null}
 */
function ChatProjectPicker({ projectContext, offered }) {
  const { t } = useTranslation();
  const { value = [], disabled = false, attached } = projectContext;
  const { toggle, saving, full } = attached;
  if (offered.length === 0) return null;
  const label = t('projects.attach.title', 'Projects for this chat');

  return (
    <ProjectPicker
      multiple
      placement="above"
      panelClassName="left-0 w-80 max-w-[calc(100vw-2rem)]"
      projects={offered}
      selectedIds={value}
      onPick={id => void toggle(id)}
      isDisabled={project => saving || (full && !value.includes(project.id))}
      disabled={disabled}
      label={label}
      hint={t(
        'projects.attach.hint',
        'The answers can use the documents of the projects you tick. Their instructions do not apply.'
      )}
      footer={
        full
          ? t('projects.attach.full', 'A chat can use at most {{max}} projects.', {
              max: MAX_ATTACHED_PROJECTS
            })
          : undefined
      }
      renderTrigger={({ open, triggerProps }) => (
        <button
          {...triggerProps}
          aria-label={label}
          title={label}
          data-testid="chat-project-picker"
          className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 ${
            open ? 'bg-gray-100 dark:bg-gray-700' : ''
          }`}
        >
          <Icon name="folder" size="sm" />
          <span className="hidden sm:inline">{t('projects.attach.button', 'Project')}</span>
          <Icon name="chevronDown" size="xs" className="text-gray-500 dark:text-gray-400" />
        </button>
      )}
    />
  );
}

export default ChatProjectPicker;
