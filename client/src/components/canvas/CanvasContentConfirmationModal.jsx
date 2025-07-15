import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';

/**
 * Canvas Content Replacement Confirmation Modal
 * Shows a preview of both current and new content to help users make informed decisions
 */
const CanvasContentConfirmationModal = ({
  isOpen,
  currentContent,
  newContent,
  onConfirm,
  onCancel,
  onAppend,
  title
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  // Get text content for preview (without HTML tags)
  const getCurrentTextPreview = () => {
    const text = currentContent.replace(/<[^>]*>/g, '').trim();
    return text.length > 200 ? text.substring(0, 200) + '...' : text;
  };

  const getNewTextPreview = () => {
    const text = newContent.replace(/<[^>]*>/g, '').trim();
    return text.length > 200 ? text.substring(0, 200) + '...' : text;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {title || t('canvas.confirmReplaceTitle', 'Content Replacement Confirmation')}
          </h2>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="lg" />
          </button>
        </div>

        {/* Content Preview */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          <p className="text-gray-600 mb-6">
            {t(
              'canvas.confirmReplaceMessage',
              'You have existing content in your document. What would you like to do with the new content?'
            )}
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Current Content Preview */}
            <div className="border border-gray-200 rounded-lg">
              <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                <h3 className="font-medium text-gray-900 flex items-center">
                  <Icon name="document-text" size="sm" className="mr-2" />
                  {t('canvas.currentContent', 'Current Document')}
                </h3>
              </div>
              <div className="p-4">
                <div className="text-sm text-gray-700 bg-gray-50 rounded p-3 max-h-40 overflow-y-auto">
                  {getCurrentTextPreview() || t('canvas.emptyDocument', 'Empty document')}
                </div>
              </div>
            </div>

            {/* New Content Preview */}
            <div className="border border-blue-200 rounded-lg">
              <div className="bg-blue-50 px-4 py-2 border-b border-blue-200">
                <h3 className="font-medium text-blue-900 flex items-center">
                  <Icon name="plus-circle" size="sm" className="mr-2" />
                  {t('canvas.newContent', 'New Content')}
                </h3>
              </div>
              <div className="p-4">
                <div className="text-sm text-gray-700 bg-blue-50 rounded p-3 max-h-40 overflow-y-auto">
                  {getNewTextPreview()}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 p-6 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors"
          >
            {t('common.cancel', 'Cancel')}
          </button>

          <button
            onClick={onAppend}
            className="flex-1 px-4 py-2 text-blue-700 bg-blue-100 border border-blue-300 rounded-lg hover:bg-blue-200 font-medium transition-colors flex items-center justify-center"
          >
            <Icon name="plus" size="sm" className="mr-2" />
            {t('canvas.appendContent', 'Append Content')}
          </button>

          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 font-medium transition-colors flex items-center justify-center"
          >
            <Icon name="refresh" size="sm" className="mr-2" />
            {t('canvas.replaceContent', 'Replace Content')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CanvasContentConfirmationModal;
