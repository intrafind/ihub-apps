import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useClipboard } from '../../../shared/hooks/useClipboard';

const ExportMenu = ({ content, onClose }) => {
  const { t } = useTranslation();
  const { copyText, copyMarkdown, copyHTML, isLoading } = useClipboard();

  const handleCopyText = async () => {
    await copyText(content);
    onClose();
  };

  const handleCopyMarkdown = async () => {
    await copyMarkdown(content);
    onClose();
  };

  const handleCopyHTML = async () => {
    await copyHTML(content);
    onClose();
  };

  const handlePrintPDF = () => {
    // Open print dialog for PDF export
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Document</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 40px 20px; }
            h1 { font-size: 2rem; margin-bottom: 1rem; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
            h2 { font-size: 1.5rem; margin: 1.5rem 0 0.75rem; }
            h3 { font-size: 1.25rem; margin: 1rem 0 0.5rem; }
            p { margin-bottom: 1rem; }
            ul, ol { margin-bottom: 1rem; padding-left: 1.5rem; }
            blockquote { border-left: 4px solid #6366f1; margin: 1rem 0; padding: 0.5rem 0 0.5rem 1rem; background: #f8fafc; font-style: italic; }
            code { background: #f1f5f9; padding: 0.125rem 0.25rem; border-radius: 3px; font-family: Monaco, Menlo, monospace; }
          </style>
        </head>
        <body>${content}</body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
    onClose();
  };

  return (
    <div className="absolute top-full right-0 mt-2 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-56">
      <div className="p-2">
        <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {t('canvas.export.copyOptions', 'Copy Options')}
        </div>
        <button
          onClick={handleCopyText}
          className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded flex items-center gap-2 transition-colors whitespace-nowrap"
        >
          <Icon name="document-text" size="sm" />
          {t('canvas.export.copyText', 'as Text')}
        </button>
        <button
          onClick={handleCopyMarkdown}
          className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded flex items-center gap-2 transition-colors whitespace-nowrap"
        >
          <Icon name="code" size="sm" />
          {t('canvas.export.copyMarkdown', 'as Markdown')}
        </button>
        <button
          onClick={handleCopyHTML}
          className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded flex items-center gap-2 transition-colors whitespace-nowrap"
        >
          <Icon name="code" size="sm" />
          {t('canvas.export.copyHTML', 'as HTML')}
        </button>

        <hr className="my-2" />

        <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {t('canvas.export.downloadOptions', 'Download Options')}
        </div>
        <button
          onClick={handlePrintPDF}
          className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded flex items-center gap-2 transition-colors"
        >
          <Icon name="printer" size="sm" />
          {t('canvas.export.printPDF', 'Print as PDF')}
        </button>
      </div>
    </div>
  );
};

export default ExportMenu;
