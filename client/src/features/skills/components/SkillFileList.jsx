import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * The files of a skill, read-only. Personal skills come with each file's
 * content, which can be expanded; global skills list paths only.
 *
 * @param {Object} props
 * @param {Array<{path: string, content?: string}|string>} [props.files] - The files, or their paths.
 * @param {string} [props.className] - Extra classes for the wrapper.
 */
function SkillFileList({ files, className = '' }) {
  const { t } = useTranslation();
  const list = (Array.isArray(files) ? files : [])
    .map(file => (typeof file === 'string' ? { path: file } : file))
    .filter(file => file?.path);
  if (list.length === 0) return null;

  return (
    <div className={className}>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
        {t('skills.details.files', 'Files')}
      </div>
      <ul className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
        {list.map(file => (
          <li key={file.path} className="text-sm">
            {typeof file.content === 'string' ? (
              <details>
                <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 text-gray-800 dark:text-gray-200">
                  <Icon name="document-text" size="sm" className="text-gray-500 shrink-0" />
                  <span className="font-mono truncate">{file.path}</span>
                </summary>
                <pre className="mx-3 mb-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-2 text-xs text-gray-800 dark:text-gray-200 whitespace-pre-wrap wrap-break-word max-h-64 overflow-y-auto">
                  {file.content}
                </pre>
              </details>
            ) : (
              <div className="px-3 py-2 flex items-center gap-2 text-gray-800 dark:text-gray-200">
                <Icon name="document-text" size="sm" className="text-gray-500 shrink-0" />
                <span className="font-mono truncate">{file.path}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SkillFileList;
