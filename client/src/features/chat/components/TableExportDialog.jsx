import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import useFocusTrap from '../../../shared/hooks/useFocusTrap';
import { exportTablesFromContent } from '../../../utils/tableExport';
import { extractMarkdownTables } from '../../../utils/markdownUtils';

function TableExportDialog({ isOpen, onClose, content }) {
  const { t } = useTranslation();

  const [selectedFormat, setSelectedFormat] = useState('csv');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [selectedTableIndex, setSelectedTableIndex] = useState(0);
  const [tables, setTables] = useState([]);

  const dialogRef = useRef(null);

  useFocusTrap(dialogRef, {
    isActive: isOpen,
    returnFocusOnDeactivate: true
  });

  // Extract tables when dialog opens
  useEffect(() => {
    if (isOpen && content) {
      const extractedTables = extractMarkdownTables(content);
      setTables(extractedTables);
      setSelectedTableIndex(0);
    }
  }, [isOpen, content]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape' && !isExporting) {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isExporting, onClose]);

  if (!isOpen) return null;

  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);

    try {
      const tableToExport = tables[selectedTableIndex];

      // Generate filename based on table content
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const baseFilename = `table-${timestamp}`;

      // Export based on selected format
      switch (selectedFormat) {
        case 'csv': {
          const { exportTableToCSV } = await import('../../../utils/tableExport');
          await exportTableToCSV(tableToExport, `${baseFilename}.csv`);
          break;
        }
        case 'xlsx': {
          const { exportTableToXLSX } = await import('../../../utils/tableExport');
          await exportTableToXLSX(tableToExport, `${baseFilename}.xlsx`);
          break;
        }
        case 'html': {
          const { exportTableToHTML } = await import('../../../utils/tableExport');
          await exportTableToHTML(tableToExport, `${baseFilename}.html`);
          break;
        }
        default:
          throw new Error(`Unsupported format: ${selectedFormat}`);
      }

      // Close dialog after successful export
      setTimeout(() => {
        onClose?.();
      }, 500);
    } catch (error) {
      console.error(`Export table to ${selectedFormat} failed:`, error);
      setExportError(error.message || 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const exportFormats = [
    {
      id: 'csv',
      name: t('pages.appChat.tableExport.formats.csv', 'CSV File'),
      icon: 'document-text',
      description: t('pages.appChat.tableExport.descriptions.csv', 'Comma-separated values')
    },
    {
      id: 'xlsx',
      name: t('pages.appChat.tableExport.formats.xlsx', 'Excel Spreadsheet'),
      icon: 'table-cells',
      description: t('pages.appChat.tableExport.descriptions.xlsx', 'Excel workbook')
    },
    {
      id: 'html',
      name: t('pages.appChat.tableExport.formats.html', 'HTML Table'),
      icon: 'code',
      description: t('pages.appChat.tableExport.descriptions.html', 'HTML table file')
    }
  ];

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-export-dialog-title"
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2
            id="table-export-dialog-title"
            className="text-xl font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('pages.appChat.tableExport.dialogTitle', 'Export Table')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            disabled={isExporting}
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x-mark" size="md" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Table Selection (if multiple tables) */}
          {tables.length > 1 && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                {t('pages.appChat.tableExport.selectTable', 'Select table to export')}
              </label>
              <div className="space-y-2">
                {tables.map((table, index) => (
                  <button
                    key={index}
                    onClick={() => setSelectedTableIndex(index)}
                    disabled={isExporting}
                    className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                      selectedTableIndex === index
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    } ${isExporting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                      {t('pages.appChat.tableExport.tableNumber', 'Table {{number}}', {
                        number: index + 1
                      })}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'pages.appChat.tableExport.tableDimensions',
                        '{{rows}} rows × {{columns}} columns',
                        {
                          rows: table.rows.length,
                          columns: table.headers.length
                        }
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Table Preview */}
          {tables.length > 0 && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                {t('pages.appChat.tableExport.preview', 'Preview')}
              </label>
              <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      {tables[selectedTableIndex].headers.map((header, index) => (
                        <th
                          key={index}
                          className="px-4 py-2 text-left text-xs font-medium text-gray-700 dark:text-gray-300 uppercase tracking-wider"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {tables[selectedTableIndex].rows.slice(0, 5).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className="px-4 py-2 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {tables[selectedTableIndex].rows.length > 5 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t('pages.appChat.tableExport.previewNote', 'Showing first 5 rows of {{total}}', {
                    total: tables[selectedTableIndex].rows.length
                  })}
                </p>
              )}
            </div>
          )}

          {/* Format Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('pages.appChat.tableExport.selectFormat', 'Select export format')}
            </label>
            <div className="grid grid-cols-1 gap-3">
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
            disabled={isExporting || !selectedFormat || tables.length === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isExporting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                {t('pages.appChat.tableExport.exporting', 'Exporting...')}
              </>
            ) : (
              <>
                <Icon name="download" size="sm" />
                {t('pages.appChat.tableExport.export', 'Export Table')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TableExportDialog;
