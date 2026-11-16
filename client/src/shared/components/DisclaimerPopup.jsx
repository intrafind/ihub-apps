// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  acknowledgeDisclaimer,
  isDisclaimerAcknowledged
} from '../../utils/disclaimerAcknowledgement';

/**
 * The card of the disclaimer popup. Also drawn by Admin → Disclaimer as a preview,
 * where the button does nothing (`preview`).
 */
export function DisclaimerCard({
  disclaimer,
  currentLanguage,
  onAccept,
  acceptRef,
  preview = false
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg max-w-2xl w-full p-6 mx-4">
      <h2 id="disclaimer-title" className="text-xl font-bold mb-4 text-gray-900 dark:text-gray-100">
        {getLocalizedContent(disclaimer.title, currentLanguage) ||
          t('disclaimer.title', 'Disclaimer')}
      </h2>

      <div
        id="disclaimer-content"
        className="max-h-96 overflow-y-auto mb-4 text-gray-700 dark:text-gray-300"
      >
        <p>{getLocalizedContent(disclaimer.text, currentLanguage)}</p>

        {disclaimer.version && disclaimer.updated && (
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            {t('disclaimer.versionInfo', 'Version {{version}}, Last Updated: {{date}}', {
              version: disclaimer.version,
              date: disclaimer.updated
            })}
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          ref={acceptRef}
          type="button"
          onClick={onAccept}
          disabled={preview}
          className="px-4 py-2 bg-indigo-600 text-white rounded-sm hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {t('disclaimer.accept', 'I Understand')}
        </button>
      </div>
    </div>
  );
}

function DisclaimerPopup({ disclaimer, currentLanguage }) {
  const [isVisible, setIsVisible] = useState(false);
  const dialogRef = useRef(null);
  const acceptBtnRef = useRef(null);

  useFocusTrap(dialogRef, {
    isActive: isVisible,
    initialFocusRef: acceptBtnRef
  });

  useEffect(() => {
    // Show it when this browser has not confirmed the current version yet.
    if (disclaimer && !isDisclaimerAcknowledged(disclaimer)) {
      setIsVisible(true);
    }
  }, [disclaimer]);

  const handleAccept = () => {
    acknowledgeDisclaimer(disclaimer);
    setIsVisible(false);
    // The AI-use acknowledgement dialog queues behind this popup (#3326).
    window.dispatchEvent(new Event('ihub-disclaimer-closed'));
  };

  if (!isVisible) return null;

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="disclaimer-title"
      aria-describedby="disclaimer-content"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <DisclaimerCard
        disclaimer={disclaimer}
        currentLanguage={currentLanguage}
        onAccept={handleAccept}
        acceptRef={acceptBtnRef}
      />
    </div>
  );
}

export default DisclaimerPopup;
