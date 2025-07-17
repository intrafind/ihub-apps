import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import pdf2md from '@opendocsg/pdf2md';
import Uploader from './Uploader';

/**
 * Lightweight wrapper for uploading text or PDF files.
 */
const FileUploader = ({ onFileSelect, disabled = false, fileData = null, config = {} }) => {
  const { t } = useTranslation();

  const MAX_FILE_SIZE_MB = config.maxFileSizeMB || 10;
  const SUPPORTED_TEXT_FORMATS = config.supportedTextFormats || [
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript'
  ];
  const SUPPORTED_PDF_FORMATS = config.supportedPdfFormats || ['application/pdf'];
  const ALL_SUPPORTED_FORMATS = [...SUPPORTED_TEXT_FORMATS, ...SUPPORTED_PDF_FORMATS];

  const getFileTypeDisplay = mimeType => {
    switch (mimeType) {
      case 'text/plain':
        return 'TXT';
      case 'text/markdown':
        return 'MD';
      case 'text/csv':
        return 'CSV';
      case 'application/json':
        return 'JSON';
      case 'text/html':
        return 'HTML';
      case 'text/css':
        return 'CSS';
      case 'text/javascript':
      case 'application/javascript':
        return 'JS';
      case 'application/pdf':
        return 'PDF';
      default:
        return 'FILE';
    }
  };

  const readTextFile = file => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('read-error'));
      reader.readAsText(file);
    });
  };

  const processFile = async file => {
    let content = '';
    let processedContent = '';

    if (SUPPORTED_PDF_FORMATS.includes(file.type)) {
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      processedContent = await pdf2md(uint8Array);
      content = processedContent;
    } else if (SUPPORTED_TEXT_FORMATS.includes(file.type)) {
      content = await readTextFile(file);
      processedContent = content;
    }

    const previewContent = content.length > 200 ? content.substring(0, 200) + '...' : content;

    return {
      preview: {
        fileName: file.name,
        fileType: getFileTypeDisplay(file.type),
        content: previewContent
      },
      data: {
        content: processedContent,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        displayType: getFileTypeDisplay(file.type)
      }
    };
  };

  const formatList = (() => {
    const textFormats = SUPPORTED_TEXT_FORMATS.map(format => {
      switch (format) {
        case 'text/plain':
          return 'TXT';
        case 'text/markdown':
          return 'MD';
        case 'text/csv':
          return 'CSV';
        case 'application/json':
          return 'JSON';
        case 'text/html':
          return 'HTML';
        case 'text/css':
          return 'CSS';
        case 'text/javascript':
        case 'application/javascript':
          return 'JS';
        case 'text/xml':
          return 'XML';
        default:
          return format;
      }
    });
    const pdfFormats = SUPPORTED_PDF_FORMATS.map(f => (f === 'application/pdf' ? 'PDF' : f));
    return [...new Set([...textFormats, ...pdfFormats])].join(', ');
  })();

  const getErrorMessage = code => {
    switch (code) {
      case 'file-too-large':
        return t('errors.fileTooLarge', {
          maxSize: MAX_FILE_SIZE_MB,
          defaultValue: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`
        });
      case 'unsupported-format':
        return t('errors.unsupportedFileFormat', {
          formats: formatList,
          defaultValue: `Unsupported file format. Please use: ${formatList}`
        });
      case 'read-error':
        return t('errors.readError', 'Error reading file');
      default:
        return t('errors.fileProcessingError', 'Error processing file. Please try again.');
    }
  };

  return (
    <Uploader
      accept={ALL_SUPPORTED_FORMATS}
      maxSizeMB={MAX_FILE_SIZE_MB}
      disabled={disabled}
      onSelect={onFileSelect}
      onProcessFile={processFile}
      data={fileData}
    >
      {({ preview, error, isProcessing, handleButtonClick, handleClear, inputProps }) => (
        <div className="file-uploader">
          <input {...inputProps} />
          {preview ? (
            <div className="relative mt-2 mb-4">
              <div className="relative rounded-lg overflow-hidden border border-gray-300 p-3 bg-gray-50">
                <div className="flex items-start gap-3">
                  <Icon name="document-text" className="w-8 h-8 text-blue-500 flex-shrink-0 mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-gray-900 truncate">
                      {preview.fileName}
                    </div>
                    <div className="text-xs text-gray-500 mb-2">{preview.fileType} file</div>
                    <div className="text-xs text-gray-700 bg-white p-2 rounded border max-h-20 overflow-y-auto">
                      {preview.content}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleClear}
                    className="bg-gray-800 bg-opacity-70 text-white rounded-full p-1 hover:bg-opacity-90 flex-shrink-0"
                    title={t('common.remove', 'Remove file')}
                  >
                    <Icon name="x" className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="text-xs text-gray-500 mt-1 text-center">
                {t('components.fileUploader.fileSelected', 'File selected and processed')}
              </div>
            </div>
          ) : (
            <div className="mt-2 mb-4">
              <button
                type="button"
                onClick={handleButtonClick}
                disabled={disabled || isProcessing}
                className={`flex items-center justify-center w-full p-3 border-2 border-dashed rounded-lg ${
                  disabled || isProcessing
                    ? 'border-gray-300 bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'border-gray-400 hover:border-indigo-500 hover:text-indigo-500'
                }`}
              >
                {isProcessing ? (
                  <>
                    <div className="animate-spin h-5 w-5 mr-2 flex items-center justify-center">
                      <Icon name="refresh" className="text-current" />
                    </div>
                    <span>{t('components.fileUploader.processing', 'Processing file...')}</span>
                  </>
                ) : (
                  <>
                    <Icon name="paper-clip" className="mr-2" />
                    <span>{t('components.fileUploader.uploadFile', 'Upload File')}</span>
                  </>
                )}
              </button>

              {error && <div className="text-red-500 text-sm mt-1">{getErrorMessage(error)}</div>}

              <div className="text-xs text-gray-500 mt-1 text-center">
                {t(
                  'components.fileUploader.supportedFormats',
                  'Supported: {{formats}} (max {{maxSize}}MB)',
                  {
                    formats: formatList,
                    maxSize: MAX_FILE_SIZE_MB
                  }
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Uploader>
  );
};

export default FileUploader;
