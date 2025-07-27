import React from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import pdf2md from '@opendocsg/pdf2md';
import Uploader from './Uploader';
import '../components/ImageUpload.css';

/**
 * Unified uploader component that handles both images and files in a single interface.
 * Automatically detects file type and applies appropriate processing.
 */
const UnifiedUploader = ({ onFileSelect, disabled = false, fileData = null, config = {} }) => {
  const { t } = useTranslation();

  // Image upload configuration
  const imageConfig = config.imageUpload || {};
  const isImageUploadEnabled = imageConfig.enabled !== false && config.imageUploadEnabled !== false;

  // File upload configuration
  const fileConfig = config.fileUpload || {};
  const isFileUploadEnabled = fileConfig.enabled !== false && config.fileUploadEnabled !== false;

  // Configuration with defaults
  const MAX_FILE_SIZE_MB =
    config.maxFileSizeMB ||
    Math.max(imageConfig.maxFileSizeMB || 0, fileConfig.maxFileSizeMB || 0) ||
    10;

  // Image-specific configuration
  const IMAGE_FORMATS = isImageUploadEnabled
    ? imageConfig.supportedFormats ||
      config.supportedImageFormats || [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp'
      ]
    : [];
  const RESIZE_IMAGES = imageConfig.resizeImages !== false && config.resizeImages !== false;
  const MAX_DIMENSION = imageConfig.maxResizeDimension || config.maxResizeDimension || 1024;

  // File-specific configuration
  const TEXT_FORMATS = isFileUploadEnabled
    ? fileConfig.supportedTextFormats ||
      config.supportedTextFormats || [
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/json',
        'text/html',
        'text/css',
        'text/javascript',
        'application/javascript'
      ]
    : [];
  const PDF_FORMATS = isFileUploadEnabled
    ? fileConfig.supportedPdfFormats || config.supportedPdfFormats || ['application/pdf']
    : [];

  // All supported formats combined
  const ALL_FORMATS = [...IMAGE_FORMATS, ...TEXT_FORMATS, ...PDF_FORMATS];

  const isImageFile = type => IMAGE_FORMATS.includes(type);
  const isTextFile = type => TEXT_FORMATS.includes(type);
  const isPdfFile = type => PDF_FORMATS.includes(type);

  const getFileTypeDisplay = mimeType => {
    // Image types
    if (isImageFile(mimeType)) {
      return mimeType.replace('image/', '').toUpperCase();
    }

    // Text/document types
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

  const processImage = file => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const previewUrl = URL.createObjectURL(file);

          // If resizing is disabled, return original image data
          if (!RESIZE_IMAGES) {
            return resolve({
              preview: { type: 'image', url: previewUrl },
              data: {
                type: 'image',
                base64: e.target.result,
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type,
                width: img.width,
                height: img.height
              }
            });
          }

          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height && width > MAX_DIMENSION) {
            height = Math.round((height * MAX_DIMENSION) / width);
            width = MAX_DIMENSION;
          } else if (height > MAX_DIMENSION) {
            width = Math.round((width * MAX_DIMENSION) / height);
            height = MAX_DIMENSION;
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const base64 = canvas.toDataURL('image/jpeg', 0.8);

          resolve({
            preview: { type: 'image', url: previewUrl },
            data: {
              type: 'image',
              base64,
              fileName: file.name,
              fileSize: file.size,
              fileType: 'image/jpeg',
              width,
              height
            }
          });
        };
        img.onerror = () => reject(new Error('invalid-image'));
        img.src = e.target.result;
      };

      reader.onerror = () => reject(new Error('read-error'));
      reader.readAsDataURL(file);
    });
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
    // Check if image files are disabled
    if (!isImageUploadEnabled && IMAGE_FORMATS.some(format => format === file.type)) {
      throw new Error('image-upload-disabled');
    }

    // Check if file upload is disabled
    if (
      !isFileUploadEnabled &&
      (TEXT_FORMATS.some(format => format === file.type) ||
        PDF_FORMATS.some(format => format === file.type))
    ) {
      throw new Error('file-upload-disabled');
    }

    // Handle image files
    if (isImageFile(file.type)) {
      return await processImage(file);
    }

    // Handle text/document files
    let content = '';
    let processedContent = '';

    if (isPdfFile(file.type)) {
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      processedContent = await pdf2md(uint8Array);
      content = processedContent;
    } else if (isTextFile(file.type)) {
      content = await readTextFile(file);
      processedContent = content;
    }

    const previewContent = content.length > 200 ? content.substring(0, 200) + '...' : content;

    return {
      preview: {
        type: 'document',
        fileName: file.name,
        fileType: getFileTypeDisplay(file.type),
        content: previewContent
      },
      data: {
        type: 'document',
        content: processedContent,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        displayType: getFileTypeDisplay(file.type)
      }
    };
  };

  const formatList = (() => {
    const imageFormats = IMAGE_FORMATS.map(format => format.replace('image/', '').toUpperCase());
    const textFormats = TEXT_FORMATS.map(format => {
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
        default:
          return format;
      }
    });
    const pdfFormats = PDF_FORMATS.map(f => (f === 'application/pdf' ? 'PDF' : f));
    return [...new Set([...imageFormats, ...textFormats, ...pdfFormats])].join(', ');
  })();

  const getErrorMessage = code => {
    switch (code) {
      case 'file-too-large':
        return t('errors.fileTooLarge', {
          maxSize: MAX_FILE_SIZE_MB,
          defaultValue: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`
        });
      case 'unsupported-format':
        return t('errors.unsupportedFormat', {
          formats: formatList,
          defaultValue: `Unsupported file format. Please use: ${formatList}`
        });
      case 'invalid-image':
        return t('errors.invalidImage', 'Invalid image file');
      case 'read-error':
        return t('errors.readError', 'Error reading file');
      case 'image-upload-disabled':
        return t(
          'errors.imageUploadDisabled',
          'Image upload is not supported by the selected model. Please choose a different model or upload a text file instead.'
        );
      case 'file-upload-disabled':
        return t('errors.fileUploadDisabled', 'File upload is disabled for this application.');
      default:
        return t('errors.fileProcessingError', 'Error processing file. Please try again.');
    }
  };

  return (
    <Uploader
      accept={ALL_FORMATS}
      maxSizeMB={MAX_FILE_SIZE_MB}
      disabled={disabled}
      onSelect={onFileSelect}
      onProcessFile={processFile}
      data={fileData}
    >
      {({ preview, error, isProcessing, handleButtonClick, handleClear, inputProps }) => (
        <div className="unified-uploader">
          <input {...inputProps} />
          {preview ? (
            <div className="relative mt-2 mb-4">
              {preview.type === 'image' ? (
                // Image preview
                <div className="relative rounded-lg overflow-hidden border border-gray-300">
                  <img
                    src={preview.url}
                    alt={t('common.preview', 'Preview')}
                    className="max-w-full max-h-60 mx-auto"
                  />
                  <button
                    type="button"
                    onClick={handleClear}
                    className="absolute top-2 right-2 bg-gray-800 bg-opacity-70 text-white rounded-full p-1 hover:bg-opacity-90"
                    title={t('common.remove', 'Remove file')}
                  >
                    <Icon name="x" className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                // Document preview
                <div className="relative rounded-lg overflow-hidden border border-gray-300 p-3 bg-gray-50">
                  <div className="flex items-start gap-3">
                    <Icon
                      name="document-text"
                      className="w-8 h-8 text-blue-500 flex-shrink-0 mt-1"
                    />
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
              )}
              <div className="text-xs text-gray-500 mt-1 text-center">
                {preview.type === 'image'
                  ? t('components.uploader.imageSelected', 'Image selected')
                  : t('components.uploader.fileSelected', 'File selected and processed')}
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
                    <span>{t('components.uploader.processing', 'Processing file...')}</span>
                  </>
                ) : (
                  <>
                    <Icon name="paper-clip" className="mr-2" />
                    <span>{t('components.uploader.uploadFile', 'Upload File')}</span>
                  </>
                )}
              </button>

              {error && <div className="text-red-500 text-sm mt-1">{getErrorMessage(error)}</div>}

              <div className="text-xs text-gray-500 mt-1 text-center">
                {t(
                  'components.uploader.supportedFormats',
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

export default UnifiedUploader;
