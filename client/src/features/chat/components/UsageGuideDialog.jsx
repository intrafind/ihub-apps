import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import StreamingMarkdown from './StreamingMarkdown';

/**
 * An app's usage guide in a dialog (issue #2838), for the start form and
 * compare mode, which have no single transcript to answer in. The shared
 * `Modal` traps focus, closes on Escape and returns focus to the button.
 *
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {string} props.question - Shown as the dialog's heading.
 * @param {string} props.content - The guide's markdown.
 * @param {Function} props.onClose
 */
function UsageGuideDialog({ isOpen, question, content, onClose }) {
  const { t } = useTranslation();
  const headingId = useId();
  const closeRef = useRef(null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      initialFocusRef={closeRef}
      labelledBy={headingId}
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 px-5 py-3">
        <h2 id={headingId} className="font-semibold text-gray-900 dark:text-gray-100">
          {question}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
          aria-label={t('common.close', 'Close')}
        >
          <Icon name="close" size="sm" aria-hidden="true" />
        </button>
      </div>
      {/* The chat's own markdown renderer (sanitized), so the guide reads the
          same here as in the chat. */}
      <div className="overflow-y-auto px-6 py-5">
        <StreamingMarkdown content={content || ''} />
      </div>
    </Modal>
  );
}

export default UsageGuideDialog;
