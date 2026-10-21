// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import ProjectPicker from '../ProjectPicker';

/**
 * ProjectsConfigSection - the card of the app editor that links admin
 * projects to a chat app (`app.projects`, #1036). Only rendered when the
 * projects feature flag is enabled (checked by the caller).
 *
 * @component
 * @param {Object} props
 * @param {Object} props.app - The app configuration being edited.
 * @param {(app: Object) => void} props.onChange - Receives the whole updated app.
 * @param {Function} props.t - i18n translation function.
 * @returns {JSX.Element}
 */
function ProjectsConfigSection({ app, onChange, t }) {
  const handleProjectsChange = links => {
    onChange({ ...app, projects: links });
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
        <div className="mt-5 md:col-span-2 md:mt-0">
          <ProjectPicker value={app.projects || []} onChange={handleProjectsChange} />
        </div>
      </div>
    </div>
  );
}

export default ProjectsConfigSection;
