import { useState } from 'react';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import { highlightVariables } from '../../../utils/highlightVariables';
import { buildPath } from '../../../utils/runtimeBasePath';
import { PromptAttribution, PromptScopeBadge } from './PromptMeta';

const secondaryButton =
  'px-3 py-1.5 text-sm border border-indigo-600 dark:border-indigo-400 text-indigo-600 dark:text-indigo-400 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/50 inline-flex items-center gap-1';

/**
 * A prompt's details and everything the caller may do with it. Which actions
 * show is decided by the `permissions` the server sent with the prompt.
 *
 * @param {Object} props
 * @param {Object} props.prompt - Localized prompt.
 * @param {() => void} props.onClose
 * @param {boolean} props.isFavorite
 * @param {(id: string) => void} props.onToggleFavorite
 * @param {(prompt: Object) => void} props.onUse - Open it in a chat.
 * @param {(prompt: Object) => Promise<boolean>} props.onCopy - Copy the filled-in text.
 * @param {(prompt: Object) => void} [props.onEdit]
 * @param {(prompt: Object) => void} [props.onShare]
 * @param {(prompt: Object) => void} [props.onDuplicate]
 * @param {(prompt: Object) => void} [props.onHistory]
 * @param {(prompt: Object) => void} [props.onDelete]
 * @param {Function} props.t
 */
function PromptModal({
  prompt,
  onClose,
  isFavorite,
  onToggleFavorite,
  onUse,
  onCopy,
  onEdit,
  onShare,
  onDuplicate,
  onHistory,
  onDelete,
  t
}) {
  const [copyStatus, setCopyStatus] = useState('idle');
  const [linkStatus, setLinkStatus] = useState('idle');

  if (!prompt) return null;
  const permissions = prompt.permissions || {};

  const flash = (setter, status) => {
    setter(status);
    setTimeout(() => setter('idle'), 2000);
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}${buildPath(`/prompts?id=${encodeURIComponent(prompt.id)}`)}`;
    try {
      await navigator.clipboard.writeText(url);
      flash(setLinkStatus, 'success');
    } catch (err) {
      console.error('Failed to copy share link:', err);
      flash(setLinkStatus, 'error');
    }
  };

  const handleCopy = async () => {
    const copied = await onCopy(prompt);
    if (copied !== null) flash(setCopyStatus, copied ? 'success' : 'error');
  };

  const statusIcon = (status, fallback) =>
    status === 'success' ? (
      <Icon name="check-circle" className="text-green-600" solid />
    ) : status === 'error' ? (
      <Icon name="exclamation-circle" className="text-red-600" solid />
    ) : (
      <Icon name={fallback} />
    );

  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="p-6 flex flex-col min-h-0">
        <div className="flex justify-between items-start mb-3 gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold flex items-center text-gray-900 dark:text-gray-100">
              <Icon name={prompt.icon || 'clipboard'} className="w-6 h-6 mr-2 shrink-0" />
              <span className="truncate">{prompt.name}</span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PromptScopeBadge prompt={prompt} />
              {prompt.appId && (
                <span className="px-1.5 py-0.5 text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/50 rounded-full">
                  {t('common.promptSearch.appSpecific', 'app')}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <Icon name="x" />
          </button>
        </div>
        {prompt.description && (
          <p className="text-gray-700 dark:text-gray-300 mb-3 whitespace-pre-line">
            {prompt.description}
          </p>
        )}
        <pre className="bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-3 rounded-sm whitespace-pre-wrap wrap-break-word mb-3 overflow-y-auto max-h-[40vh]">
          {highlightVariables(prompt.prompt)}
        </pre>
        <div className="mb-4">
          <PromptAttribution prompt={prompt} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => onUse(prompt)}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 inline-flex items-center gap-1"
          >
            <Icon name="chat-bubble" size="sm" />
            {t('prompts.actions.use', 'Use in chat')}
          </button>
          <button onClick={handleCopy} className={secondaryButton}>
            {statusIcon(copyStatus, 'copy')}
            <span>{t('pages.promptsList.copyPrompt', 'Copy')}</span>
          </button>
          {permissions.canEdit && onEdit && (
            <button onClick={() => onEdit(prompt)} className={secondaryButton}>
              <Icon name="pencil" size="sm" />
              {t('common.edit', 'Edit')}
            </button>
          )}
          {permissions.canShare && onShare && (
            <button onClick={() => onShare(prompt)} className={secondaryButton}>
              <Icon name="users" size="sm" />
              {t('prompts.actions.share', 'Share')}
            </button>
          )}
          {permissions.canDuplicate && onDuplicate && (
            <button onClick={() => onDuplicate(prompt)} className={secondaryButton}>
              <Icon name="document-duplicate" size="sm" />
              {t('prompts.actions.duplicate', 'Duplicate')}
            </button>
          )}
          {prompt.scope !== 'global' &&
            (permissions.canEdit || prompt.scope === 'mine') &&
            onHistory && (
              <button onClick={() => onHistory(prompt)} className={secondaryButton}>
                <Icon name="clock" size="sm" />
                {t('prompts.actions.history', 'History')}
              </button>
            )}
          <button
            onClick={() => onToggleFavorite(prompt.id)}
            className={secondaryButton}
            aria-label={
              isFavorite ? t('pages.promptsList.unfavorite') : t('pages.promptsList.favorite')
            }
            title={isFavorite ? t('pages.promptsList.unfavorite') : t('pages.promptsList.favorite')}
          >
            <Icon
              name="star"
              className={isFavorite ? 'text-yellow-500' : 'text-gray-600 dark:text-gray-400'}
              solid={isFavorite}
            />
          </button>
          <button
            onClick={handleCopyLink}
            className={secondaryButton}
            aria-label={t('prompts.actions.copyLink', 'Copy link')}
            title={t('prompts.actions.copyLink', 'Copy link')}
          >
            {statusIcon(linkStatus, 'link')}
          </button>
          {permissions.canDelete && onDelete && (
            <button
              onClick={() => onDelete(prompt)}
              className="px-3 py-1.5 text-sm border border-red-600 text-red-600 dark:border-red-400 dark:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 inline-flex items-center gap-1"
            >
              <Icon name="trash" size="sm" />
              {t('common.delete', 'Delete')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default PromptModal;
