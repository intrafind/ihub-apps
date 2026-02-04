import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Uploader from './Uploader';
import '../components/ImageUpload.css';
import {
  SUPPORTED_TEXT_FORMATS,
  getFileTypeDisplay as getFileTypeDisplayUtil,
  formatMimeTypesToDisplay,
  processDocumentFile,
  formatAcceptAttribute
} from '../utils/fileProcessing';

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

  // Multiple file upload configuration - read from top-level upload config
  const allowMultiple = config.allowMultiple || false;

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
    ? fileConfig.supportedFormats || config.supportedFormats || SUPPORTED_TEXT_FORMATS
    : [];

  // All supported formats combined - include both MIME types and file extensions for better OS compatibility
  const ALL_FORMATS = formatAcceptAttribute([...IMAGE_FORMATS, ...TEXT_FORMATS]);

  const isImageFile = type => IMAGE_FORMATS.includes(type);

  const getFileTypeDisplay = mimeType => {
    // Image types
    if (isImageFile(mimeType)) {
      return mimeType.replace('image/', '').toUpperCase();
    }

    // Use shared utility for document types
    return getFileTypeDisplayUtil(mimeType);
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

  const processFile = async file => {
    // Check if image files are disabled
    if (!isImageUploadEnabled && IMAGE_FORMATS.some(format => format === file.type)) {
      throw new Error('image-upload-disabled');
    }

    // Check if file upload is disabled
    if (!isFileUploadEnabled && TEXT_FORMATS.some(format => format === file.type)) {
      throw new Error('file-upload-disabled');
    }

    // Handle image files
    if (isImageFile(file.type)) {
      return await processImage(file);
    }

    // Handle text/document files using shared utility
    const processedContent = await processDocumentFile(file);
    const previewContent =
      processedContent.length > 200 ? processedContent.substring(0, 200) + '...' : processedContent;

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
    const textFormatsDisplay = formatMimeTypesToDisplay(TEXT_FORMATS);
    const combined =
      imageFormats.length > 0
        ? [...imageFormats, textFormatsDisplay].join(', ')
        : textFormatsDisplay;
    return combined;
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
      allowMultiple={allowMultiple}
    >
      {({
        preview,
        error,
        isProcessing,
        isDragging,
        handleButtonClick,
        handleClear,
        handleDragEnter,
        handleDragLeave,
        handleDragOver,
        handleDrop,
        inputProps
      }) => (
        <div
          className="unified-uploader"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <input {...inputProps} />
          {isDragging && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-blue-500 bg-opacity-20 pointer-events-none"
              role="alert"
              aria-live="polite"
              aria-label={t(
                'components.uploader.dropZoneActive',
                'Drop zone active. Release to upload files.'
              )}
            >
              <div className="bg-white rounded-lg shadow-2xl p-8 border-4 border-blue-500 border-dashed">
                <div className="text-center">
                  <div className="text-6xl mb-4">📎</div>
                  <p className="text-xl font-semibold text-blue-600">
                    {t('components.uploader.dropFileHere', 'Drop file here')}
                  </p>
                </div>
              </div>
            </div>
          )}
          {preview ? (
            <div className="relative mt-2 mb-4">
              {Array.isArray(preview) ? (
                // Multiple files preview
                <div className="space-y-2">
                  {preview.map((item, index) => (
                    <div key={index}>
                      {item.type === 'image' ? (
                        // Image preview
                        <div className="relative rounded-lg overflow-hidden border border-gray-300">
                          <img
                            src={item.url}
                            alt={t('common.preview', 'Preview')}
                            className="max-w-full max-h-60 mx-auto"
                          />
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
                                {item.fileName}
                              </div>
                              <div className="text-xs text-gray-500 mb-2">{item.fileType} file</div>
                              <div className="text-xs text-gray-700 bg-white p-2 rounded border max-h-20 overflow-y-auto">
                                {item.content}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={handleClear}
                    className="w-full mt-2 px-3 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
                    title={t('common.remove', 'Remove files')}
                  >
                    {t('common.removeAll', 'Remove All')}
                  </button>
                  <div className="text-xs text-gray-500 mt-1 text-center">
                    {t('components.uploader.filesSelected', '{{count}} file(s) selected', {
                      count: preview.length
                    })}
                  </div>
                </div>
              ) : preview.type === 'image' ? (
                // Single image preview
                <div>
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
                  <div className="text-xs text-gray-500 mt-1 text-center">
                    {t('components.uploader.imageSelected', 'Image selected')}
                  </div>
                </div>
              ) : (
                // Single document preview
                <div>
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
                  <div className="text-xs text-gray-500 mt-1 text-center">
                    {t('components.uploader.fileSelected', 'File selected and processed')}
                  </div>
                </div>
              )}
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
                    <span>
                      {allowMultiple
                        ? t('components.uploader.uploadFiles', 'Upload Files')
                        : t('components.uploader.uploadFile', 'Upload File')}
                    </span>
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
