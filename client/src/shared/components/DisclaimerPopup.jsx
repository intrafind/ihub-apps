import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import { useFocusTrap } from '../hooks/useFocusTrap';

const DISCLAIMER_STORAGE_KEY = 'ihub-disclaimer-acknowledged';

function DisclaimerPopup({ disclaimer, currentLanguage }) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const dialogRef = useRef(null);
  const acceptBtnRef = useRef(null);

  useFocusTrap(dialogRef, {
    isActive: isVisible,
    initialFocusRef: acceptBtnRef
  });

  useEffect(() => {
    // Check if user has already seen the disclaimer
    const hasAcknowledgedDisclaimer = localStorage.getItem(DISCLAIMER_STORAGE_KEY);

    if (!hasAcknowledgedDisclaimer && disclaimer) {
      setIsVisible(true);
    }
  }, [disclaimer]);

  const handleAccept = () => {
    // Store in localStorage that user has seen the disclaimer
    localStorage.setItem(DISCLAIMER_STORAGE_KEY, 'true');
    setIsVisible(false);
  };

  if (!isVisible) return null;

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="disclaimer-title"
      aria-describedby="disclaimer-content"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    >
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full p-6 mx-4">
        <h2 id="disclaimer-title" className="text-xl font-bold mb-4">
          {getLocalizedContent(disclaimer.title, currentLanguage) ||
            t('disclaimer.title', 'Disclaimer')}
        </h2>

        <div id="disclaimer-content" className="max-h-96 overflow-y-auto mb-4 text-gray-700">
          <p>{getLocalizedContent(disclaimer.text, currentLanguage)}</p>

          {disclaimer.version && disclaimer.updated && (
            <p className="mt-4 text-sm text-gray-500">
              {t('disclaimer.versionInfo', 'Version {{version}}, Last Updated: {{date}}', {
                version: disclaimer.version,
                date: disclaimer.updated
              })}
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <button
            ref={acceptBtnRef}
            onClick={handleAccept}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors"
          >
            {t('disclaimer.accept', 'I Understand')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DisclaimerPopup;
