import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * AI Disclaimer Modal Component
 * Modal dialog displaying the full AI disclaimer text
 */
const AIDisclaimerModal = ({ isOpen, onClose }) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg max-w-2xl w-full p-6 mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {t('disclaimer.aiDisclaimer.fullTitle', 'AI Disclaimer')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            title={t('common.close', 'Close')}
          >
            <Icon name="close" size="lg" />
          </button>
        </div>

        <div className="text-gray-700 dark:text-gray-300 space-y-4">
          <p>
            {t(
              'disclaimer.aiDisclaimer.fullText',
              'iHub uses artificial intelligence (AI) to generate responses. While we strive for accuracy, AI-generated content may contain errors, inaccuracies, or incomplete information. Please carefully review and verify all results before making decisions based on them. The use of AI-generated content is at your own risk.'
            )}
          </p>
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            {t('disclaimer.accept', 'I understand')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AIDisclaimerModal;
