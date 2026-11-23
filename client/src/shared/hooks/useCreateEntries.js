// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useUIConfig } from '../contexts/UIConfigContext';
import { usePlatformConfig } from '../contexts/PlatformConfigContext';
import useFeatureFlags from './useFeatureFlags';
import { useUserAppsConfig } from './useUserApps';
import {
  useCanCreateScheduledTasks,
  useScheduledTasksAvailable
} from '../../features/tasks/hooks/useScheduledTasks';
import {
  useProjectsAvailability,
  useProjectsConfig
} from '../../features/projects/hooks/useProjects';
import { projectCreation } from '../../features/projects/utils/projectView';
import { CREATE_INTENT } from '../../utils/createIntent';

/**
 * The things the signed-in viewer may create from the sidebar's "Create" menu,
 * in menu order. Each entry is gated exactly like the create button of its own
 * page, so the menu never offers what that page would refuse:
 *
 * - **App**: the "New app" button of the apps list (`userApps` feature, signed in,
 *   `canCreate` from `/api/user-apps/_config`) → `/apps/new`.
 * - **Project**: the "New project" button of `/projects` (user projects on,
 *   `canCreate` from `/api/projects/_config`, below the project limit; the same
 *   `projectCreation()` the page uses) → `/projects`, which opens its dialog.
 * - **Skill**: the library's "New skill" (`skills` feature, personal skills on,
 *   signed in, the library itself on) → `/prompts`, which opens the skill editor.
 * - **Prompt**: the library's "New prompt" (personal prompts on, signed in, the
 *   library on) → `/prompts`, which opens the prompt editor.
 * - **Scheduled task**: the tasks page (`scheduledTasks` on, the permission) → `/tasks/new`.
 *
 * Workflows and agents have no create flow for users (only admin pages), so
 * they are not entries.
 *
 * @returns {Array<{id: string, icon: string, label: string, to: string, state?: Object}>}
 */
export default function useCreateEntries() {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig() || {};
  const featureFlags = useFeatureFlags();

  const userApps = useUserAppsConfig();
  const canCreateApp = userApps.enabled && userApps.config?.canCreate === true;

  const { userProjectsEnabled } = useProjectsAvailability();
  const { config: projectsConfig } = useProjectsConfig();
  // The page drops the create request at the project limit, so the entry is
  // hidden there too rather than leading to a page that silently does nothing.
  const canCreateProject = userProjectsEnabled && projectCreation(projectsConfig).allowed;

  // Same gate as the /prompts route in App.jsx: prompts and skills live there.
  const libraryEnabled =
    uiConfig?.promptsList?.enabled !== false && featureFlags.isEnabled('promptsLibrary', true);
  const canCreatePrompt =
    libraryEnabled && isAuthenticated === true && platformConfig?.userPrompts?.enabled === true;
  const canCreateSkill =
    libraryEnabled &&
    featureFlags.isEnabled('skills', false) &&
    isAuthenticated === true &&
    platformConfig?.userSkills?.enabled === true;

  const tasksAvailable = useScheduledTasksAvailable();
  const canCreateTasks = useCanCreateScheduledTasks();
  const canCreateTask = tasksAvailable && canCreateTasks;

  return [
    canCreateApp && {
      id: 'app',
      icon: 'squares-2x2',
      label: t('sidebar.create.app', 'App'),
      to: '/apps/new'
    },
    canCreateProject && {
      id: 'project',
      icon: 'folder',
      label: t('sidebar.create.project', 'Project'),
      to: '/projects',
      state: { create: CREATE_INTENT.project }
    },
    canCreateSkill && {
      id: 'skill',
      icon: 'sparkles',
      label: t('sidebar.create.skill', 'Skill'),
      to: '/prompts',
      state: { create: CREATE_INTENT.skill }
    },
    canCreatePrompt && {
      id: 'prompt',
      icon: 'clipboard',
      label: t('sidebar.create.prompt', 'Prompt'),
      to: '/prompts',
      state: { create: CREATE_INTENT.prompt }
    },
    canCreateTask && {
      id: 'task',
      icon: 'calendar',
      label: t('sidebar.create.task', 'Scheduled task'),
      to: '/tasks/new'
    }
  ].filter(Boolean);
}
