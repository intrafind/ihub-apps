import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { fetchPromptVersions, restorePromptVersion } from '../../../api';
import { highlightVariables } from '../../../utils/highlightVariables';
import { promptErrorMessage } from '../utils/promptErrors';

/**
 * The saved revisions of a prompt, newest first. Restoring one saves it as a
 * new revision, so nothing in the history is ever lost.
 *
 * @param {Object} props
 * @param {Object} props.prompt - The user prompt.
 * @param {boolean} props.canRestore - Whether the caller may change the prompt.
 * @param {() => void} props.onClose
 * @param {(prompt: Object) => void} props.onRestored
 */
function PromptVersionsModal({ prompt, canRestore, onClose, onRestored }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let active = true;
    fetchPromptVersions(prompt.id)
      .then(result => {
        if (!active) return;
        setData(result);
        setSelected(result?.versions?.[0]?.revision ?? null);
      })
      .catch(err => active && setError(promptErrorMessage(err, t)));
    return () => {
      active = false;
    };
  }, [prompt.id, t]);

  const versions = data?.versions || [];
  const current = versions.find(version => version.revision === selected);
  const formatDate = value => (value ? new Date(value).toLocaleString(i18n.language) : '');

  const restore = async () => {
    if (!current) return;
    setRestoring(true);
    setError(null);
    try {
      const restored = await restorePromptVersion(prompt.id, current.revision);
      onRestored?.(restored);
    } catch (err) {
      setError(promptErrorMessage(err, t));
      setRestoring(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-4xl">
      <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('prompts.history.title', 'Version history')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{prompt.name}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Icon name="x" />
        </button>
      </div>

      {!data && !error ? (
        <div className="p-8">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="grid md:grid-cols-[16rem_1fr] min-h-0 overflow-hidden">
          <ul
            className="border-r border-gray-200 dark:border-gray-700 overflow-y-auto max-h-[60vh]"
            aria-label={t('prompts.history.versions', 'Versions')}
          >
            {versions.map(version => (
              <li key={version.revision}>
                <button
                  type="button"
                  onClick={() => setSelected(version.revision)}
                  aria-current={version.revision === selected || undefined}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-700 ${
                    version.revision === selected
                      ? 'bg-indigo-50 dark:bg-indigo-900/40'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('prompts.history.revision', {
                      defaultValue: 'Version {{revision}}',
                      revision: version.revision
                    })}
                    {version.revision === data.revision && (
                      <span className="ml-2 text-xs text-indigo-600 dark:text-indigo-400">
                        {t('prompts.history.current', 'current')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDate(version.savedAt)}
                    {version.savedBy ? ` · ${version.savedBy}` : ''}
                  </div>
                  {version.restoredFrom && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('prompts.history.restoredFrom', {
                        defaultValue: 'Restored from version {{revision}}',
                        revision: version.restoredFrom
                      })}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="p-5 overflow-y-auto max-h-[60vh]">
            {current && (
              <>
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">{current.name}</h3>
                {current.description && (
                  <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                    {current.description}
                  </p>
                )}
                <pre className="mt-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap wrap-break-word">
                  {highlightVariables(current.prompt)}
                </pre>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="px-5 pb-2 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          {t('common.close', 'Close')}
        </button>
        {canRestore && current && current.revision !== data?.revision && (
          <button
            type="button"
            onClick={restore}
            disabled={restoring}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('prompts.history.restore', 'Restore this version')}
          </button>
        )}
      </div>
    </Modal>
  );
}

export default PromptVersionsModal;
