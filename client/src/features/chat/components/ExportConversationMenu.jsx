import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { exportChatToFormat } from '../../../api/endpoints/apps';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { getLocalizedContent } from '../../../utils/localizeContent';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

const ExportConversationMenu = ({ messages = [], settings = {}, onClose, appId, chatId }) => {
  const { t, i18n } = useTranslation();
  const { uiConfig } = useUIConfig();
  const featureFlags = useFeatureFlags();
  const currentLanguage = i18n.language || 'en';
  const pdfExportEnabled = featureFlags.isEnabled('pdfExport', true);
  const [showPdfOptions, setShowPdfOptions] = useState(false);
  const [pdfConfig, setPdfConfig] = useState({
    template: 'default',
    watermark: {
      text: 'iHub Apps',
      position: 'bottom-right',
      opacity: 0.5
    }
  });
  const [isExporting, setIsExporting] = useState(false);

  const buildMeta = () => ({
    model: settings.model,
    style: settings.style,
    outputFormat: settings.outputFormat,
    temperature: settings.temperature,
    variables: settings.variables
  });

  const handleExport = async format => {
    if (format === 'pdf') {
      setIsExporting(true);
    }

    try {
      const filteredMessages = messages.filter(m => !m.isGreeting);
      const exportSettings = buildMeta();

      // Get app name for better file naming
      const appName = uiConfig?.title
        ? getLocalizedContent(uiConfig.title, currentLanguage)
        : 'iHub Apps';

      // Prepare export options
      const options = {
        appId,
        chatId,
        appName
      };

      // Add PDF-specific configuration if exporting to PDF
      if (format === 'pdf') {
        options.template = pdfConfig.template;
        options.watermark = pdfConfig.watermark;
      }

      await exportChatToFormat(filteredMessages, exportSettings, format, options);
      onClose?.();
    } catch (error) {
      console.error(`${format.toUpperCase()} export failed:`, error);
      // TODO: Add proper error notification
    } finally {
      if (format === 'pdf') {
        setIsExporting(false);
      }
    }
  };

  return (
    <div className="absolute right-full top-0 mr-2 bg-white border border-gray-200 rounded shadow-lg z-20">
      {/* PDF Export with Options - only shown when pdfExport feature is enabled */}
      {pdfExportEnabled && (
        <>
          <div className="relative">
            <button
              onClick={() => setShowPdfOptions(!showPdfOptions)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center justify-between gap-2 whitespace-nowrap"
              disabled={isExporting}
            >
              <div className="flex items-center gap-2">
                <Icon name="file-text" size="sm" />
                {isExporting
                  ? t('pages.appChat.export.exportingPDF', 'Exporting PDF...')
                  : t('pages.appChat.export.toPDF', 'as PDF')}
              </div>
              <Icon
                name="chevron-right"
                size="sm"
                className={`transition-transform ${showPdfOptions ? 'rotate-90' : ''}`}
              />
            </button>

            {showPdfOptions && (
              <div className="absolute right-full top-0 mr-2 bg-white border border-gray-200 rounded shadow-lg min-w-[300px] p-3 z-30">
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      {t('pages.appChat.export.template', 'Template')}
                    </label>
                    <select
                      value={pdfConfig.template}
                      onChange={e => setPdfConfig(prev => ({ ...prev, template: e.target.value }))}
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1"
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
                    <label className="block text-xs font-medium text-gray-700 mb-1">
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
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1"
                      placeholder="Enter watermark text"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
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
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1"
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
                    <label className="block text-xs font-medium text-gray-700 mb-1">
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
                    />
                  </div>

                  <div className="pt-2 border-t border-gray-200">
                    <button
                      onClick={() => handleExport('pdf')}
                      disabled={isExporting}
                      className="w-full bg-blue-600 text-white text-sm px-3 py-2 rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                    >
                      {isExporting
                        ? t('pages.appChat.export.generating', 'Generating...')
                        : t('pages.appChat.export.generatePDF', 'Generate PDF')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-gray-200"></div>
        </>
      )}

      <button
        onClick={() => handleExport('json')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.export.toJSON', 'as JSON')}
      </button>
      <button
        onClick={() => handleExport('jsonl')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.export.toJSONL', 'as JSONL')}
      </button>
      <button
        onClick={() => handleExport('markdown')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.export.toMarkdown', 'as Markdown')}
      </button>
      <button
        onClick={() => handleExport('html')}
        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 whitespace-nowrap"
      >
        <Icon name="code" size="sm" /> {t('pages.appChat.export.toHTML', 'as HTML')}
      </button>
    </div>
  );
};

export default ExportConversationMenu;
