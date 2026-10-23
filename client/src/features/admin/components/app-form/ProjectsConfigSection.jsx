// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import ProjectPicker from '../ProjectPicker';

/**
 * ProjectsConfigSection - the card of the app editor for projects in a chat
 * app (#1036): whether the app uses projects at all (`features.projects`),
 * whether it takes personal ones (`features.userProjects`) — both on unless
 * set to `false` — and the admin projects linked to it (`app.projects`).
 * Only rendered when the projects feature flag is enabled (checked by the
 * caller).
 *
 * @component
 * @param {Object} props
 * @param {Object} props.app - The app configuration being edited.
 * @param {(app: Object) => void} props.onChange - Receives the whole updated app.
 * @param {Function} props.t - i18n translation function.
 * @returns {JSX.Element}
 */
function ProjectsConfigSection({ app, onChange, t }) {
  const projectsOn = app.features?.projects !== false;
  const userProjectsOn = app.features?.userProjects !== false;

  const handleProjectsChange = links => {
    onChange({ ...app, projects: links });
  };

  const setFeature = (key, enabled) => {
    onChange({ ...app, features: { ...app.features, [key]: enabled } });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.projects', 'Projects')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.projectsDesc',
              'Link admin projects whose knowledge this app uses. Choose per project whether it is loaded into the prompt, searched with tools, or decided automatically by size.'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0 space-y-4">
          <div>
            <div className="flex items-center">
              <input
                id="app-projects-enabled"
                type="checkbox"
                checked={projectsOn}
                onChange={e => setFeature('projects', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded-sm"
              />
              <label
                htmlFor="app-projects-enabled"
                className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
              >
                {t('admin.apps.edit.projectsEnabled', 'Use projects in this app')}
              </label>
            </div>
            <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.apps.edit.projectsEnabledNote',
                'When off, the app uses no project: neither the linked ones below nor chats started in a project or projects attached in the chat.'
              )}
            </p>
          </div>
          <div>
            <div className="flex items-center">
              <input
                id="app-user-projects-enabled"
                type="checkbox"
                checked={projectsOn && userProjectsOn}
                disabled={!projectsOn}
                onChange={e => setFeature('userProjects', e.target.checked)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded-sm disabled:opacity-50"
              />
              <label
                htmlFor="app-user-projects-enabled"
                className={`ml-2 block text-sm ${projectsOn ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}
              >
                {t('admin.apps.edit.userProjectsEnabled', 'Allow personal projects')}
              </label>
            </div>
            <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.apps.edit.userProjectsEnabledNote',
                'Users can start chats of this app in their own projects and attach them in the chat. The platform-level personal projects feature must also be enabled.'
              )}
            </p>
          </div>
          {projectsOn && (
            <ProjectPicker value={app.projects || []} onChange={handleProjectsChange} />
          )}
        </div>
      </div>
    </div>
  );
}

export default ProjectsConfigSection;
