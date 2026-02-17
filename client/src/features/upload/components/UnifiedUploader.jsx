import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Uploader from './Uploader';
import '../components/ImageUpload.css';
import {
  SUPPORTED_TEXT_FORMATS,
  getFileTypeDisplay as getFileTypeDisplayUtil,
  formatMimeTypesToDisplay,
  processDocumentFile,
  formatAcceptAttribute,
  processTiffFile
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

  // Audio upload configuration
  const audioConfig = config.audioUpload || {};
  const isAudioUploadEnabled = audioConfig.enabled !== false && config.audioUploadEnabled !== false;

  // File upload configuration
  const fileConfig = config.fileUpload || {};
  const isFileUploadEnabled = fileConfig.enabled !== false && config.fileUploadEnabled !== false;

  // Multiple file upload configuration - read from top-level upload config
  const allowMultiple = config.allowMultiple || false;

  // Configuration with defaults
  const MAX_FILE_SIZE_MB =
    config.maxFileSizeMB ||
    Math.max(
      imageConfig.maxFileSizeMB || 0,
      audioConfig.maxFileSizeMB || 0,
      fileConfig.maxFileSizeMB || 0
    ) ||
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

  // Audio-specific configuration
  const AUDIO_FORMATS = isAudioUploadEnabled
    ? audioConfig.supportedFormats ||
      config.supportedAudioFormats || [
        'audio/mpeg',
        'audio/mp3',
        'audio/wav',
        'audio/flac',
        'audio/ogg'
      ]
    : [];

  // File-specific configuration
  const TEXT_FORMATS = isFileUploadEnabled
    ? fileConfig.supportedFormats || config.supportedFormats || SUPPORTED_TEXT_FORMATS
    : [];

  // All supported formats combined - include both MIME types and file extensions for better OS compatibility
  const ALL_FORMATS = formatAcceptAttribute([...IMAGE_FORMATS, ...AUDIO_FORMATS, ...TEXT_FORMATS]);

  const isImageFile = type => IMAGE_FORMATS.includes(type);
  const isAudioFile = type => AUDIO_FORMATS.includes(type);

  const getFileTypeDisplay = mimeType => {
    // Image types
    if (isImageFile(mimeType)) {
      return mimeType.replace('image/', '').toUpperCase();
    }

    // Audio types
    if (isAudioFile(mimeType)) {
      return mimeType.replace('audio/', '').toUpperCase();
    }

    // Use shared utility for document types
    return getFileTypeDisplayUtil(mimeType);
  };

  const processImage = async file => {
    // Check if this is a TIFF file
    const isTiff = file.type === 'image/tiff' || file.type === 'image/tif';

    if (isTiff) {
      try {
        // Process TIFF file and convert to PNG
        const pages = await processTiffFile(file, {
          maxDimension: MAX_DIMENSION,
          resize: RESIZE_IMAGES
        });

        // For multipage TIFFs, return all pages as separate images
        if (pages.length > 1 && allowMultiple) {
          // Return array of page results for multipage TIFF
          const pageResults = [];

          for (let i = 0; i < pages.length; i++) {
            const page = pages[i];

            // Create blob URL for preview
            const response = await fetch(page.base64);
            const blob = await response.blob();
            const previewUrl = URL.createObjectURL(blob);

            // Generate filename with page number
            const baseFileName = file.name.replace(/\.tiff?$/i, '');
            const fileName = `${baseFileName}_page${page.pageNumber}.png`;

            pageResults.push({
              preview: { type: 'image', url: previewUrl },
              data: {
                type: 'image',
                base64: page.base64,
                fileName: fileName,
                fileSize: blob.size,
                fileType: 'image/png', // Converted to PNG
                width: page.width,
                height: page.height,
                originalFileType: file.type,
                originalFileName: file.name,
                pageNumber: page.pageNumber,
                totalPages: page.totalPages
              }
            });
          }

          // Return special structure to indicate multiple results from single file
          return { multipleResults: pageResults };
        }

        // For single-page TIFF or when allowMultiple is false, use first page only
        const firstPage = pages[0];

        // Create blob URL for preview
        const response = await fetch(firstPage.base64);
        const blob = await response.blob();
        const previewUrl = URL.createObjectURL(blob);

        return {
          preview: { type: 'image', url: previewUrl },
          data: {
            type: 'image',
            base64: firstPage.base64,
            fileName: file.name.replace(/\.tiff?$/i, '.png'), // Change extension to PNG
            fileSize: blob.size,
            fileType: 'image/png', // Converted to PNG
            width: firstPage.width,
            height: firstPage.height,
            originalFileType: file.type,
            originalFileName: file.name,
            tiffPages: pages.length > 1 ? pages : undefined // Include all pages if multipage
          }
        };
      } catch (error) {
        console.error('Error processing TIFF file:', error);
        throw new Error('tiff-processing-error');
      }
    }

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

  const processAudio = file => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = e => {
        // For audio files, we just need to read the base64 data
        // No processing or resizing is needed
        resolve({
          preview: {
            type: 'audio',
            fileName: file.name,
            fileType: getFileTypeDisplay(file.type),
            fileSize: file.size
          },
          data: {
            type: 'audio',
            base64: e.target.result,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type
          }
        });
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

    // Check if audio files are disabled
    if (!isAudioUploadEnabled && AUDIO_FORMATS.some(format => format === file.type)) {
      throw new Error('audio-upload-disabled');
    }

    // Check if file upload is disabled
    if (!isFileUploadEnabled && TEXT_FORMATS.some(format => format === file.type)) {
      throw new Error('file-upload-disabled');
    }

    // Handle image files
    if (isImageFile(file.type)) {
      return await processImage(file);
    }

    // Handle audio files
    if (isAudioFile(file.type)) {
      return await processAudio(file);
    }

    // Handle text/document files using shared utility
    const { content: processedContent, pageImages } = await processDocumentFile(file);
    const displayContent = processedContent || '';
    const previewContent =
      displayContent.length > 200 ? displayContent.substring(0, 200) + '...' : displayContent;

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
        pageImages,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        displayType: getFileTypeDisplay(file.type)
      }
    };
  };

  const formatList = (() => {
    const imageFormats = IMAGE_FORMATS.map(format => format.replace('image/', '').toUpperCase());
    const audioFormats = AUDIO_FORMATS.map(format => format.replace('audio/', '').toUpperCase());
    const textFormatsDisplay = formatMimeTypesToDisplay(TEXT_FORMATS);
    const allFormats = [
      ...imageFormats,
      ...audioFormats,
      textFormatsDisplay.length > 0 ? textFormatsDisplay : null
    ]
      .filter(Boolean)
      .join(', ');
    return allFormats;
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
      case 'tiff-processing-error':
        return t(
          'errors.tiffProcessingError',
          'Error processing TIFF file. The file may be corrupted or in an unsupported TIFF format.'
        );
      case 'read-error':
        return t('errors.readError', 'Error reading file');
      case 'image-upload-disabled':
        return t(
          'errors.imageUploadDisabled',
          'Image upload is not supported by the selected model. Please choose a different model or upload a text file instead.'
        );
      case 'audio-upload-disabled':
        return t(
          'errors.audioUploadDisabled',
          'Audio upload is not supported by the selected model. Please choose a different model.'
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
        handleRemoveItem,
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
                // Multiple files preview - horizontal scrolling grid
                <div className="space-y-2">
                  <div className="overflow-x-auto overflow-y-hidden">
                    <div className="flex gap-2 pb-2" style={{ minHeight: '180px' }}>
                      {preview.map((item, index) => (
                        <div
                          key={index}
                          className="flex-shrink-0 relative group"
                          style={{ width: '160px' }}
                        >
                          {item.type === 'image' ? (
                            // Image preview in grid
                            <div className="relative rounded-lg overflow-hidden border border-gray-300 bg-white h-40 flex items-center justify-center">
                              <img
                                src={item.url}
                                alt={t('common.preview', 'Preview')}
                                className="max-w-full max-h-full object-contain"
                              />
                              <button
                                type="button"
                                onClick={() => handleRemoveItem(index)}
                                className="absolute top-1 right-1 bg-red-600 bg-opacity-90 text-white rounded-full p-1 hover:bg-red-700 opacity-0 group-hover:opacity-100 transition-opacity"
                                title={t('common.remove', 'Remove')}
                              >
                                <Icon name="x" className="w-3 h-3" />
                              </button>
                            </div>
                          ) : item.type === 'audio' ? (
                            // Audio preview in grid
                            <div className="relative rounded-lg overflow-hidden border border-gray-300 p-2 bg-gray-50 h-40 flex flex-col justify-center">
                              <Icon
                                name="musical-note"
                                className="w-8 h-8 text-purple-500 mx-auto mb-2"
                              />
                              <div className="text-xs text-gray-900 truncate text-center px-1">
                                {item.fileName}
                              </div>
                              <div className="text-xs text-gray-500 truncate text-center">
                                {item.fileType}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRemoveItem(index)}
                                className="absolute top-1 right-1 bg-red-600 bg-opacity-90 text-white rounded-full p-1 hover:bg-red-700 opacity-0 group-hover:opacity-100 transition-opacity"
                                title={t('common.remove', 'Remove')}
                              >
                                <Icon name="x" className="w-3 h-3" />
                              </button>
                            </div>
                          ) : (
                            // Document preview in grid
                            <div className="relative rounded-lg overflow-hidden border border-gray-300 p-2 bg-gray-50 h-40 flex flex-col justify-center">
                              <Icon
                                name="document-text"
                                className="w-8 h-8 text-blue-500 mx-auto mb-2"
                              />
                              <div className="text-xs text-gray-900 truncate text-center px-1">
                                {item.fileName}
                              </div>
                              <div className="text-xs text-gray-500 truncate text-center">
                                {item.fileType}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRemoveItem(index)}
                                className="absolute top-1 right-1 bg-red-600 bg-opacity-90 text-white rounded-full p-1 hover:bg-red-700 opacity-0 group-hover:opacity-100 transition-opacity"
                                title={t('common.remove', 'Remove')}
                              >
                                <Icon name="x" className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <div className="text-xs text-gray-500">
                      {t('components.uploader.filesSelected', '{{count}} file(s) selected', {
                        count: preview.length
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={handleClear}
                      className="px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-xs"
                      title={t('common.remove', 'Remove all files')}
                    >
                      {t('common.removeAll', 'Remove All')}
                    </button>
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
              ) : preview.type === 'audio' ? (
                // Single audio preview
                <div>
                  <div className="relative rounded-lg overflow-hidden border border-gray-300 p-3 bg-gray-50">
                    <div className="flex items-start gap-3">
                      <Icon
                        name="musical-note"
                        className="w-8 h-8 text-purple-500 flex-shrink-0 mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-gray-900 truncate">
                          {preview.fileName}
                        </div>
                        <div className="text-xs text-gray-500 mb-2">{preview.fileType}</div>
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
                    {t('components.uploader.audioSelected', 'Audio file selected')}
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
