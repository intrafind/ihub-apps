// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import ChatSharePanel from './ChatSharePanel';

/**
 * The share dialog for one generated file: a read-only link to that file
 * alone, with the same audiences, expiry and revoke as a chat link.
 *
 * @param {Object} props - Component properties.
 * @param {boolean} props.isOpen - Whether the dialog is shown.
 * @param {() => void} props.onClose - Close the dialog.
 * @param {string} props.chatId - The stored chat the file belongs to.
 * @param {{id: string, name?: string}|null} props.artifact - The file to share.
 * @returns {JSX.Element|null}
 */
export default function ArtifactShareDialog({ isOpen, onClose, chatId, artifact }) {
  const { t } = useTranslation();
  const titleRef = useRef(null);
  if (!artifact) return null;
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      initialFocusRef={titleRef}
    >
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2
          ref={titleRef}
          tabIndex={-1}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 outline-hidden"
        >
          {t('chatSharing.artifact.title', 'Share file')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <ChatSharePanel chatId={chatId} artifact={artifact} />
      </div>
    </Modal>
  );
}
