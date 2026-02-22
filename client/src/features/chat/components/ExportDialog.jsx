import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { exportChatToFormat } from '../../../api/endpoints/apps';
import {
  exportToXLSX,
  exportToCSV,
  exportToDOCX,
  exportToTXT,
  exportToPPTX
} from '../../../utils/exportFormats';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

const ExportDialog = ({ isOpen, onClose, messages = [], settings = {}, appId, chatId }) => {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const currentLanguage = i18n.language || 'en';
  const pdfExportEnabled = featureFlags.isEnabled('pdfExport', true);

  const [selectedFormat, setSelectedFormat] = useState('pdf');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  // PDF-specific configuration
  const [pdfConfig, setPdfConfig] = useState({
    template: 'default',
    watermark: {
      text: 'iHub Apps',
      position: 'bottom-right',
      opacity: 0.5
    }
  });

  if (!isOpen) return null;

  const buildMeta = () => ({
    model: settings.model,
    style: settings.style,
    outputFormat: settings.outputFormat,
    temperature: settings.temperature,
    variables: settings.variables
  });

  const getAppName = () => {
    return uiConfig?.title ? getLocalizedContent(uiConfig.title, currentLanguage) : 'iHub Apps';
  };

  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);

    try {
      const filteredMessages = messages.filter(m => !m.isGreeting);
      const exportSettings = buildMeta();
      const appName = getAppName();

      const options = {
        appId,
        chatId,
        appName
      };

      // Handle different export formats
      switch (selectedFormat) {
        case 'pdf':
          options.template = pdfConfig.template;
          options.watermark = pdfConfig.watermark;
          await exportChatToFormat(filteredMessages, exportSettings, 'pdf', options);
          break;
        case 'json':
          await exportChatToFormat(filteredMessages, exportSettings, 'json', options);
          break;
        case 'jsonl':
          await exportChatToFormat(filteredMessages, exportSettings, 'jsonl', options);
          break;
        case 'markdown':
          await exportChatToFormat(filteredMessages, exportSettings, 'markdown', options);
          break;
        case 'html':
          await exportChatToFormat(filteredMessages, exportSettings, 'html', options);
          break;
        case 'xlsx':
          await exportToXLSX(filteredMessages, exportSettings, appName, appId, chatId);
          break;
        case 'csv':
          await exportToCSV(filteredMessages, exportSettings, appName, appId, chatId);
          break;
        case 'docx':
          await exportToDOCX(filteredMessages, exportSettings, appName, appId, chatId);
          break;
        case 'txt':
          await exportToTXT(filteredMessages, exportSettings, appName, appId, chatId);
          break;
        case 'pptx':
          await exportToPPTX(filteredMessages, exportSettings, appName, appId, chatId);
          break;
        default:
          throw new Error(`Unsupported format: ${selectedFormat}`);
      }

      // Close dialog after successful export
      setTimeout(() => {
        onClose?.();
      }, 500);
    } catch (error) {
      console.error(`Export to ${selectedFormat} failed:`, error);
      setExportError(error.message || 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const exportFormats = [
    ...(pdfExportEnabled
      ? [
          {
            id: 'pdf',
            name: t('pages.appChat.export.formats.pdf', 'PDF Document'),
            icon: 'file-text',
            description: t(
              'pages.appChat.export.descriptions.pdf',
              'Formatted PDF with styling options'
            )
          }
        ]
      : []),
    {
      id: 'docx',
      name: t('pages.appChat.export.formats.docx', 'Word Document'),
      icon: 'document-text',
      description: t('pages.appChat.export.descriptions.docx', 'Microsoft Word document')
    },
    {
      id: 'pptx',
      name: t('pages.appChat.export.formats.pptx', 'PowerPoint'),
      icon: 'presentation-chart-bar',
      description: t(
        'pages.appChat.export.descriptions.pptx',
        'PowerPoint presentation with slides'
      )
    },
    {
      id: 'xlsx',
      name: t('pages.appChat.export.formats.xlsx', 'Excel Spreadsheet'),
      icon: 'table-cells',
      description: t(
        'pages.appChat.export.descriptions.xlsx',
        'Excel workbook with structured data'
      )
    },
    {
      id: 'csv',
      name: t('pages.appChat.export.formats.csv', 'CSV File'),
      icon: 'document-text',
      description: t('pages.appChat.export.descriptions.csv', 'Comma-separated values')
    },
    {
      id: 'txt',
      name: t('pages.appChat.export.formats.txt', 'Text File'),
      icon: 'document-text',
      description: t('pages.appChat.export.descriptions.txt', 'Plain text format')
    },
    {
      id: 'markdown',
      name: t('pages.appChat.export.formats.markdown', 'Markdown'),
      icon: 'code',
      description: t('pages.appChat.export.descriptions.markdown', 'Markdown formatted text')
    },
    {
      id: 'html',
      name: t('pages.appChat.export.formats.html', 'HTML'),
      icon: 'code',
      description: t('pages.appChat.export.descriptions.html', 'HTML document')
    },
    {
      id: 'json',
      name: t('pages.appChat.export.formats.json', 'JSON'),
      icon: 'code',
      description: t('pages.appChat.export.descriptions.json', 'JSON format with metadata')
    },
    {
      id: 'jsonl',
      name: t('pages.appChat.export.formats.jsonl', 'JSON Lines'),
      icon: 'code',
      description: t('pages.appChat.export.descriptions.jsonl', 'JSON Lines format')
    }
  ];

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('pages.appChat.export.dialogTitle', 'Export Conversation')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            disabled={isExporting}
          >
            <Icon name="x-mark" size="md" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Format Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('pages.appChat.export.selectFormat', 'Select export format')}
            </label>
            <div className="grid grid-cols-2 gap-3">
              {exportFormats.map(format => (
                <button
                  key={format.id}
                  onClick={() => setSelectedFormat(format.id)}
                  disabled={isExporting}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    selectedFormat === format.id
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                  } ${isExporting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div className="flex items-start gap-3">
                    <Icon
                      name={format.icon}
                      size="md"
                      className={
                        selectedFormat === format.id
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-gray-500'
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`font-medium mb-1 ${
                          selectedFormat === format.id
                            ? 'text-blue-900 dark:text-blue-100'
                            : 'text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {format.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {format.description}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* PDF Options */}
          {selectedFormat === 'pdf' && pdfExportEnabled && (
            <div className="space-y-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {t('pages.appChat.export.pdfOptions', 'PDF Options')}
              </h3>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('pages.appChat.export.template', 'Template')}
                </label>
                <select
                  value={pdfConfig.template}
                  onChange={e => setPdfConfig(prev => ({ ...prev, template: e.target.value }))}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  disabled={isExporting}
                >
                  <option value="default">
                    {t('pages.appChat.export.templateDefault', 'Default')}
                  </option>
                  <option value="professional">
                    {t('pages.appChat.export.templateProfessional', 'Professional')}
                  </option>
                  <option value="minimal">
                    {t('pages.appChat.export.templateMinimal', 'Minimal')}
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('pages.appChat.export.watermarkText', 'Watermark Text')}
                </label>
                <input
                  type="text"
                  value={pdfConfig.watermark.text}
                  onChange={e =>
                    setPdfConfig(prev => ({
                      ...prev,
                      watermark: { ...prev.watermark, text: e.target.value }
                    }))
                  }
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  placeholder={t(
                    'pages.appChat.export.watermarkPlaceholder',
                    'Enter watermark text'
                  )}
                  disabled={isExporting}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('pages.appChat.export.watermarkPosition', 'Position')}
                </label>
                <select
                  value={pdfConfig.watermark.position}
                  onChange={e =>
                    setPdfConfig(prev => ({
                      ...prev,
                      watermark: { ...prev.watermark, position: e.target.value }
                    }))
                  }
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  disabled={isExporting}
                >
                  <option value="bottom-right">
                    {t('pages.appChat.export.bottomRight', 'Bottom Right')}
                  </option>
                  <option value="bottom-left">
                    {t('pages.appChat.export.bottomLeft', 'Bottom Left')}
                  </option>
                  <option value="bottom-center">
                    {t('pages.appChat.export.bottomCenter', 'Bottom Center')}
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('pages.appChat.export.watermarkOpacity', 'Opacity')} (
                  {Math.round(pdfConfig.watermark.opacity * 100)}%)
                </label>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.1"
                  value={pdfConfig.watermark.opacity}
                  onChange={e =>
                    setPdfConfig(prev => ({
                      ...prev,
                      watermark: { ...prev.watermark, opacity: parseFloat(e.target.value) }
                    }))
                  }
                  className="w-full"
                  disabled={isExporting}
                />
              </div>
            </div>
          )}

          {/* Error Message */}
          {exportError && (
            <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start gap-2">
                <Icon
                  name="exclamation-circle"
                  size="sm"
                  className="text-red-600 dark:text-red-400 mt-0.5"
                />
                <div className="text-sm text-red-800 dark:text-red-200">{exportError}</div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isExporting}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !selectedFormat}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isExporting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                {t('pages.appChat.export.exporting', 'Exporting...')}
              </>
            ) : (
              <>
                <Icon name="download" size="sm" />
                {t('pages.appChat.export.export', 'Export')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
