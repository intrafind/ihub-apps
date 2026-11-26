// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';

/**
 * What an import into a project did (`POST …/items/_import`): how many
 * documents were added and, for a ZIP archive, which entries were skipped and
 * why (the server's message per entry). Used by the "Copy to project" toast
 * and the upload form of a project page.
 *
 * @param {Object} props
 * @param {{added: number, skipped: Array<{name: string, code: string, message: string}>}}
 *   props.summary - `importSummary(result)`.
 * @param {string} [props.projectName] - Names the project in the first line.
 * @returns {JSX.Element}
 */
export default function ProjectImportSummary({ summary, projectName }) {
  const { t } = useTranslation();
  const { added, skipped } = summary;
  return (
    <div data-testid="project-import-summary">
      <p className="font-medium">
        {projectName
          ? t('projects.import.addedTo', '{{count}} documents added to {{project}}.', {
              count: added,
              project: projectName
            })
          : t('projects.import.added', '{{count}} documents added.', { count: added })}
      </p>
      {skipped.length > 0 && (
        <>
          <p className="mt-1">
            {t('projects.import.skipped', '{{count}} skipped:', { count: skipped.length })}
          </p>
          <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
            {skipped.map(entry => (
              <li key={`${entry.name}:${entry.code}`} className="break-words">
                {entry.message
                  ? t('projects.import.skippedEntry', '{{name}}: {{reason}}', {
                      name: entry.name,
                      reason: entry.message
                    })
                  : entry.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
