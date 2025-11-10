import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Uploader from './Uploader';

// Lazy load PDF.js only when needed
const loadPdfjs = async () => {
  const pdfjsLib = await import('pdfjs-dist');
  // Configure PDF.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  return pdfjsLib;
};

// Lazy load Mammoth only when needed
const loadMammoth = async () => {
  const mammoth = await import('mammoth');
  return mammoth;
};

// Lazy load MSGReader only when needed
const loadMsgReader = async () => {
  const MsgReader = await import('@kenjiuno/msgreader');
  return MsgReader;
};

// Lazy load JSZip only when needed for OpenOffice formats
const loadJSZip = async () => {
  const JSZip = await import('jszip');
  return JSZip.default;
};

/**
 * Lightweight wrapper for uploading text, PDF, DOCX, MSG, EML, and OpenOffice files.
 */
const FileUploader = ({ onFileSelect, disabled = false, fileData = null, config = {} }) => {
  const { t } = useTranslation();

  const MAX_FILE_SIZE_MB = config.maxFileSizeMB || 10;
  const SUPPORTED_FORMATS = config.supportedFormats || [
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    'text/xml',
    'message/rfc822',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-outlook',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation'
  ];

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
      case 'text/xml':
        return 'XML';
      case 'message/rfc822':
        return 'EML';
      case 'application/pdf':
        return 'PDF';
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return 'DOCX';
      case 'application/vnd.ms-outlook':
        return 'MSG';
      case 'application/vnd.oasis.opendocument.text':
        return 'ODT';
      case 'application/vnd.oasis.opendocument.spreadsheet':
        return 'ODS';
      case 'application/vnd.oasis.opendocument.presentation':
        return 'ODP';
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

    // Determine processing method based on MIME type
    if (file.type === 'application/pdf') {
      // PDF processing
      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = await loadPdfjs();
      const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
      let textContent = '';

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContentPage = await page.getTextContent();
        const textItems = textContentPage.items.map(item => item.str).join(' ');
        textContent += textItems + '\n';
      }

      processedContent = textContent.trim();
      content = processedContent;
    } else if (
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      // DOCX processing
      const arrayBuffer = await file.arrayBuffer();
      const mammoth = await loadMammoth();
      const result = await mammoth.convertToHtml({ arrayBuffer });

      // Extract plain text from HTML for better readability
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = result.value;
      processedContent = tempDiv.textContent || tempDiv.innerText || '';
      content = processedContent;
    } else if (file.type === 'application/vnd.ms-outlook') {
      // MSG processing
      const arrayBuffer = await file.arrayBuffer();
      const MsgReader = await loadMsgReader();
      const msgReader = new MsgReader.default(arrayBuffer);
      const fileData = msgReader.getFileData();

      // Extract text content from MSG file
      let textContent = '';
      if (fileData.subject) {
        textContent += `Subject: ${fileData.subject}\n\n`;
      }
      if (fileData.senderName) {
        textContent += `From: ${fileData.senderName}`;
        if (fileData.senderEmail) {
          textContent += ` <${fileData.senderEmail}>`;
        }
        textContent += '\n';
      }
      if (fileData.recipients && fileData.recipients.length > 0) {
        textContent += `To: ${fileData.recipients.map(r => r.name || r.email).join(', ')}\n`;
      }
      if (fileData.body) {
        textContent += `\n${fileData.body}`;
      }

      processedContent = textContent.trim();
      content = processedContent;
    } else if (
      file.type === 'application/vnd.oasis.opendocument.text' ||
      file.type === 'application/vnd.oasis.opendocument.spreadsheet' ||
      file.type === 'application/vnd.oasis.opendocument.presentation'
    ) {
      // OpenOffice/LibreOffice format processing
      const arrayBuffer = await file.arrayBuffer();
      const JSZip = await loadJSZip();
      const zip = await JSZip.loadAsync(arrayBuffer);

      // Extract content.xml which contains the text content
      const contentXml = await zip.file('content.xml')?.async('string');

      if (contentXml) {
        // Parse XML and extract text content
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(contentXml, 'text/xml');

        // Extract all text nodes
        const extractText = node => {
          let text = '';
          if (node.nodeType === Node.TEXT_NODE) {
            text = node.textContent;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Add line breaks for paragraphs
            if (node.nodeName === 'text:p' || node.nodeName === 'text:h') {
              text = '\n';
            }
            for (const child of node.childNodes) {
              text += extractText(child);
            }
            if (node.nodeName === 'text:p' || node.nodeName === 'text:h') {
              text += '\n';
            }
          }
          return text;
        };

        processedContent = extractText(xmlDoc.documentElement).trim();
        content = processedContent;
      } else {
        throw new Error('Unable to extract content from OpenOffice document');
      }
    } else {
      // Text file processing (default for all other supported formats)
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
    const displayFormats = SUPPORTED_FORMATS.map(format => {
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
        case 'message/rfc822':
          return 'EML';
        case 'application/pdf':
          return 'PDF';
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          return 'DOCX';
        case 'application/vnd.ms-outlook':
          return 'MSG';
        case 'application/vnd.oasis.opendocument.text':
          return 'ODT';
        case 'application/vnd.oasis.opendocument.spreadsheet':
          return 'ODS';
        case 'application/vnd.oasis.opendocument.presentation':
          return 'ODP';
        default:
          return format;
      }
    });
    return [...new Set(displayFormats)].join(', ');
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
      accept={SUPPORTED_FORMATS}
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
