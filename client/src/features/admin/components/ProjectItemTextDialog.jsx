// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { fetchAdminProjectItemText, getAdminApiErrorMessage } from '../../../api/adminApi';
import { ITEM_TEXT_PREVIEW_CHARS } from '../utils/projectAdmin';

/**
 * Shows the plain text the model gets from one item: the extracted text of
 * a stored item, or the live content of a linked one. At most
 * {@link ITEM_TEXT_PREVIEW_CHARS} characters are loaded.
 *
 * @param {Object} props
 * @param {string} props.projectId
 * @param {Object|null} props.item - The item to preview; `null` closes the dialog.
 * @param {() => void} props.onClose
 * @returns {JSX.Element|null}
 */
function ProjectItemTextDialog({ projectId, item, onClose }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: false, text: '', chars: null, error: null });

  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;
    setState({ loading: true, text: '', chars: null, truncated: false, error: null });
    fetchAdminProjectItemText(projectId, item.id, { maxChars: ITEM_TEXT_PREVIEW_CHARS })
      .then(result => {
        if (!cancelled) setState({ loading: false, ...result, error: null });
      })
      .catch(err => {
        if (!cancelled) {
          setState({
            loading: false,
            text: '',
            chars: null,
            truncated: false,
            error: getAdminApiErrorMessage(err)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, item]);

  return (
    <Modal
      isOpen={Boolean(item)}
      onClose={onClose}
      maxWidthClassName="max-w-4xl"
      labelledBy="project-item-text-title"
    >
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3">
        <h3
          id="project-item-text-title"
          className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate"
        >
          {t('admin.projects.preview.title', 'Text of "{{name}}"', { name: item?.name ?? '' })}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>
      <div className="p-6 overflow-y-auto">
        {state.loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
        {!state.loading && !state.error && (
          <>
            {state.truncated && (
              <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
                {t(
                  'admin.projects.preview.truncated',
                  'Showing the first {{shown}} of {{total}} characters.',
                  {
                    shown: ITEM_TEXT_PREVIEW_CHARS.toLocaleString(),
                    total: (state.chars ?? 0).toLocaleString()
                  }
                )}
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded-md p-4 border border-gray-200 dark:border-gray-700">
              {state.text || t('admin.projects.preview.empty', '(no text)')}
            </pre>
          </>
        )}
      </div>
    </Modal>
  );
}

export default ProjectItemTextDialog;
